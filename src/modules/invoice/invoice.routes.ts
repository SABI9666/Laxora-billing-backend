import { Router } from "express";
import { z } from "zod";
import { StockMovementType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, notFound } from "../../utils/errors";
import { requireRole, BILLING_ROLES } from "../../middleware/roles";
import { recordStockMovement } from "../../lib/stock";
import { deleteInvoiceWithReversal } from "../../lib/invoiceOps";

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
    res.json({ invoices });
  })
);

// GET /api/invoices/:id — full invoice with line items and payments.
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
      include: { items: true, party: true, payments: true },
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

    // Compute line amounts and totals.
    const lines = body.items.map((l) => {
      const amount = round2(l.quantity * l.rate);
      return { ...l, amount };
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
      }

      return created;
    });

    res.status(201).json({ invoice });
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
    const returned: { itemId: string | null; retQty: number }[] = [];
    for (const li of invoice.items) {
      const reqQty = reqMap.get(li.id);
      if (!reqQty) continue;
      const retQty = Math.min(reqQty, Number(li.quantity));
      if (retQty <= 0) continue;
      const lineNet = retQty * Number(li.rate);
      returnNet += lineNet;
      returnTax += (lineNet * Number(li.taxRate)) / 100;
      returned.push({ itemId: li.itemId, retQty });
    }
    if (returned.length === 0) throw badRequest("Nothing to return on this bill");

    // Cost of the returned goods (for COGS reduction in P&L).
    const itemIds = returned.map((r) => r.itemId).filter(Boolean) as string[];
    const itemRows = itemIds.length
      ? await prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, purchasePrice: true },
        })
      : [];
    const priceMap = new Map(itemRows.map((i) => [i.id, Number(i.purchasePrice)]));
    const returnCogs = returned.reduce(
      (s, r) => s + (r.itemId ? r.retQty * (priceMap.get(r.itemId) ?? 0) : 0),
      0
    );

    const returnGross = round2(returnNet + returnTax);

    const creditNote = await prisma.$transaction(async (tx) => {
      for (const r of returned) {
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
          createdById: req.auth!.userId,
        },
      });
    });

    res.json({ creditNote, returnedAmount: returnGross });
  })
);

export default router;
