import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, notFound } from "../../utils/errors";
import {
  billDue,
  recomputeInvoiceSettlement,
  refundedByInvoice,
  settleAgainstOpenBills,
} from "../../lib/settlement";

const router = Router();

const paymentSchema = z.object({
  partyId: z.string().optional(),
  invoiceId: z.string().optional(),
  // Several bills settled by one voucher: the amount clears these oldest
  // first; anything beyond them spills to the party's other open bills, and
  // what is still left stays on the ledger as an advance.
  invoiceIds: z.array(z.string().min(1)).optional(),
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

    // The bill a receipt is recorded against also tells us the party, so a
    // receipt that overshoots that bill can still spill onto the party's other
    // open bills below.
    const linkedInvoice = body.invoiceId
      ? await prisma.invoice.findFirst({ where: { id: body.invoiceId, businessId } })
      : null;

    // Bills the accountant ticked. They must all exist here and belong to the
    // same party, which then also stands in for a missing partyId.
    const chosenIds = [...new Set((body.invoiceIds ?? []).filter(Boolean))];
    const chosen = chosenIds.length
      ? await prisma.invoice.findMany({
          where: { id: { in: chosenIds }, businessId },
          select: { id: true, partyId: true },
        })
      : [];
    if (chosen.length !== chosenIds.length)
      throw badRequest("One of the selected bills was not found for this business");

    const partyId = body.partyId ?? linkedInvoice?.partyId ?? chosen[0]?.partyId ?? null;
    if (chosen.some((c) => c.partyId !== partyId))
      throw badRequest("The selected bills belong to different parties");

    const payment = await prisma.$transaction(async (tx) => {
      const common = {
        businessId,
        partyId,
        direction: body.direction,
        purpose: body.purpose ?? null,
        method: body.method,
        paymentDate: body.paymentDate ?? new Date(),
        notes: body.notes ?? null,
      };
      const settling = settlesSales || settlesPurchases;

      // Accountant picked the bills: clear those oldest first, then let any
      // excess run on to the party's other open bills, then keep the rest as
      // an advance. Returns the first part created so the caller has a row.
      if (chosenIds.length && settling && partyId && !body.invoiceId) {
        const voucher = { ...common, partyId };
        const picked = await settleAgainstOpenBills(tx, voucher, body.amount, {
          onlyInvoiceIds: chosenIds,
        });
        let remaining = picked.remaining;
        let firstId: string | undefined = picked.paymentIds[0];
        if (remaining > 0.009) {
          const spill = await settleAgainstOpenBills(tx, voucher, remaining, {
            excludeInvoiceIds: chosenIds,
          });
          remaining = spill.remaining;
          firstId = firstId ?? spill.paymentIds[0];
        }
        if (remaining > 0.009 || !firstId) {
          const advance = await tx.payment.create({
            data: {
              ...common,
              invoiceId: null,
              amount: remaining > 0.009 ? remaining : body.amount,
            },
          });
          firstId = firstId ?? advance.id;
        }
        return tx.payment.findUniqueOrThrow({ where: { id: firstId } });
      }

      if (autoAllocate) {
        const { remaining, paymentIds } = await settleAgainstOpenBills(
          tx,
          { ...common, partyId: partyId! },
          body.amount
        );
        // Anything left over (advance / no open bills) stays as an unlinked
        // receipt on the party's ledger.
        if (remaining > 0.009 || paymentIds.length === 0) {
          return tx.payment.create({
            data: { ...common, invoiceId: null, amount: remaining > 0.009 ? remaining : body.amount },
          });
        }
        return tx.payment.findUniqueOrThrow({ where: { id: paymentIds[0] } });
      }

      // Recorded against one specific bill. A settling voucher only ever
      // clears THAT bill's outstanding due; if the customer handed over more
      // (one cheque for several bills is common), the excess moves on to
      // their other open bills, oldest first, and whatever is still left is
      // kept as an advance. Without this the extra was silently swallowed —
      // amountPaid is capped at the bill total — so the ledger showed the
      // customer paid up while their other bills stayed pending.
      let amountHere = body.amount;
      let excess = 0;
      if (linkedInvoice && settling && partyId) {
        const returned =
          linkedInvoice.type === "SALE"
            ? Number(
                (
                  await tx.creditNote.aggregate({
                    where: { businessId, invoiceId: linkedInvoice.id },
                    _sum: { totalAmount: true },
                  })
                )._sum.totalAmount ?? 0
              )
            : 0;
        const refunded = (
          await refundedByInvoice(tx, businessId, [linkedInvoice.id], linkedInvoice.type)
        ).get(linkedInvoice.id);
        const due = Math.max(
          0,
          billDue({
            total: linkedInvoice.total,
            amountPaid: linkedInvoice.amountPaid,
            returned,
            refunded,
          })
        );
        if (body.amount > due + 0.009) {
          amountHere = due;
          excess = Math.round((body.amount - due) * 100) / 100;
        }
      }

      let created = null;
      if (amountHere > 0.009) {
        created = await tx.payment.create({
          data: { ...common, invoiceId: body.invoiceId ?? null, amount: amountHere },
        });
        // If linked to an invoice, recompute amountPaid and status (payments
        // plus any bill-linked charges).
        if (body.invoiceId) await recomputeInvoiceSettlement(tx, body.invoiceId);
      }

      if (excess > 0.009) {
        const { remaining, paymentIds } = await settleAgainstOpenBills(
          tx,
          { ...common, partyId: partyId! },
          excess,
          { excludeInvoiceIds: [linkedInvoice!.id] }
        );
        if (remaining > 0.009) {
          const advance = await tx.payment.create({
            data: { ...common, invoiceId: null, amount: remaining },
          });
          created = created ?? advance;
        } else if (!created && paymentIds.length) {
          created = await tx.payment.findUniqueOrThrow({ where: { id: paymentIds[0] } });
        }
      }

      // Only reachable if the bill was already settled and nothing spilled —
      // record the voucher on the bill anyway so the money is not lost.
      return (
        created ??
        (await tx.payment.create({
          data: { ...common, invoiceId: body.invoiceId ?? null, amount: body.amount },
        }))
      );
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
