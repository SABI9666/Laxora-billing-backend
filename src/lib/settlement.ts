import { Prisma, PrismaClient } from "@prisma/client";

type Db = Prisma.TransactionClient | PrismaClient;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// A bill's settled amount is everything recorded against it: payments received
// PLUS bill-linked charges (commission, damage, transport, …) that the shop
// absorbs instead of collecting from the customer. Both reduce what is still
// due, so amountPaid/status are always recomputed from scratch here whenever a
// payment or a bill-linked expense is created or deleted.
export async function recomputeInvoiceSettlement(db: Db, invoiceId: string) {
  const [payAgg, expAgg, invoice] = await Promise.all([
    db.payment.aggregate({ where: { invoiceId }, _sum: { amount: true } }),
    db.expense.aggregate({ where: { invoiceId }, _sum: { amount: true } }),
    db.invoice.findUnique({ where: { id: invoiceId } }),
  ]);
  if (!invoice) return;

  const paid = round2(
    Number(payAgg._sum.amount ?? 0) + Number(expAgg._sum.amount ?? 0)
  );
  const total = Number(invoice.total);
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
