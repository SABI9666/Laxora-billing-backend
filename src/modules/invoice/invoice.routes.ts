import { Router } from "express";
import { z } from "zod";
import { Prisma, StockMovementType, PaymentDirection, PaymentMethod } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, notFound } from "../../utils/errors";
import { requireRole, BILLING_ROLES } from "../../middleware/roles";
import { recordStockMovement } from "../../lib/stock";
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
      include: { party: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });

    // Per-bill profit for SALE invoices: ex-GST net revenue (subtotal −
    // discount) minus ex-GST cost of goods (purchase price is GST-inclusive).
    const saleIds = invoices.filter((i) => i.type === "SALE").map((i) => i.id);
    const profitMap = new Map<string, number>();
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

        for (const inv of invoices) {
          if (inv.type !== "SALE") continue;
          const profit =
            Number(inv.subtotal) -
            Number(inv.discount) -
            (cogsMap.get(inv.id) ?? 0) -
            (expenseMap.get(inv.id) ?? 0);
          profitMap.set(inv.id, Math.round((profit + Number.EPSILON) * 100) / 100);
        }
      } catch (err) {
        console.error("invoice profit calc failed (list still returned):", err);
      }
    }

    res.json({
      invoices: invoices.map((inv) => ({ ...inv, profit: profitMap.get(inv.id) ?? null })),
    });
  })
);

// GET /api/invoices/:id — full invoice with line items and payments.
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
      include: {
        // Include the linked product's HSN and unit for the tax-invoice print.
        items: { include: { item: { select: { hsn: true, unit: true, sku: true } } } },
        party: true,
        payments: true,
      },
    });
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
          notes: body.notes ?? null,
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

      return created;
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
          notes: body.notes ?? null,
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
const returnSchema = z.object({
  reason: z.string().optional(),
  // When the customer is physically given money back, choose CASH or BANK so the
  // cash book drops by the refund. Leave empty to only credit the ledger.
  refundMethod: z.enum(["CASH", "BANK"]).optional(),
  items: z
    .array(z.object({ invoiceItemId: z.string().min(1), quantity: z.number().positive() }))
    .min(1),
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

      // Optional cash/bank refund: an OUT voucher that lowers the cash book.
      let refundPaymentId: string | null = null;
      if (body.refundMethod) {
        const refund = await tx.payment.create({
          data: {
            businessId,
            partyId: invoice.partyId,
            invoiceId: invoice.id,
            direction: PaymentDirection.OUT,
            purpose: "Sales Return Refund",
            amount: returnGross,
            method:
              body.refundMethod === "BANK" ? PaymentMethod.BANK : PaymentMethod.CASH,
            notes: `Refund for return on ${invoice.invoiceNumber}${
              body.reason ? ` - ${body.reason}` : ""
            }`,
          },
        });
        refundPaymentId = refund.id;
      }

      return tx.creditNote.create({
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
          refundMethod: body.refundMethod ?? null,
          refundPaymentId,
          createdById: req.auth!.userId,
        },
      });
    });

    res.json({ creditNote, returnedAmount: returnGross });
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
