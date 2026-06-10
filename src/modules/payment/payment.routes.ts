import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, notFound } from "../../utils/errors";

const router = Router();

const paymentSchema = z.object({
  partyId: z.string().optional(),
  invoiceId: z.string().optional(),
  // IN = credit voucher (money received), OUT = payment voucher (money given).
  direction: z.enum(["IN", "OUT"]).default("IN"),
  // Supplier Payment | Customer Receipt | Expense | Bank Deposit | Bank Withdrawal | Other
  purpose: z.string().optional(),
  amount: z.number().positive(),
  method: z.enum(["CASH", "BANK", "UPI", "CARD", "CHEQUE", "OTHER"]).default("CASH"),
  paymentDate: z.coerce.date().optional(),
  notes: z.string().optional(),
});

// GET /api/payments?partyId=&invoiceId=&direction=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { partyId, invoiceId, direction } = req.query;
    const payments = await prisma.payment.findMany({
      where: {
        businessId: req.businessId!,
        ...(partyId ? { partyId: String(partyId) } : {}),
        ...(invoiceId ? { invoiceId: String(invoiceId) } : {}),
        ...(direction ? { direction: direction as "IN" | "OUT" } : {}),
      },
      include: {
        party: { select: { id: true, name: true } },
        invoice: { select: { id: true, invoiceNumber: true } },
      },
      orderBy: { paymentDate: "desc" },
    });
    res.json({ payments });
  })
);

// POST /api/payments — record a payment and recompute invoice status if linked.
router.post(
  "/",
  validateBody(paymentSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof paymentSchema>;
    const businessId = req.businessId!;

    // Party is optional (expenses, bank deposits, etc. have no party).
    if (body.partyId) {
      const party = await prisma.party.findFirst({
        where: { id: body.partyId, businessId },
      });
      if (!party) throw badRequest("Invalid partyId for this business");
    }

    if (body.invoiceId) {
      const invoice = await prisma.invoice.findFirst({
        where: { id: body.invoiceId, businessId },
      });
      if (!invoice) throw badRequest("Invalid invoiceId for this business");
    }

    const payment = await prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          businessId,
          partyId: body.partyId ?? null,
          invoiceId: body.invoiceId ?? null,
          direction: body.direction,
          purpose: body.purpose ?? null,
          amount: body.amount,
          method: body.method,
          paymentDate: body.paymentDate ?? new Date(),
          notes: body.notes ?? null,
        },
      });

      // If linked to an invoice, recompute amountPaid and status.
      if (body.invoiceId) {
        const agg = await tx.payment.aggregate({
          where: { invoiceId: body.invoiceId },
          _sum: { amount: true },
        });
        const paid = Number(agg._sum.amount ?? 0);
        const inv = await tx.invoice.findUniqueOrThrow({
          where: { id: body.invoiceId },
        });
        const total = Number(inv.total);
        const status =
          paid <= 0 ? "UNPAID" : paid >= total ? "PAID" : "PARTIAL";
        await tx.invoice.update({
          where: { id: body.invoiceId },
          data: { amountPaid: paid, status },
        });
      }

      return created;
    });

    res.status(201).json({ payment });
  })
);

// DELETE /api/payments/:id
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const payment = await prisma.payment.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!payment) throw notFound("Payment not found");

    await prisma.$transaction(async (tx) => {
      await tx.payment.delete({ where: { id: payment.id } });
      if (payment.invoiceId) {
        const agg = await tx.payment.aggregate({
          where: { invoiceId: payment.invoiceId },
          _sum: { amount: true },
        });
        const paid = Number(agg._sum.amount ?? 0);
        const inv = await tx.invoice.findUnique({
          where: { id: payment.invoiceId },
        });
        if (inv) {
          const total = Number(inv.total);
          const status =
            paid <= 0 ? "UNPAID" : paid >= total ? "PAID" : "PARTIAL";
          await tx.invoice.update({
            where: { id: payment.invoiceId },
            data: { amountPaid: paid, status },
          });
        }
      }
    });

    res.status(204).send();
  })
);

export default router;
