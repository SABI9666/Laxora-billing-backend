import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { notFound } from "../../utils/errors";

const router = Router();

const partySchema = z.object({
  name: z.string().min(1),
  type: z.enum(["CUSTOMER", "SUPPLIER"]).default("CUSTOMER"),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  gstin: z.string().optional(),
  billingAddress: z.string().optional(),
  openingBalance: z.number().default(0),
});

// GET /api/parties?type=CUSTOMER&search=foo
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { type, search } = req.query;
    const parties = await prisma.party.findMany({
      where: {
        businessId: req.businessId!,
        ...(type ? { type: type as "CUSTOMER" | "SUPPLIER" } : {}),
        ...(search
          ? { name: { contains: String(search), mode: "insensitive" } }
          : {}),
      },
      orderBy: { name: "asc" },
    });
    res.json({ parties });
  })
);

// GET /api/parties/summary?type=CUSTOMER|SUPPLIER — every party with billed /
// paid / balance, for the shop's ledger reports. (Registered before /:id.)
router.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const businessId = req.businessId!;
    const type =
      String(req.query.type ?? "CUSTOMER").toUpperCase() === "SUPPLIER"
        ? "SUPPLIER"
        : "CUSTOMER";
    const invoiceType = type === "CUSTOMER" ? "SALE" : "PURCHASE";
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

    const [parties, invAgg, payAgg, cnAgg] = await Promise.all([
      prisma.party.findMany({
        where: { businessId, type: type as never },
        orderBy: { name: "asc" },
      }),
      prisma.invoice.groupBy({
        by: ["partyId"],
        where: { businessId, type: invoiceType as never },
        _sum: { total: true },
      }),
      prisma.payment.groupBy({
        by: ["partyId"],
        where: { businessId },
        _sum: { amount: true },
      }),
      prisma.creditNote.groupBy({
        by: ["partyId"],
        where: { businessId },
        _sum: { totalAmount: true },
      }),
    ]);

    const invMap = new Map(invAgg.map((r) => [r.partyId, Number(r._sum.total ?? 0)]));
    const payMap = new Map(payAgg.map((r) => [r.partyId, Number(r._sum.amount ?? 0)]));
    const cnMap = new Map(cnAgg.map((r) => [r.partyId, Number(r._sum.totalAmount ?? 0)]));

    const rows = parties.map((p) => {
      const billed = invMap.get(p.id) ?? 0;
      const paid = payMap.get(p.id) ?? 0;
      const returns = cnMap.get(p.id) ?? 0;
      return {
        id: p.id,
        name: p.name,
        phone: p.phone,
        gstin: p.gstin,
        billed: round2(billed),
        paid: round2(paid),
        balance: round2(Number(p.openingBalance) + billed - paid - returns),
      };
    });
    res.json({ type, parties: rows });
  })
);

// GET /api/parties/:id
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const party = await prisma.party.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!party) throw notFound("Party not found");
    res.json({ party });
  })
);

// GET /api/parties/:id/ledger — statement of account for this party (scoped to
// the active shop): bills add to what's owed, payments & returns reduce it.
router.get(
  "/:id/ledger",
  asyncHandler(async (req, res) => {
    const businessId = req.businessId!;
    const party = await prisma.party.findFirst({
      where: { id: req.params.id, businessId },
    });
    if (!party) throw notFound("Party not found");
    const invoiceType = party.type === "CUSTOMER" ? "SALE" : "PURCHASE";

    const [invoices, payments, creditNotes] = await Promise.all([
      prisma.invoice.findMany({
        where: { partyId: party.id, businessId, type: invoiceType as never },
        select: { invoiceNumber: true, invoiceDate: true, total: true },
      }),
      prisma.payment.findMany({
        where: { partyId: party.id, businessId },
        select: { paymentDate: true, amount: true, method: true },
      }),
      prisma.creditNote.findMany({
        where: { partyId: party.id, businessId },
        select: { date: true, totalAmount: true, invoiceNumber: true },
      }),
    ]);

    type Entry = { date: Date; kind: string; ref: string; debit: number; credit: number };
    const entries: Entry[] = [];
    for (const inv of invoices)
      entries.push({
        date: inv.invoiceDate,
        kind: invoiceType === "SALE" ? "Sale Invoice" : "Purchase Invoice",
        ref: inv.invoiceNumber,
        debit: Number(inv.total),
        credit: 0,
      });
    for (const p of payments)
      entries.push({
        date: p.paymentDate,
        kind: `Payment (${p.method})`,
        ref: "",
        debit: 0,
        credit: Number(p.amount),
      });
    for (const cn of creditNotes)
      entries.push({
        date: cn.date,
        kind: "Sales Return",
        ref: cn.invoiceNumber ?? "",
        debit: 0,
        credit: Number(cn.totalAmount),
      });
    entries.sort((a, b) => a.date.getTime() - b.date.getTime());

    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    let balance = Number(party.openingBalance);
    const ledger = entries.map((e) => {
      balance += e.debit - e.credit;
      return {
        date: e.date,
        kind: e.kind,
        ref: e.ref,
        debit: round2(e.debit),
        credit: round2(e.credit),
        balance: round2(balance),
      };
    });

    res.json({
      party: {
        id: party.id,
        name: party.name,
        type: party.type,
        phone: party.phone,
        gstin: party.gstin,
        billingAddress: party.billingAddress,
        openingBalance: round2(Number(party.openingBalance)),
      },
      closingBalance: round2(balance),
      ledger,
    });
  })
);

// POST /api/parties
router.post(
  "/",
  validateBody(partySchema),
  asyncHandler(async (req, res) => {
    const party = await prisma.party.create({
      data: { ...req.body, businessId: req.businessId! },
    });
    res.status(201).json({ party });
  })
);

// PUT /api/parties/:id
router.put(
  "/:id",
  validateBody(partySchema.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.party.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!existing) throw notFound("Party not found");
    const party = await prisma.party.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json({ party });
  })
);

// DELETE /api/parties/:id
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = await prisma.party.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!existing) throw notFound("Party not found");
    await prisma.party.delete({ where: { id: req.params.id } });
    res.status(204).send();
  })
);

export default router;
