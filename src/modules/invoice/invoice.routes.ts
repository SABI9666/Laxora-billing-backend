import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, notFound } from "../../utils/errors";

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

// GET /api/invoices?type=SALE&partyId=&status=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { type, partyId, status } = req.query;
    const invoices = await prisma.invoice.findMany({
      where: {
        businessId: req.businessId!,
        ...(type ? { type: type as "SALE" | "PURCHASE" } : {}),
        ...(partyId ? { partyId: String(partyId) } : {}),
        ...(status ? { status: status as never } : {}),
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
      const prefix = body.type === "SALE" ? "INV" : "PUR";
      const invoiceNumber = `${prefix}-${String(seq).padStart(4, "0")}`;

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

      // Adjust stock: SALE reduces stock, PURCHASE increases it.
      for (const l of lines) {
        if (!l.itemId) continue;
        await tx.item.update({
          where: { id: l.itemId },
          data: {
            stockQty: {
              [body.type === "SALE" ? "decrement" : "increment"]: new Prisma.Decimal(
                l.quantity
              ),
            },
          },
        });
      }

      return created;
    });

    res.status(201).json({ invoice });
  })
);

// DELETE /api/invoices/:id — delete invoice and restore stock.
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
      include: { items: true },
    });
    if (!invoice) throw notFound("Invoice not found");

    await prisma.$transaction(async (tx) => {
      // Reverse the stock movement before deleting.
      for (const l of invoice.items) {
        if (!l.itemId) continue;
        await tx.item.update({
          where: { id: l.itemId },
          data: {
            stockQty: {
              [invoice.type === "SALE" ? "increment" : "decrement"]: l.quantity,
            },
          },
        });
      }
      await tx.payment.deleteMany({ where: { invoiceId: invoice.id } });
      await tx.invoice.delete({ where: { id: invoice.id } });
    });

    res.status(204).send();
  })
);

export default router;
