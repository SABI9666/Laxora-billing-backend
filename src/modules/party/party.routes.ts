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
    const invoiceType = party.type === "CUSTOMER" ? "SALE" : "PURCHASE";

    const [invoices, payments, creditNotes] = await Promise.all([
      prisma.invoice.findMany({
        where: { partyId: party.id, businessId, type: invoiceType as never },
        select: { id: true, invoiceNumber: true, invoiceDate: true, total: true, amountPaid: true },
      }),
      prisma.payment.findMany({
        where: { partyId: party.id, businessId },
        select: { paymentDate: true, amount: true, method: true, invoiceId: true, direction: true },
      }),
      prisma.creditNote.findMany({
        where: { partyId: party.id, businessId },
        select: { date: true, totalAmount: true, invoiceNumber: true },
      }),
    ]);

    // A payment in the party's usual direction (customer pays IN, we pay a
    // supplier OUT) reduces what's owed; an opposite-direction payment is a
    // refund (money going the other way).
    const reduceDir = party.type === "CUSTOMER" ? "IN" : "OUT";

    // Bill-linked charges (commission, damage, …) settle part of the bill, so
    // they show as credits in the statement just like payments do — each named
    // by its own category (Commission, Transport, …). We only credit the
    // portion that actually cleared the bill: amountPaid is capped at the bill
    // total, so (amountPaid − payments on that bill) is the total settling
    // charges, never more than the outstanding. When several charges share a
    // bill we allocate that budget across them in date order.
    const billCharges = invoices.length
      ? await prisma.expense.findMany({
          where: { businessId, invoiceId: { in: invoices.map((i) => i.id) } },
          select: {
            invoiceId: true,
            date: true,
            amount: true,
            category: true,
            note: true,
            method: true,
          },
        })
      : [];
    type Charge = {
      date: Date;
      amount: number;
      category: string;
      note: string | null;
      method: string | null;
    };
    const chargesByInv = new Map<string, Charge[]>();
    for (const x of billCharges) {
      const arr = chargesByInv.get(x.invoiceId!) ?? [];
      arr.push({
        date: x.date,
        amount: Number(x.amount),
        category: x.category,
        note: x.note,
        method: x.method,
      });
      chargesByInv.set(x.invoiceId!, arr);
    }
    const linkedPaid = new Map<string, number>();
    for (const p of payments)
      if (p.invoiceId && p.direction === reduceDir)
        linkedPaid.set(p.invoiceId, (linkedPaid.get(p.invoiceId) ?? 0) + Number(p.amount));

    type Entry = {
      date: Date;
      kind: string;
      ref: string;
      // Free-text detail for the line (a charge's note and how it was settled).
      note?: string;
      debit: number;
      credit: number;
    };
    const entries: Entry[] = [];
    for (const inv of invoices)
      entries.push({
        date: inv.invoiceDate,
        kind: invoiceType === "SALE" ? "Sale Invoice" : "Purchase Invoice",
        ref: inv.invoiceNumber,
        debit: Number(inv.total),
        credit: 0,
      });
    // Show which bill a linked voucher settled, so a lump sum split across
    // several bills reads as such on the statement.
    const billNo = new Map(invoices.map((i) => [i.id, i.invoiceNumber]));
    for (const p of payments) {
      const reduces = p.direction === reduceDir;
      entries.push({
        date: p.paymentDate,
        kind: reduces ? `Payment (${p.method})` : `Refund (${p.method})`,
        ref: (p.invoiceId && billNo.get(p.invoiceId)) || "",
        debit: reduces ? 0 : Number(p.amount),
        credit: reduces ? Number(p.amount) : 0,
      });
    }
    for (const cn of creditNotes)
      entries.push({
        date: cn.date,
        kind: "Sales Return",
        ref: cn.invoiceNumber ?? "",
        debit: 0,
        credit: Number(cn.totalAmount),
      });
    // Every bill-linked charge (commission, electrician, transport, …) gets its
    // own line, named by its category and carrying its note, so the statement
    // tells the whole story of that bill. The CREDIT is only the portion that
    // actually cleared the bill: amountPaid is capped at the bill total, so
    // (amountPaid − payments on that bill) is the settling budget, allocated
    // across the bill's charges in date order. A charge on a bill the customer
    // has already paid in full settles nothing — it is the shop's own cost —
    // so it still appears, as a memo line with no amount in the columns and
    // the explanation in the note. Previously such charges were dropped
    // entirely, leaving no trace of, say, an electrician commission on the
    // very statement where the accountant looks for it.
    const inr = (n: number) =>
      "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const r2c = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    for (const inv of invoices) {
      const charges = chargesByInv.get(inv.id);
      if (!charges) continue;
      let budget = Math.max(0, Number(inv.amountPaid) - (linkedPaid.get(inv.id) ?? 0));
      for (const c of [...charges].sort((a, b) => a.date.getTime() - b.date.getTime())) {
        const settled = r2c(Math.min(c.amount, budget));
        budget = r2c(budget - settled);
        const unsettled = r2c(c.amount - settled);
        const how = c.method
          ? `paid out via ${c.method.toLowerCase()}`
          : "adjusted against the bill, no cash paid";
        const bits: string[] = [];
        if (c.note) bits.push(c.note);
        bits.push(how);
        if (unsettled > 0.009) {
          bits.push(
            settled > 0.009
              ? `${inr(settled)} of ${inr(c.amount)} adjusted against the bill; the remaining ${inr(
                  unsettled
                )} is the shop's own cost as the bill was otherwise paid`
              : `${inr(c.amount)} is the shop's own cost — the bill was already paid in full, so nothing was adjusted against it`
          );
        }
        entries.push({
          date: c.date,
          kind: c.category === "Other" ? "Other charge" : c.category,
          ref: inv.invoiceNumber,
          note: bits.join(" · "),
          debit: 0,
          credit: settled,
        });
      }
    }
    entries.sort((a, b) => a.date.getTime() - b.date.getTime());

    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    let balance = Number(party.openingBalance);
    const ledger = entries.map((e) => {
      balance += e.debit - e.credit;
      return {
        date: e.date,
        kind: e.kind,
        ref: e.ref,
        note: e.note ?? "",
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
