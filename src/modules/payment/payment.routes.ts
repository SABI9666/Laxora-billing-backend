import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, notFound } from "../../utils/errors";

const router = Router();

const paymentSchema = z.object({
  partyId: z.string().min(1),
  invoiceId: z.string().optional(),
  amount: z.number().positive(),
  method: z.enum(["CASH", "BANK", "UPI", "CARD", "CHEQUE", "OTHER"]).default("CASH"),
  paymentDate: z.coerce.date().optional(),
  notes: z.string().optional(),
});

// GET /api/payments?partyId=&invoiceId=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { partyId, invoiceId } = req.query;
    const payments = await prisma.payment.findMany({
      where: {
        businessId: req.businessId!,
        ...(partyId ? { partyId: String(partyId) } : {}),
        ...(invoiceId ? { invoiceId: String(invoiceId) } : {}),
      },
      include: { party: { select: { id: true, name: true } } },
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

    const party = await prisma.party.findFirst({
      where: { id: body.partyId, businessId },
    });
    if (!party) throw badRequest("Invalid partyId for this business");

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
          partyId: body.partyId,
          invoiceId: body.invoiceId ?? null,
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
