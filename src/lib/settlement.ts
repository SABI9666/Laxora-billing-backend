import { Prisma, PrismaClient } from "@prisma/client";

type Db = Prisma.TransactionClient | PrismaClient;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// A bill's settled amount is everything recorded against it: payments received
// PLUS bill-linked charges (commission, damage, transport, …) that the shop
// absorbs instead of collecting from the customer. Both reduce what is still
// due, so amountPaid/status are always recomputed from scratch here whenever a
// payment or a bill-linked expense is created or deleted.
//
// The settled amount is capped at the bill total: a charge only ever clears
// the OUTSTANDING due, never more. So a charge on an already fully-paid bill
// leaves it PAID with zero due (it is just the shop's cost, tracked in P&L) —
// it can never push the due negative or hand the customer a phantom credit.
export async function recomputeInvoiceSettlement(db: Db, invoiceId: string) {
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return;

  const [payGroups, expAgg] = await Promise.all([
    db.payment.groupBy({
      by: ["direction"],
      where: { invoiceId },
      _sum: { amount: true },
    }),
    db.expense.aggregate({ where: { invoiceId }, _sum: { amount: true } }),
  ]);

  // A sale is settled by money coming IN; a purchase by money going OUT. An
  // opposite-direction voucher on the bill (e.g. a cash refund on a sales
  // return) is NOT settlement — it is handled separately as a credit note — so
  // it must never be counted here, or it would wrongly inflate amountPaid.
  const settleDir = invoice.type === "PURCHASE" ? "OUT" : "IN";
  const payments = Number(
    payGroups.find((g) => g.direction === settleDir)?._sum.amount ?? 0
  );
  const charges = Number(expAgg._sum.amount ?? 0);
  const total = Number(invoice.total);
  // Cap at total so charges never over-settle the bill.
  let paid = round2(Math.min(payments + charges, total));
  // Paise-level rounding leftovers (≤ ₹0.05) are written off: a customer who
  // has effectively cleared the bill must not linger in the pending list
  // showing ₹0.02 due.
  if (paid > 0 && total - paid > 0 && total - paid <= 0.05) paid = total;
  const status = paid <= 0 ? "UNPAID" : paid >= total ? "PAID" : "PARTIAL";
  await db.invoice.update({
    where: { id: invoiceId },
    data: { amountPaid: paid, status },
  });
}

// Recompute every bill that has at least one linked charge. Bills whose
// charges were recorded before charges counted toward settlement still carry
// the old due amount/status; this brings them in line. Idempotent — the
// recompute derives amountPaid/status from scratch — so it is safe to run on
// every startup.
export async function recomputeAllLinkedInvoiceSettlements(db: Db) {
  const linked = await db.expense.findMany({
    where: { invoiceId: { not: null } },
    select: { invoiceId: true },
    distinct: ["invoiceId"],
  });
  for (const { invoiceId } of linked) {
    await recomputeInvoiceSettlement(db, invoiceId!);
  }
  return linked.length;
}
