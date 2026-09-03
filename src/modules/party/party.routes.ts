import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { buildPartyLedger } from "../../lib/ledger";
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
  // When true, create even if a same-name party already exists (the user
  // confirmed it's a genuinely different person).
  force: z.boolean().optional(),
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

    const [parties, invAgg, payAgg, cnAgg, chargeRows] = await Promise.all([
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
        by: ["partyId", "direction"],
        where: { businessId },
        _sum: { amount: true },
      }),
      prisma.creditNote.groupBy({
        by: ["partyId"],
        where: { businessId },
        _sum: { totalAmount: true },
      }),
      // Which bills carry linked charges (Expense has no invoice relation, so
      // we resolve the party through the invoice below).
      prisma.expense.findMany({
        where: { businessId, invoiceId: { not: null } },
        select: { invoiceId: true },
      }),
    ]);

    // A bill-linked charge settles the bill's due, so it counts as "paid" for
    // that party — but only for the amount that actually cleared the bill.
    // amountPaid is already capped at the bill total, so (amountPaid − payments
    // on that bill) is exactly the settling portion of the charges, never more
    // than the outstanding. This keeps a charge on a fully-paid bill from
    // handing the customer a phantom credit.
    const chargedIds = [...new Set(chargeRows.map((e) => e.invoiceId!))];
    const adjMap = new Map<string, number>();
    if (chargedIds.length) {
      const [chargedInvoices, linkedPayAgg] = await Promise.all([
        prisma.invoice.findMany({
          where: { id: { in: chargedIds }, businessId, type: invoiceType as never },
          select: { id: true, partyId: true, amountPaid: true },
        }),
        prisma.payment.groupBy({
          by: ["invoiceId"],
          where: { invoiceId: { in: chargedIds } },
          _sum: { amount: true },
        }),
      ]);
      const linkedPayMap = new Map(
        linkedPayAgg.map((r) => [r.invoiceId, Number(r._sum.amount ?? 0)])
      );
      for (const inv of chargedInvoices) {
        const settled = Number(inv.amountPaid) - (linkedPayMap.get(inv.id) ?? 0);
        if (settled <= 0) continue;
        adjMap.set(inv.partyId, (adjMap.get(inv.partyId) ?? 0) + settled);
      }
    }

    // Split payments by direction so refunds (opposite direction) don't count as
    // money received. Customers pay IN; supplier payments go OUT.
    const reduceDir = type === "CUSTOMER" ? "IN" : "OUT";
    const invMap = new Map(invAgg.map((r) => [r.partyId, Number(r._sum.total ?? 0)]));
    const payMap = new Map<string | null, number>();
    const refundMap = new Map<string | null, number>();
    for (const r of payAgg) {
      const map = r.direction === reduceDir ? payMap : refundMap;
      map.set(r.partyId, (map.get(r.partyId) ?? 0) + Number(r._sum.amount ?? 0));
    }
    const cnMap = new Map(cnAgg.map((r) => [r.partyId, Number(r._sum.totalAmount ?? 0)]));

    const rows = parties.map((p) => {
      const billed = invMap.get(p.id) ?? 0;
      const paid = (payMap.get(p.id) ?? 0) + (adjMap.get(p.id) ?? 0);
      const refunded = refundMap.get(p.id) ?? 0;
      const returns = cnMap.get(p.id) ?? 0;
      return {
        id: p.id,
        name: p.name,
        phone: p.phone,
        gstin: p.gstin,
        billed: round2(billed),
        paid: round2(paid),
        // Refunds (money paid back) add to what's owed again, so they're added.
        balance: round2(Number(p.openingBalance) + billed - paid - returns + refunded),
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

    const { ledger, totals, closingBalance } = await buildPartyLedger(prisma, party);
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

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
      closingBalance,
      totals,
      ledger,
    });
  })
);

// POST /api/parties
router.post(
  "/",
  validateBody(partySchema),
  asyncHandler(async (req, res) => {
    const { force, ...data } = req.body as z.infer<typeof partySchema>;

    // Prevent duplicate names within a shop (per type). If one exists and the
    // caller hasn't confirmed, return it so the UI can ask "is it this one?".
    if (!force) {
      const existing = await prisma.party.findFirst({
        where: {
          businessId: req.businessId!,
          type: data.type,
          name: { equals: data.name.trim(), mode: "insensitive" },
        },
      });
      if (existing) {
        return res.status(409).json({
          error: `A ${data.type.toLowerCase()} named "${existing.name}" already exists.`,
          details: { duplicate: true, existing },
        });
      }
    }

    const party = await prisma.party.create({
      data: { ...data, name: data.name.trim(), businessId: req.businessId! },
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
