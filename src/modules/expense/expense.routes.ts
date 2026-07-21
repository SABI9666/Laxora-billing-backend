import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, notFound } from "../../utils/errors";
import { requireRole, BILLING_ROLES } from "../../middleware/roles";
import { recomputeInvoiceSettlement } from "../../lib/settlement";

const router = Router();

const expenseSchema = z.object({
  category: z.string().min(1),
  amount: z.number().positive(),
  note: z.string().optional(),
  invoiceId: z.string().optional(),
  // Cash/bank paid — when set, the cash book reduces that balance.
  method: z.enum(["CASH", "BANK", "UPI", "CARD", "CHEQUE", "OTHER"]).optional(),
  date: z.coerce.date().optional(),
});

// GET /api/expenses?invoiceId=&from=&to= — list charges for the shop.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { invoiceId, from, to } = req.query;
    const expenses = await prisma.expense.findMany({
      where: {
        businessId: req.businessId!,
        ...(invoiceId ? { invoiceId: String(invoiceId) } : {}),
        ...(from || to
          ? {
              date: {
                ...(from ? { gte: new Date(String(from)) } : {}),
                ...(to ? { lte: new Date(String(to)) } : {}),
              },
            }
          : {}),
      },
      orderBy: { date: "desc" },
    });
    res.json({ expenses });
  })
);

// POST /api/expenses — record a charge (commission, damage, return, etc.).
router.post(
  "/",
  requireRole(...BILLING_ROLES),
  validateBody(expenseSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof expenseSchema>;
    const businessId = req.businessId!;

    if (body.invoiceId) {
      const invoice = await prisma.invoice.findFirst({
        where: { id: body.invoiceId, businessId },
      });
      if (!invoice) throw badRequest("Invalid invoiceId for this business");
    }

    const expense = await prisma.$transaction(async (tx) => {
      const created = await tx.expense.create({
        data: {
          businessId,
          category: body.category,
          amount: body.amount,
          note: body.note ?? null,
          invoiceId: body.invoiceId ?? null,
          method: body.method ?? null,
          date: body.date ?? new Date(),
          createdById: req.auth!.userId,
        },
      });
      // A charge linked to a bill settles part of that bill: bring the bill's
      // due amount and PAID/PARTIAL status in line everywhere.
      if (body.invoiceId) {
        await recomputeInvoiceSettlement(tx, body.invoiceId);
      }
      return created;
    });
    res.status(201).json({ expense });
  })
);

// DELETE /api/expenses/:id
router.delete(
  "/:id",
  requireRole(...BILLING_ROLES),
  asyncHandler(async (req, res) => {
    const existing = await prisma.expense.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!existing) throw notFound("Expense not found");
    await prisma.$transaction(async (tx) => {
      await tx.expense.delete({ where: { id: existing.id } });
      // Removing a bill-linked charge restores that bill's due amount.
      if (existing.invoiceId) {
        await recomputeInvoiceSettlement(tx, existing.invoiceId);
      }
    });
    res.status(204).send();
  })
);

export default router;
