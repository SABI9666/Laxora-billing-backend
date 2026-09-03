import { Payment, PaymentDirection, PaymentMethod, Prisma, PrismaClient } from "@prisma/client";

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
    // Only charges that were DEDUCTED from the bill settle it. A charge paid
    // out in cash (to the party or a third party) is the shop's cost — the
    // customer still owes that part — so it must not count. Rows from before
    // `settlement` existed are NULL and keep settling, as they always did.
    db.expense.aggregate({
      where: { invoiceId, OR: [{ settlement: null }, { settlement: "ADJUST" }] },
      _sum: { amount: true },
    }),
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

// ---------------------------------------------------------------------------
// Spreading a party's money across their bills.
//
// A bill's amountPaid only counts vouchers LINKED to that bill, while the
// party ledger counts every voucher to that party. A receipt saved without a
// bill therefore settles the ledger but leaves the bills untouched: the
// customer shows as fully paid (or in advance) on their statement while the
// same bills still sit in the pending list, flagged overdue. Allocating such
// money across the party's open bills, oldest first, keeps both views telling
// the same story.
// ---------------------------------------------------------------------------

// The voucher fields copied onto each bill-linked part.
export type VoucherFields = {
  businessId: string;
  partyId: string;
  direction: PaymentDirection;
  purpose: string | null;
  method: PaymentMethod;
  paymentDate: Date;
  notes: string | null;
};

// Settles `amount` against the party's open bills of the matching type (a
// customer's receipt against their SALE bills, a supplier's payment against
// PURCHASE bills), oldest first, creating one bill-linked voucher per bill it
// reaches and re-deriving that bill's status. Returns whatever could not be
// placed because no open bill was left — the caller decides whether that
// stays on the ledger as an advance.
//
// `onlyInvoiceIds` restricts the pass to bills the accountant picked;
// `excludeInvoiceIds` keeps a follow-up pass off bills already handled.
// `createdAt` lets a backfill keep the original entry timestamp on the parts
// it creates, so the per-day "entries made" counts do not jump.
export async function settleAgainstOpenBills(
  tx: Prisma.TransactionClient,
  voucher: VoucherFields,
  amount: number,
  opts: { onlyInvoiceIds?: string[]; excludeInvoiceIds?: string[]; createdAt?: Date } = {}
): Promise<{ remaining: number; linked: string[]; paymentIds: string[] }> {
  const type = voucher.direction === "IN" ? "SALE" : "PURCHASE";
  const open = await tx.invoice.findMany({
    where: {
      businessId: voucher.businessId,
      partyId: voucher.partyId,
      type,
      status: { in: ["UNPAID", "PARTIAL"] },
      ...(opts.onlyInvoiceIds ? { id: { in: opts.onlyInvoiceIds } } : {}),
      ...(opts.excludeInvoiceIds?.length ? { id: { notIn: opts.excludeInvoiceIds } } : {}),
    },
    orderBy: { invoiceDate: "asc" },
  });

  // Goods returned against a sale already cut what the customer owes on it.
  const returnedMap = new Map<string, number>();
  if (open.length && type === "SALE") {
    const cnRows = await tx.creditNote.groupBy({
      by: ["invoiceId"],
      where: { businessId: voucher.businessId, invoiceId: { in: open.map((i) => i.id) } },
      _sum: { totalAmount: true },
    });
    for (const r of cnRows)
      if (r.invoiceId) returnedMap.set(r.invoiceId, Number(r._sum.totalAmount ?? 0));
  }

  let remaining = round2(amount);
  const linked: string[] = [];
  const paymentIds: string[] = [];
  for (const inv of open) {
    if (remaining <= 0.009) break;
    const due = round2(
      Number(inv.total) - Number(inv.amountPaid) - (returnedMap.get(inv.id) ?? 0)
    );
    if (due <= 0.009) continue;
    const part = round2(Math.min(remaining, due));
    const created = await tx.payment.create({
      data: {
        ...voucher,
        invoiceId: inv.id,
        amount: part,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    });
    await recomputeInvoiceSettlement(tx, inv.id);
    linked.push(inv.id);
    paymentIds.push(created.id);
    remaining = round2(remaining - part);
  }
  return { remaining, linked, paymentIds };
}

// Vouchers that settle bills, as opposed to service income, refunds, cash <->
// bank transfers, expenses and the like — only these are ever allocated.
const SETTLING_VOUCHER_FILTER: Prisma.PaymentWhereInput = {
  OR: [
    { direction: "IN", purpose: "Customer Receipt" },
    // Receipts recorded before vouchers carried a purpose.
    { direction: "IN", purpose: null },
    { direction: "OUT", purpose: "Supplier Payment" },
  ],
};

// Splits one unlinked settling voucher across its party's open bills. When at
// least one bill is reached the voucher is replaced by its bill-linked parts,
// with any unplaceable remainder kept behind on the original row as the
// advance. Returns whether a bill was reached.
async function allocateVoucher(tx: Prisma.TransactionClient, p: Payment): Promise<boolean> {
  if (!p.partyId) return false;
  const { remaining, linked } = await settleAgainstOpenBills(
    tx,
    {
      businessId: p.businessId,
      partyId: p.partyId,
      direction: p.direction,
      purpose: p.purpose,
      method: p.method,
      paymentDate: p.paymentDate,
      notes: p.notes,
    },
    Number(p.amount),
    { createdAt: p.createdAt }
  );
  if (linked.length === 0) return false;
  if (remaining > 0.009) {
    await tx.payment.update({ where: { id: p.id }, data: { amount: remaining } });
  } else {
    await tx.payment.delete({ where: { id: p.id } });
  }
  return true;
}

// Applies whatever a party has paid ahead (unlinked settling vouchers) to
// their open bills. Called when a new bill is raised for them, so an advance
// on the ledger clears the bill straight away rather than leaving it pending
// while the statement says the customer owes nothing. Returns the number of
// vouchers applied.
export async function applyPartyAdvances(
  tx: Prisma.TransactionClient,
  businessId: string,
  partyId: string
): Promise<number> {
  const advances = await tx.payment.findMany({
    where: { businessId, partyId, invoiceId: null, ...SETTLING_VOUCHER_FILTER },
    orderBy: { paymentDate: "asc" },
  });
  let applied = 0;
  for (const p of advances) if (await allocateVoucher(tx, p)) applied++;
  return applied;
}

// Repair for vouchers recorded before receipts were allocated to bills (and
// for any that still arrive unlinked): every settling voucher with a party but
// no bill is split across that party's open bills, oldest first. Vouchers for
// parties with no open bill are left alone as advances. Idempotent — a second
// run finds nothing to do. Returns how many vouchers were allocated.
export async function allocateUnlinkedPayments(
  db: PrismaClient,
  businessId?: string
): Promise<number> {
  const unlinked = await db.payment.findMany({
    where: {
      invoiceId: null,
      partyId: { not: null },
      ...(businessId ? { businessId } : {}),
      ...SETTLING_VOUCHER_FILTER,
    },
    orderBy: { paymentDate: "asc" },
  });

  let allocated = 0;
  for (const p of unlinked) {
    if (await db.$transaction((tx) => allocateVoucher(tx, p))) allocated++;
  }
  return allocated;
}

// Re-derives amountPaid/status for every bill still marked PARTIAL. Bills
// settled before the paise write-off rule existed can linger at ₹0.01 due;
// this brings them to PAID. Idempotent. Returns how many bills were checked.
export async function recomputePartialInvoiceSettlements(
  db: Db,
  businessId?: string
): Promise<number> {
  const bills = await db.invoice.findMany({
    where: { status: "PARTIAL", ...(businessId ? { businessId } : {}) },
    select: { id: true },
  });
  for (const { id } of bills) await recomputeInvoiceSettlement(db, id);
  return bills.length;
}

// Everything above in one call: allocate stray vouchers, then tidy the
// leftovers. Safe on every boot and on demand from the admin panel.
export async function reconcilePayments(db: PrismaClient, businessId?: string) {
  const allocated = await allocateUnlinkedPayments(db, businessId);
  const rechecked = await recomputePartialInvoiceSettlements(db, businessId);
  return { allocated, rechecked };
}
