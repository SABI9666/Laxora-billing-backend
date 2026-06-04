import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { notFound } from "../../utils/errors";
import { requireRole, BILLING_ROLES } from "../../middleware/roles";

const router = Router();

const expenseSchema = z.object({
  category: z.string().min(1),
  amount: z.number().positive(),
  note: z.string().optional(),
  invoiceId: z.string().optional(),
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
    const expense = await prisma.expense.create({
      data: {
        businessId: req.businessId!,
        category: body.category,
        amount: body.amount,
        note: body.note ?? null,
        invoiceId: body.invoiceId ?? null,
        date: body.date ?? new Date(),
        createdById: req.auth!.userId,
      },
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
    await prisma.expense.delete({ where: { id: req.params.id } });
    res.status(204).send();
  })
);

export default router;
