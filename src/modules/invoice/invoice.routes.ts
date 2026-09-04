import { Router } from "express";
import { z } from "zod";
import { Prisma, StockMovementType, PaymentDirection, PaymentMethod } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, notFound } from "../../utils/errors";
import { requireRole, BILLING_ROLES } from "../../middleware/roles";
import { recordStockMovement } from "../../lib/stock";
import {
  applyPartyAdvances,
  recomputeInvoiceSettlement,
  refundedByInvoice,
} from "../../lib/settlement";
import { deleteInvoiceWithReversal, reverseReturn } from "../../lib/invoiceOps";

const router = Router();

const lineSchema = z.object({
  itemId: z.string().optional(),
  description: z.string().min(1),
  quantity: z.number().positive(),
  rate: z.number().nonnegative(),
  taxRate: z.number().min(0).max(100).default(0),
});

const invoiceSchema = z.object({
  partyId: z.string().min(1),
  type: z.enum(["SALE", "PURCHASE"]).default("SALE"),
  invoiceDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
  discount: z.number().nonnegative().default(0),
  notes: z.string().optional(),
  // Estimate/quotation number this bill was raised from (free text).
  estimateNo: z.string().max(40).optional().nullable(),
  // Uploaded bill document (supplier purchase bill), image or PDF URL.
  attachmentUrl: z.string().optional().nullable(),
  attachmentUrl2: z.string().optional().nullable(),
  attachmentUrl3: z.string().optional().nullable(),
  // When true, each line's rate is treated as GST-inclusive: the tax is split
  // out so the stored rate/amount are ex-GST and the total equals the entered
  // (gross) price.
  taxInclusive: z.boolean().default(false),
  items: z.array(lineSchema).min(1),
});

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// GET /api/invoices?type=SALE&partyId=&status=&channel=ONLINE
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { type, partyId, status, channel } = req.query;
    const invoices = await prisma.invoice.findMany({
      where: {
        businessId: req.businessId!,
        ...(type ? { type: type as "SALE" | "PURCHASE" } : {}),
        ...(partyId ? { partyId: String(partyId) } : {}),
        ...(status ? { status: status as never } : {}),
        ...(channel ? { channel: channel as "POS" | "ONLINE" } : {}),
      },
      include: { party: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: "desc" },
    });

    // Per-bill profit for SALE invoices: ex-GST net revenue (subtotal −
    // discount) minus ex-GST cost of goods (purchase price is GST-inclusive).
    const saleIds = invoices.filter((i) => i.type === "SALE").map((i) => i.id);
    const profitMap = new Map<string, number>();

    // Value returned against each bill. `amountPaid` only counts money the
    // customer actually paid, so a return (or the return half of an exchange)
    // has to be subtracted separately to get the real pending amount — the
    // same way the dashboard and the admin cash book already do it.
    const returnedMap = new Map<string, number>();
    if (saleIds.length) {
      const cnRows = await prisma.creditNote.groupBy({
        by: ["invoiceId"],
        where: { businessId: req.businessId!, invoiceId: { in: saleIds } },
        _sum: { totalAmount: true },
      });
      for (const r of cnRows)
        if (r.invoiceId) returnedMap.set(r.invoiceId, Number(r._sum.totalAmount ?? 0));
    }
    // Money paid back on each bill (cash refunded on a return) is owed again,
    // so the pending figure has to add it back — same as the dashboard and
    // the admin reports.
    const [saleRefunds, purchaseRefunds] = await Promise.all([
      refundedByInvoice(prisma, req.businessId!, saleIds, "SALE"),
      refundedByInvoice(
        prisma,
        req.businessId!,
        invoices.filter((i) => i.type === "PURCHASE").map((i) => i.id),
        "PURCHASE"
      ),
    ]);

    // Profit is a nice-to-have: never let a problem computing it (bad data,
    // a divide-by-zero tax rate, etc.) crash the whole invoice list.
    if (saleIds.length) {
      try {
        const cogsRows = await prisma.$queryRaw<Array<{ invoiceid: string; cogs: number }>>(
          Prisma.sql`
            SELECT ii."invoiceId" AS invoiceid,
                   COALESCE(SUM(ii.quantity * i."purchasePrice" / NULLIF(1 + i."taxRate" / 100, 0)), 0)::float AS cogs
            FROM "InvoiceItem" ii
            JOIN "Item" i ON i.id = ii."itemId"
            WHERE ii."invoiceId" IN (${Prisma.join(saleIds)})
            GROUP BY 1
          `
        );
        const cogsMap = new Map(cogsRows.map((r) => [r.invoiceid, Number(r.cogs)]));

        // Charges booked against a bill (commission, electrician, damage, …)
        // are real costs on that sale, so they cut into its profit.
        const expenseRows = await prisma.expense.groupBy({
          by: ["invoiceId"],
          where: { businessId: req.businessId!, invoiceId: { in: saleIds } },
          _sum: { amount: true },
        });
        const expenseMap = new Map(
          expenseRows.map((r) => [r.invoiceId, Number(r._sum.amount ?? 0)])
        );

        // Sales returns (credit notes) reverse both the revenue and the cost
        // of the returned goods — same formula as the P&L report, so the
        // profit shown on the list matches everywhere else.
        const returnRows = await prisma.creditNote.groupBy({
          by: ["invoiceId"],
          where: { businessId: req.businessId!, invoiceId: { in: saleIds } },
          _sum: { netAmount: true, cogs: true },
        });
        const returnMap = new Map(
          returnRows.map((r) => [
            r.invoiceId,
            { net: Number(r._sum.netAmount ?? 0), cogs: Number(r._sum.cogs ?? 0) },
          ])
        );

        for (const inv of invoices) {
          if (inv.type !== "SALE") continue;
          const ret = returnMap.get(inv.id) ?? { net: 0, cogs: 0 };
          const profit =
            Number(inv.subtotal) -
            Number(inv.discount) -
            ret.net -
            ((cogsMap.get(inv.id) ?? 0) - ret.cogs) -
            (expenseMap.get(inv.id) ?? 0);
          profitMap.set(inv.id, Math.round((profit + Number.EPSILON) * 100) / 100);
        }
      } catch (err) {
        console.error("invoice profit calc failed (list still returned):", err);
      }
    }

    res.json({
      invoices: invoices.map((inv) => ({
        ...inv,
        profit: profitMap.get(inv.id) ?? null,
        returnedAmount: round2(returnedMap.get(inv.id) ?? 0),
        refundedAmount: round2(
          (inv.type === "SALE" ? saleRefunds : purchaseRefunds).get(inv.id) ?? 0
        ),
      })),
    });
  })
);

// GET /api/invoices/:id — full invoice with line items and payments.
// Full bill for viewing / printing / sharing: lines with product HSN and
// unit, party, every payment on it, and each return with its goods named.
export async function loadInvoiceDetail(businessId: string, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, businessId },
    include: {
      // Include the linked product's HSN and unit for the tax-invoice print.
      items: { include: { item: { select: { hsn: true, unit: true, sku: true } } } },
      party: true,
      payments: true,
    },
  });
  if (!invoice) return null;

  // Value already returned against this bill (see the list endpoint) so the
  // caller can show the true pending amount.
  const cn = await prisma.creditNote.aggregate({
    where: { businessId, invoiceId: invoice.id },
    _sum: { totalAmount: true },
  });

  const refunded = (await refundedByInvoice(prisma, businessId, [invoice.id], invoice.type)).get(
    invoice.id
  );

  // Every return / exchange on this bill with its goods named, so the
  // printed bill can show what came back and what replaced it.
  type RetLine = {
    invoiceItemId?: string;
    itemId?: string | null;
    quantity?: number;
    rate?: number;
    taxRate?: number;
  };
  const asLines = (v: unknown): RetLine[] => (Array.isArray(v) ? (v as RetLine[]) : []);
  const notes = await prisma.creditNote.findMany({
    where: { businessId, invoiceId: invoice.id },
    orderBy: { date: "asc" },
  });
  const lineById = new Map(invoice.items.map((it) => [it.id, it]));
  const wantNames = new Set<string>();
  for (const n of notes)
    for (const l of asLines(n.lines))
      if (!(l.invoiceItemId && lineById.has(l.invoiceItemId)) && l.itemId) wantNames.add(l.itemId);
  const named = wantNames.size
    ? await prisma.item.findMany({
        where: { id: { in: [...wantNames] } },
        select: { id: true, name: true },
      })
    : [];
  const itemName = new Map(named.map((n) => [n.id, n.name]));
  const returns = notes.map((n) => ({
    id: n.id,
    date: n.date,
    reason: n.reason,
    refundMethod: n.refundMethod,
    netAmount: Number(n.netAmount),
    taxAmount: Number(n.taxAmount),
    totalAmount: Number(n.totalAmount),
    lines: asLines(n.lines).map((l) => {
      const qty = Number(l.quantity ?? 0);
      const rate = Number(l.rate ?? 0);
      const taxRate = Number(l.taxRate ?? 0);
      return {
        description:
          (l.invoiceItemId && lineById.get(l.invoiceItemId)?.description) ||
          (l.itemId && itemName.get(l.itemId)) ||
          "Returned goods",
        quantity: qty,
        rate,
        taxRate,
        amount: round2(qty * rate),
        total: round2(qty * rate * (1 + taxRate / 100)),
      };
    }),
    // Bill lines put on by this exchange (marked on the printed bill).
    exchangeItemIds: asLines(n.exchangeLines)
      .map((l) => l.invoiceItemId)
      .filter((x): x is string => !!x),
  }));

  return {
    ...invoice,
    returnedAmount: round2(Number(cn._sum.totalAmount ?? 0)),
    refundedAmount: round2(refunded ?? 0),
    returns,
  };
}

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const invoice = await loadInvoiceDetail(req.businessId!, req.params.id);
    if (!invoice) throw notFound("Invoice not found");
    res.json({ invoice });
  })
);

// POST /api/invoices — create invoice, compute totals, adjust stock atomically.
router.post(
  "/",
  requireRole(...BILLING_ROLES),
  validateBody(invoiceSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof invoiceSchema>;
    const businessId = req.businessId!;

    // Verify party belongs to this business.
    const party = await prisma.party.findFirst({
      where: { id: body.partyId, businessId },
    });
    if (!party) throw badRequest("Invalid partyId for this business");

    // Compute line amounts and totals. If rates are GST-inclusive, split the
    // tax out so the stored rate/amount are the ex-GST (taxable) values.
    const lines = body.items.map((l) => {
      const netRate = round2(l.rate / (body.taxInclusive ? 1 + l.taxRate / 100 : 1));
      const amount = round2(l.quantity * netRate);
      return { ...l, rate: netRate, amount };
    });
    const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
    const taxAmount = round2(
      lines.reduce((s, l) => s + (l.amount * l.taxRate) / 100, 0)
    );
    const total = round2(subtotal - body.discount + taxAmount);

    const invoice = await prisma.$transaction(async (tx) => {
      // Reserve a per-business, per-type invoice number.
      const biz = await tx.business.update({
        where: { id: businessId },
        data:
          body.type === "SALE"
            ? { nextSaleNo: { increment: 1 } }
            : { nextPurchaseNo: { increment: 1 } },
      });
      const seq = body.type === "SALE" ? biz.nextSaleNo - 1 : biz.nextPurchaseNo - 1;
      // Sale invoices use the shop's configurable prefix (default "INV-");
      // purchases always use "PUR-".
      const invoiceNumber =
        body.type === "SALE"
          ? `${biz.saleInvoicePrefix ?? "INV-"}${String(seq).padStart(4, "0")}`
          : `PUR-${String(seq).padStart(4, "0")}`;

      const created = await tx.invoice.create({
        data: {
          businessId,
          partyId: body.partyId,
          invoiceNumber,
          type: body.type,
          invoiceDate: body.invoiceDate ?? new Date(),
          dueDate: body.dueDate ?? null,
          subtotal,
          discount: body.discount,
          taxAmount,
          total,
          taxInclusive: body.taxInclusive,
          notes: body.notes ?? null,
          estimateNo: body.estimateNo?.trim() || null,
          attachmentUrl: body.attachmentUrl ?? null,
          attachmentUrl2: body.attachmentUrl2 ?? null,
          attachmentUrl3: body.attachmentUrl3 ?? null,
          items: {
            create: lines.map((l) => ({
              itemId: l.itemId ?? null,
              description: l.description,
              quantity: l.quantity,
              rate: l.rate,
              taxRate: l.taxRate,
              amount: l.amount,
            })),
          },
        },
        include: { items: true, party: true },
      });

      // Adjust stock and record the movement: SALE removes stock, PURCHASE adds.
      for (const l of lines) {
        if (!l.itemId) continue;
        const isSale = body.type === "SALE";
        await recordStockMovement(tx, {
          businessId,
          itemId: l.itemId,
          type: isSale ? StockMovementType.OUT : StockMovementType.IN,
          quantity: isSale ? -l.quantity : l.quantity,
          reason: isSale ? "Sale" : "Purchase",
          reference: invoiceNumber,
          invoiceId: created.id,
          createdById: req.auth!.userId,
        });
        // On a purchase with an uploaded bill, link it on the product so the
        // supplier's bill is visible from the product too.
        if (!isSale && body.attachmentUrl) {
          await tx.item.update({
            where: { id: l.itemId },
            data: { purchaseBillUrl: body.attachmentUrl },
          });
        }
      }

      // Money this party paid ahead (a receipt with no bill to land on at the
      // time) settles the new bill immediately, so the bill and the ledger
      // agree from the moment it is raised. Re-read so the response carries
      // the settled amount/status rather than the pre-allocation row.
      const applied = await applyPartyAdvances(tx, businessId, body.partyId);
      return applied > 0
        ? tx.invoice.findUniqueOrThrow({
            where: { id: created.id },
            include: { items: true, party: true },
          })
        : created;
    });

    res.status(201).json({ invoice });
  })
);

const addItemsSchema = z.object({
  items: z.array(lineSchema).min(1),
  // When true, entered rates are GST-inclusive and the tax is split out.
  // Omitted → falls back to the mode the bill was originally entered in.
  taxInclusive: z.boolean().optional(),
});

// POST /api/invoices/:id/add-items — append newly purchased items to an
// EXISTING bill (e.g. the customer comes back after a few days and takes more
// goods on the same account). The new lines are added on top of the current
// ones; subtotal/GST/total grow accordingly, stock is deducted (or added for
// purchase bills) with an audit movement, and the bill's paid/pending status
// is recomputed — so the dashboard, pending lists, P&L and admin reports all
// pick the addition up automatically.
router.post(
  "/:id/add-items",
  requireRole(...BILLING_ROLES),
  validateBody(addItemsSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof addItemsSchema>;
    const businessId = req.businessId!;

    const existing = await prisma.invoice.findFirst({
      where: { id: req.params.id, businessId },
    });
    if (!existing) throw notFound("Bill not found");

    // Same ex-GST normalisation as invoice creation. Unless the caller says
    // otherwise, new lines follow the mode the bill was entered in.
    const taxInclusive = body.taxInclusive ?? existing.taxInclusive;
    const lines = body.items.map((l) => {
      const netRate = round2(l.rate / (taxInclusive ? 1 + l.taxRate / 100 : 1));
      const amount = round2(l.quantity * netRate);
      return { ...l, rate: netRate, amount };
    });
    const addSubtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
    const addTax = round2(lines.reduce((s, l) => s + (l.amount * l.taxRate) / 100, 0));

    const subtotal = round2(Number(existing.subtotal) + addSubtotal);
    const taxAmount = round2(Number(existing.taxAmount) + addTax);
    const total = round2(subtotal - Number(existing.discount) + taxAmount);

    const invoice = await prisma.$transaction(async (tx) => {
      const updated = await tx.invoice.update({
        where: { id: existing.id },
        data: {
          subtotal,
          taxAmount,
          total,
          items: {
            create: lines.map((l) => ({
              itemId: l.itemId ?? null,
              description: l.description,
              quantity: l.quantity,
              rate: l.rate,
              taxRate: l.taxRate,
              amount: l.amount,
            })),
          },
        },
        include: { items: true, party: true },
      });

      // Stock: a sale addition takes goods out, a purchase addition brings
      // goods in — each with its own audit trail entry on the same bill.
      const isSale = existing.type === "SALE";
      for (const l of lines) {
        if (!l.itemId) continue;
        await recordStockMovement(tx, {
          businessId,
          itemId: l.itemId,
          type: isSale ? StockMovementType.OUT : StockMovementType.IN,
          quantity: isSale ? -l.quantity : l.quantity,
          reason: isSale ? "Added to bill" : "Added to purchase",
          reference: existing.invoiceNumber,
          invoiceId: existing.id,
          createdById: req.auth!.userId,
        });
      }

      // The bill grew, so what's paid may no longer cover it — recompute
      // amountPaid/status (PAID → PARTIAL when new dues appear).
      await recomputeInvoiceSettlement(tx, existing.id);
      return updated;
    });

    res.status(201).json({ invoice });
  })
);

// PUT /api/invoices/:id — edit an existing invoice. Reverses the original
// stock effect, replaces the line items, recomputes totals/status, and applies
// the new stock effect — all atomically, keeping the same invoice number.
router.put(
  "/:id",
  requireRole(...BILLING_ROLES),
  validateBody(invoiceSchema),
  asyncHandler(async (req, res) => {
    const businessId = req.businessId!;
    const body = req.body as z.infer<typeof invoiceSchema>;

    const existing = await prisma.invoice.findFirst({
      where: { id: req.params.id, businessId },
      include: { items: true },
    });
    if (!existing) throw notFound("Invoice not found");

    // The invoice type (SALE/PURCHASE) is not changed by an edit.
    const type = existing.type;

    const party = await prisma.party.findFirst({
      where: { id: body.partyId, businessId },
    });
    if (!party) throw badRequest("Invalid partyId for this business");

    // Recompute line amounts and totals (honouring tax-inclusive rates).
    const lines = body.items.map((l) => {
      const netRate = round2(l.rate / (body.taxInclusive ? 1 + l.taxRate / 100 : 1));
      const amount = round2(l.quantity * netRate);
      return { ...l, rate: netRate, amount };
    });
    const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
    const taxAmount = round2(
      lines.reduce((s, l) => s + (l.amount * l.taxRate) / 100, 0)
    );
    const total = round2(subtotal - body.discount + taxAmount);

    // Keep any payments already recorded; just re-derive the status.
    const amountPaid = Number(existing.amountPaid);
    const status = amountPaid <= 0 ? "UNPAID" : amountPaid >= total ? "PAID" : "PARTIAL";

    const invoice = await prisma.$transaction(async (tx) => {
      // Only move stock for items that still exist — a product on the original
      // bill may have been deleted since, which would otherwise crash the edit.
      const refIds = [
        ...existing.items.map((l) => l.itemId),
        ...lines.map((l) => l.itemId),
      ].filter(Boolean) as string[];
      const liveItems = refIds.length
        ? await tx.item.findMany({
            where: { id: { in: refIds }, businessId },
            select: { id: true },
          })
        : [];
      const liveSet = new Set(liveItems.map((i) => i.id));

      // 1. Reverse the original stock movements.
      for (const l of existing.items) {
        if (!l.itemId || !liveSet.has(l.itemId)) continue;
        const wasSale = type === "SALE";
        await recordStockMovement(tx, {
          businessId,
          itemId: l.itemId,
          type: wasSale ? StockMovementType.IN : StockMovementType.OUT,
          quantity: wasSale ? Number(l.quantity) : -Number(l.quantity),
          reason: `Edit reversal ${existing.invoiceNumber}`,
          reference: existing.invoiceNumber,
          invoiceId: existing.id,
          createdById: req.auth!.userId,
        });
      }

      // 2. Replace the line items and update the invoice.
      await tx.invoiceItem.deleteMany({ where: { invoiceId: existing.id } });
      const updated = await tx.invoice.update({
        where: { id: existing.id },
        data: {
          partyId: body.partyId,
          invoiceDate: body.invoiceDate ?? existing.invoiceDate,
          dueDate: body.dueDate ?? null,
          subtotal,
          discount: body.discount,
          taxAmount,
          total,
          status,
          taxInclusive: body.taxInclusive,
          notes: body.notes ?? null,
          estimateNo: body.estimateNo?.trim() || null,
          attachmentUrl: body.attachmentUrl ?? null,
          attachmentUrl2: body.attachmentUrl2 ?? null,
          attachmentUrl3: body.attachmentUrl3 ?? null,
          items: {
            create: lines.map((l) => ({
              itemId: l.itemId ?? null,
              description: l.description,
              quantity: l.quantity,
              rate: l.rate,
              taxRate: l.taxRate,
              amount: l.amount,
            })),
          },
        },
        include: { items: true, party: true },
      });

      // 3. Apply the new stock movements.
      for (const l of lines) {
        if (!l.itemId || !liveSet.has(l.itemId)) continue;
        const isSale = type === "SALE";
        await recordStockMovement(tx, {
          businessId,
          itemId: l.itemId,
          type: isSale ? StockMovementType.OUT : StockMovementType.IN,
          quantity: isSale ? -l.quantity : l.quantity,
          reason: `Edit ${existing.invoiceNumber}`,
          reference: existing.invoiceNumber,
          invoiceId: existing.id,
          createdById: req.auth!.userId,
        });
        if (!isSale && body.attachmentUrl) {
          await tx.item.update({
            where: { id: l.itemId },
            data: { purchaseBillUrl: body.attachmentUrl },
          });
        }
      }

      return updated;
    });

    // Count this edit in the per-day activity / time-worked reports.
    await prisma.activityLog.create({
      data: {
        businessId,
        type: "INVOICE_EDIT",
        refId: existing.id,
        userId: req.auth!.userId,
      },
    });

    res.json({ invoice });
  })
);

// DELETE /api/invoices/:id — platform admins delete directly (with stock
// reversal); shop users' deletions are held for admin approval.
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const businessId = req.businessId!;
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, businessId },
      include: { party: { select: { name: true } } },
    });
    if (!invoice) throw notFound("Invoice not found");

    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { name: true, username: true, email: true, isPlatformAdmin: true },
    });

    if (user?.isPlatformAdmin) {
      await deleteInvoiceWithReversal(invoice.id, businessId, req.auth!.userId);
      return res.status(204).send();
    }

    // Don't queue the same bill twice.
    const existing = await prisma.invoiceDeleteRequest.findFirst({
      where: { invoiceId: invoice.id, status: "PENDING" },
    });
    if (existing) {
      return res.status(202).json({
        pending: true,
        message: "This bill is already waiting for admin approval to be deleted.",
      });
    }

    await prisma.invoiceDeleteRequest.create({
      data: {
        businessId,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        partyName: invoice.party?.name ?? null,
        total: invoice.total,
        requestedById: req.auth!.userId,
        requestedByName: user?.name ?? user?.username ?? user?.email ?? null,
      },
    });

    res.status(202).json({
      pending: true,
      message: "Deletion sent to the admin for approval. The bill stays until approved.",
    });
  })
);

// POST /api/invoices/:id/return — record a sales return as a CREDIT NOTE:
// puts the returned items back into stock, records a credit note (which shows
// in the customer ledger as a credit and reduces P&L revenue/COGS). The
// original bill is kept intact for history.
//
// The same call also handles an EXCHANGE (the customer hands goods back and
// takes other products instead). Everything then happens in ONE database
// transaction so stock and the cash book can never drift apart:
//   1. returned goods go back into stock + a credit note is raised,
//   2. the replacement goods are appended to the same bill and taken out of
//      stock,
//   3. the difference is settled — collected as a receipt (cash book up),
//      refunded as an OUT voucher (cash book down), or left on the ledger.
// Previously the UI fired three separate requests for this, so a failure part
// way through left stock back in but no replacement billed, and any refund
// was an unlinked voucher that undoing the return could not give back.
const exchangeSchema = z.object({
  // When true, the entered rates are GST-inclusive and the tax is split out.
  taxInclusive: z.boolean().default(false),
  items: z.array(lineSchema).min(1),
  // Customer owes more (new goods cost more than what came back):
  //   FULL = collect all of it now, PARTIAL = collect `collectAmount`,
  //   NONE = leave it pending on the bill.
  collect: z.enum(["FULL", "PARTIAL", "NONE"]).default("FULL"),
  collectAmount: z.number().nonnegative().optional(),
  collectMethod: z
    .enum(["CASH", "BANK", "UPI", "CARD", "CHEQUE", "OTHER"])
    .default("CASH"),
  // Customer is owed money back (new goods cost less):
  //   ADJUST = keep it as a credit on their ledger (no cash moves),
  //   CASH/BANK = hand it back now, which lowers that balance in the cash book.
  refund: z.enum(["ADJUST", "CASH", "BANK"]).default("ADJUST"),
});

const returnSchema = z.object({
  reason: z.string().optional(),
  // When the customer is physically given money back, choose CASH or BANK so the
  // cash book drops by the refund. Leave empty to only credit the ledger.
  // Ignored in exchange mode — there the difference (not the whole return
  // value) is what moves, and `exchange.refund` decides how.
  refundMethod: z.enum(["CASH", "BANK"]).optional(),
  items: z
    .array(z.object({ invoiceItemId: z.string().min(1), quantity: z.number().positive() }))
    .min(1),
  exchange: exchangeSchema.optional(),
});

router.post(
  "/:id/return",
  requireRole(...BILLING_ROLES),
  validateBody(returnSchema),
  asyncHandler(async (req, res) => {
    const businessId = req.businessId!;
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, businessId, type: "SALE" },
      include: { items: true },
    });
    if (!invoice) throw notFound("Sale bill not found");

    const body = req.body as z.infer<typeof returnSchema>;
    const reqMap = new Map(body.items.map((i) => [i.invoiceItemId, i.quantity]));

    let returnNet = 0;
    let returnTax = 0;
    const returned: {
      itemId: string | null;
      retQty: number;
      invoiceItemId: string;
      rate: number;
      taxRate: number;
    }[] = [];
    for (const li of invoice.items) {
      const reqQty = reqMap.get(li.id);
      if (!reqQty) continue;
      // Only allow returning what hasn't been returned already.
      const remaining = Number(li.quantity) - Number(li.returnedQty);
      const retQty = Math.min(reqQty, remaining);
      if (retQty <= 0) continue;
      const lineNet = retQty * Number(li.rate);
      returnNet += lineNet;
      returnTax += (lineNet * Number(li.taxRate)) / 100;
      returned.push({
        itemId: li.itemId,
        retQty,
        invoiceItemId: li.id,
        rate: Number(li.rate),
        taxRate: Number(li.taxRate),
      });
    }
    if (returned.length === 0)
      throw badRequest(
        "Nothing left to return on this bill — these items were already returned."
      );

    // Cost of the returned goods (for COGS reduction in P&L).
    const itemIds = returned.map((r) => r.itemId).filter(Boolean) as string[];
    const itemRows = itemIds.length
      ? await prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, purchasePrice: true, taxRate: true },
        })
      : [];
    // Purchase prices are GST-inclusive; store the returned goods' cost ex-GST
    // so it matches the ex-GST COGS used in the P&L.
    const priceMap = new Map(
      itemRows.map((i) => [i.id, Number(i.purchasePrice) / (1 + Number(i.taxRate) / 100)])
    );
    const returnCogs = returned.reduce(
      (s, r) => s + (r.itemId ? r.retQty * (priceMap.get(r.itemId) ?? 0) : 0),
      0
    );

    const returnGross = round2(returnNet + returnTax);

    const lines = returned.map((r) => ({
      invoiceItemId: r.invoiceItemId,
      itemId: r.itemId,
      quantity: r.retQty,
      rate: r.rate,
      taxRate: r.taxRate,
    }));

    // ---- Exchange: the replacement goods the customer walks out with. -------
    // Same ex-GST normalisation as invoice creation / add-items, so the bill's
    // subtotal, GST and total stay internally consistent.
    const exch = body.exchange;
    const exchLines = (exch?.items ?? []).map((l) => {
      const netRate = round2(l.rate / (exch?.taxInclusive ? 1 + l.taxRate / 100 : 1));
      return { ...l, rate: netRate, amount: round2(l.quantity * netRate) };
    });
    const exchSubtotal = round2(exchLines.reduce((s, l) => s + l.amount, 0));
    const exchTax = round2(exchLines.reduce((s, l) => s + (l.amount * l.taxRate) / 100, 0));
    const exchGross = round2(exchSubtotal + exchTax);
    // Positive → the customer owes the shop more; negative → the shop owes the
    // customer. Both are settled inside the transaction below.
    const difference = round2(exchGross - returnGross);

    // Never move stock on a product from another shop.
    if (exch) {
      const exchItemIds = [...new Set(exchLines.map((l) => l.itemId).filter(Boolean))] as string[];
      if (exchItemIds.length) {
        const owned = await prisma.item.count({
          where: { id: { in: exchItemIds }, businessId },
        });
        if (owned !== exchItemIds.length)
          throw badRequest("One of the exchange products does not belong to this shop.");
      }
    }

    // What actually moves through the cash book for this exchange.
    let collected = 0;
    let refunded = 0;
    if (exch) {
      if (difference > 0.009 && exch.collect !== "NONE") {
        collected =
          exch.collect === "FULL"
            ? difference
            : round2(Math.min(Math.max(exch.collectAmount ?? 0, 0), difference));
      } else if (difference < -0.009 && exch.refund !== "ADJUST") {
        refunded = round2(-difference);
      }
    }

    const creditNote = await prisma.$transaction(async (tx) => {
      for (const r of returned) {
        // Record how much of this line is now returned (prevents re-returning).
        await tx.invoiceItem.update({
          where: { id: r.invoiceItemId },
          data: { returnedQty: { increment: r.retQty } },
        });
        if (!r.itemId) continue;
        await recordStockMovement(tx, {
          businessId,
          itemId: r.itemId,
          type: StockMovementType.IN,
          quantity: r.retQty,
          reason: `Sales return${body.reason ? ` - ${body.reason}` : ""}`,
          reference: invoice.invoiceNumber,
          invoiceId: invoice.id,
          createdById: req.auth!.userId,
        });
      }

      // Exchange: append the replacement goods to the SAME bill and take them
      // out of stock, exactly like /add-items does — subtotal, GST and total
      // all grow, so the printed bill, GST report and P&L pick the swap up.
      // The created lines are remembered on the credit note so undoing the
      // return can strip them off again.
      const exchangeRecord: Array<{
        invoiceItemId: string;
        itemId: string | null;
        quantity: number;
        rate: number;
        taxRate: number;
        amount: number;
      }> = [];
      if (exch && exchLines.length) {
        await tx.invoice.update({
          where: { id: invoice.id },
          data: {
            subtotal: round2(Number(invoice.subtotal) + exchSubtotal),
            taxAmount: round2(Number(invoice.taxAmount) + exchTax),
            total: round2(
              Number(invoice.subtotal) +
                exchSubtotal -
                Number(invoice.discount) +
                Number(invoice.taxAmount) +
                exchTax
            ),
          },
        });
        for (const l of exchLines) {
          const created = await tx.invoiceItem.create({
            data: {
              invoiceId: invoice.id,
              itemId: l.itemId ?? null,
              description: l.description,
              quantity: l.quantity,
              rate: l.rate,
              taxRate: l.taxRate,
              amount: l.amount,
            },
          });
          exchangeRecord.push({
            invoiceItemId: created.id,
            itemId: l.itemId ?? null,
            quantity: l.quantity,
            rate: l.rate,
            taxRate: l.taxRate,
            amount: l.amount,
          });
          if (!l.itemId) continue;
          await recordStockMovement(tx, {
            businessId,
            itemId: l.itemId,
            type: StockMovementType.OUT,
            quantity: -l.quantity,
            reason: `Exchange${body.reason ? ` - ${body.reason}` : ""}`,
            reference: invoice.invoiceNumber,
            invoiceId: invoice.id,
            createdById: req.auth!.userId,
          });
        }
      }

      // Money the customer hands over for a costlier replacement: a normal
      // receipt against this bill, so the cash book goes up and the bill's
      // pending amount comes down.
      let collectPaymentId: string | null = null;
      if (collected > 0.009) {
        const receipt = await tx.payment.create({
          data: {
            businessId,
            partyId: invoice.partyId,
            invoiceId: invoice.id,
            direction: PaymentDirection.IN,
            purpose: "Customer Receipt",
            amount: collected,
            method: PaymentMethod[exch!.collectMethod],
            notes: `Exchange difference on ${invoice.invoiceNumber}`,
          },
        });
        collectPaymentId = receipt.id;
      }

      // Cash/bank refund: an OUT voucher that lowers the cash book. On a plain
      // return that is the whole return value; on an exchange it is only the
      // difference the customer is owed back. Either way it is linked to the
      // credit note (refundPaymentId), so undoing the return deletes the
      // voucher and puts the money back in the cash book.
      const refundMethod = exch
        ? exch.refund === "ADJUST"
          ? null
          : exch.refund
        : body.refundMethod ?? null;
      const refundAmount = exch ? refunded : refundMethod ? returnGross : 0;

      let refundPaymentId: string | null = null;
      if (refundMethod && refundAmount > 0.009) {
        const refund = await tx.payment.create({
          data: {
            businessId,
            partyId: invoice.partyId,
            invoiceId: invoice.id,
            direction: PaymentDirection.OUT,
            purpose: "Sales Return Refund",
            amount: refundAmount,
            method: refundMethod === "BANK" ? PaymentMethod.BANK : PaymentMethod.CASH,
            notes: `${exch ? "Exchange refund" : "Refund"} for return on ${
              invoice.invoiceNumber
            }${body.reason ? ` - ${body.reason}` : ""}`,
          },
        });
        refundPaymentId = refund.id;
      }

      const note = await tx.creditNote.create({
        data: {
          businessId,
          partyId: invoice.partyId,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          netAmount: round2(returnNet),
          taxAmount: round2(returnTax),
          totalAmount: returnGross,
          cogs: round2(returnCogs),
          reason: body.reason ?? null,
          lines,
          refundMethod: refundPaymentId ? refundMethod : null,
          refundPaymentId,
          exchangeLines: exchangeRecord.length ? exchangeRecord : undefined,
          collectPaymentId,
          createdById: req.auth!.userId,
        },
      });

      // The bill's total and/or its receipts changed — re-derive amountPaid
      // and PAID/PARTIAL/UNPAID from scratch so the pending lists, dashboard
      // and admin reports all agree.
      await recomputeInvoiceSettlement(tx, invoice.id);
      return note;
    });

    res.json({
      creditNote,
      returnedAmount: returnGross,
      ...(exch
        ? {
            exchange: {
              addedAmount: exchGross,
              difference,
              collected: round2(collected),
              refunded: round2(refunded),
            },
          }
        : {}),
    });
  })
);

// GET /api/invoices/:id/returns — list the returns (credit notes) recorded
// against a bill, so staff can see exactly what was already returned and undo
// a wrong entry.
router.get(
  "/:id/returns",
  requireRole(...BILLING_ROLES),
  asyncHandler(async (req, res) => {
    const businessId = req.businessId!;
    const returns = await prisma.creditNote.findMany({
      where: { businessId, invoiceId: req.params.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({ returns });
  })
);

// DELETE /api/invoices/:id/return/:creditNoteId/refund — the return stays, but
// the cash/bank refund recorded with it is removed.
//
// Choosing a refund method on a return means "we handed the money back", so
// the returned value comes off the bill AND the money paid out is owed again —
// the two cancel out and the bill's due is unchanged. That is right when cash
// really left the drawer, but a return on a bill the customer still owes for is
// almost always an adjustment, not a payout. This turns such a return into a
// plain ledger credit: the due drops by the returned value and the cash book
// no longer shows money going out.
router.delete(
  "/:id/return/:creditNoteId/refund",
  requireRole(...BILLING_ROLES),
  asyncHandler(async (req, res) => {
    const businessId = req.businessId!;
    const note = await prisma.creditNote.findFirst({
      where: { id: req.params.creditNoteId, businessId, invoiceId: req.params.id },
    });
    if (!note) throw notFound("Return entry not found");
    if (!note.refundPaymentId && !note.refundMethod)
      throw badRequest("This return was already adjusted against the bill — no refund to remove.");

    const removed = await prisma.$transaction(async (tx) => {
      let amount = 0;
      if (note.refundPaymentId) {
        const pay = await tx.payment.findFirst({
          where: { id: note.refundPaymentId, businessId },
        });
        if (pay) {
          amount = Number(pay.amount);
          await tx.payment.delete({ where: { id: pay.id } });
        }
      }
      await tx.creditNote.update({
        where: { id: note.id },
        data: { refundMethod: null, refundPaymentId: null },
      });
      // The bill's receipts changed, so re-derive amountPaid and status.
      await recomputeInvoiceSettlement(tx, req.params.id);
      return amount;
    });

    res.json({ ok: true, removedRefund: round2(removed) });
  })
);

// DELETE /api/invoices/:id/return/:creditNoteId — undo a wrong return.
// Platform admins reverse it immediately; shop users' undo is held for
// platform-admin approval (mirrors invoice deletion). On approval the return is
// reversed: the stock it added back is removed, the returnedQty on each line is
// freed, and the cash/bank refund voucher (if any) is deleted.
router.delete(
  "/:id/return/:creditNoteId",
  requireRole(...BILLING_ROLES),
  asyncHandler(async (req, res) => {
    const businessId = req.businessId!;
    const note = await prisma.creditNote.findFirst({
      where: { id: req.params.creditNoteId, businessId, invoiceId: req.params.id },
    });
    if (!note) throw notFound("Return entry not found");

    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { name: true, username: true, email: true, isPlatformAdmin: true },
    });

    // Platform admins undo directly; everyone else sends it for approval.
    if (user?.isPlatformAdmin) {
      await reverseReturn(note.id, businessId, req.auth!.userId);
      return res.json({ ok: true, reversedAmount: Number(note.totalAmount) });
    }

    // Don't queue the same return twice.
    const existing = await prisma.returnDeleteRequest.findFirst({
      where: { creditNoteId: note.id, status: "PENDING" },
    });
    if (existing) {
      return res.status(202).json({
        pending: true,
        message: "This return is already waiting for admin approval to be deleted.",
      });
    }

    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, businessId },
      include: { party: { select: { name: true } } },
    });

    await prisma.returnDeleteRequest.create({
      data: {
        businessId,
        creditNoteId: note.id,
        invoiceId: note.invoiceId,
        invoiceNumber: note.invoiceNumber,
        partyName: invoice?.party?.name ?? null,
        amount: note.totalAmount,
        refundMethod: note.refundMethod,
        reason: note.reason,
        requestedById: req.auth!.userId,
        requestedByName: user?.name ?? user?.username ?? user?.email ?? null,
      },
    });

    res.status(202).json({
      pending: true,
      message:
        "Return deletion sent to the admin for approval. The return stays until approved.",
    });
  })
);

export default router;
