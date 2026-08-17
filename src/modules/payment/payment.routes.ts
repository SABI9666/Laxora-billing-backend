import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, notFound } from "../../utils/errors";
import { recomputeInvoiceSettlement } from "../../lib/settlement";

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

    // A settling payment with a party but NO specific bill chosen is
    // auto-allocated to that party's outstanding bills, oldest first — so a
    // ₹5,000 receipt against an ₹8,000 pending bill leaves ₹3,000 due, and a
    // full ₹8,000 receipt clears the bill out of the pending list entirely.
    const settlesSales =
      body.direction === "IN" && (body.purpose ?? "Customer Receipt") === "Customer Receipt";
    const settlesPurchases = body.direction === "OUT" && body.purpose === "Supplier Payment";
    const autoAllocate =
      !body.invoiceId && !!body.partyId && (settlesSales || settlesPurchases);

    const payment = await prisma.$transaction(async (tx) => {
      const common = {
        businessId,
        partyId: body.partyId ?? null,
        direction: body.direction,
        purpose: body.purpose ?? null,
        method: body.method,
        paymentDate: body.paymentDate ?? new Date(),
        notes: body.notes ?? null,
      };

      if (autoAllocate) {
        const open = await tx.invoice.findMany({
          where: {
            businessId,
            partyId: body.partyId!,
            type: settlesSales ? "SALE" : "PURCHASE",
            status: { in: ["UNPAID", "PARTIAL"] },
          },
          orderBy: { invoiceDate: "asc" },
        });
        let remaining = body.amount;
        let first = null;
        for (const inv of open) {
          if (remaining <= 0.009) break;
          const due = Number(inv.total) - Number(inv.amountPaid);
          if (due <= 0.009) continue;
          const part = Math.round(Math.min(remaining, due) * 100) / 100;
          const created = await tx.payment.create({
            data: { ...common, invoiceId: inv.id, amount: part },
          });
          first = first ?? created;
          await recomputeInvoiceSettlement(tx, inv.id);
          remaining = Math.round((remaining - part) * 100) / 100;
        }
        // Anything left over (advance / no open bills) stays as an unlinked
        // receipt on the party's ledger.
        if (remaining > 0.009 || !first) {
          const created = await tx.payment.create({
            data: { ...common, invoiceId: null, amount: remaining > 0.009 ? remaining : body.amount },
          });
          first = first ?? created;
        }
        return first;
      }

      const created = await tx.payment.create({
        data: { ...common, invoiceId: body.invoiceId ?? null, amount: body.amount },
      });

      // If linked to an invoice, recompute amountPaid and status (payments
      // plus any bill-linked charges).
      if (body.invoiceId) {
        await recomputeInvoiceSettlement(tx, body.invoiceId);
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
        await recomputeInvoiceSettlement(tx, payment.invoiceId);
      }
    });

    res.status(204).send();
  })
);

export default router;
