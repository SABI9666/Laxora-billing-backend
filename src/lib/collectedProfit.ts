import { Prisma, PrismaClient } from "@prisma/client";

type Db = Prisma.TransactionClient | PrismaClient;

// ---------------------------------------------------------------------------
// Profit on collected money.
//
// A sale only earns its profit as the customer pays for it: a bill raised in
// September and paid in October earns its profit in October. Each rupee
// settled on a bill carries that bill's margin —
//
//   margin = (net sales ex-GST − cost of goods kept) / net bill value incl. GST
//
// so profit = money settled × margin, booked on the day the money came in.
// Refunds paid back on a bill reverse it the same way. Charges adjusted
// against a bill (no cash, but the bill counts as settled by them) settle it
// too; they are deducted again as expenses by the caller, exactly once.
//
// Summed over a bill's life this always comes back to the bill's full profit
// once it is paid — the same rule the invoice list and the customer ledger
// use per bill.
// ---------------------------------------------------------------------------

export type CollectionEvent = {
  date: Date;
  invoiceId: string;
  // Money settled (+) or paid back (−), incl. GST.
  amount: number;
  // Profit carried by that money, ex-GST.
  profit: number;
  kind: "RECEIPT" | "REFUND" | "ADJUSTED";
};

export async function collectionEvents(
  db: Db,
  businessId: string,
  from: Date,
  to: Date // exclusive
): Promise<CollectionEvent[]> {
  const [payments, adjusted] = await Promise.all([
    db.payment.findMany({
      where: {
        businessId,
        invoiceId: { not: null },
        paymentDate: { gte: from, lt: to },
        invoice: { type: "SALE" },
      },
      select: { invoiceId: true, amount: true, direction: true, paymentDate: true },
    }),
    // Charges that settled a sale bill instead of cash (ADJUST, or older rows
    // with no settlement recorded — see recomputeInvoiceSettlement).
    db.expense.findMany({
      where: {
        businessId,
        invoiceId: { not: null },
        date: { gte: from, lt: to },
        OR: [{ settlement: null }, { settlement: "ADJUST" }],
      },
      select: { invoiceId: true, amount: true, date: true },
    }),
  ]);

  const ids = [
    ...new Set([...payments.map((p) => p.invoiceId!), ...adjusted.map((x) => x.invoiceId!)]),
  ];
  if (!ids.length) return [];
  const margin = await billMargins(db, businessId, ids);

  const events: CollectionEvent[] = [];
  for (const p of payments) {
    const m = margin.get(p.invoiceId!);
    if (m === undefined) continue; // not a sale bill
    const sign = p.direction === "IN" ? 1 : -1;
    const amount = sign * Number(p.amount);
    events.push({
      date: p.paymentDate,
      invoiceId: p.invoiceId!,
      amount,
      profit: amount * m,
      kind: sign > 0 ? "RECEIPT" : "REFUND",
    });
  }
  for (const x of adjusted) {
    const m = margin.get(x.invoiceId!);
    if (m === undefined) continue;
    const amount = Number(x.amount);
    events.push({
      date: x.date,
      invoiceId: x.invoiceId!,
      amount,
      profit: amount * m,
      kind: "ADJUSTED",
    });
  }
  return events;
}

// Profit per rupee of bill value, for each sale bill (after returns).
async function billMargins(
  db: Db,
  businessId: string,
  ids: string[]
): Promise<Map<string, number>> {
  const [bills, cogsRows, cnRows] = await Promise.all([
    db.invoice.findMany({
      where: { businessId, id: { in: ids }, type: "SALE" },
      select: { id: true, total: true, subtotal: true, discount: true },
    }),
    db.$queryRaw<Array<{ invoiceid: string; cogs: number }>>(Prisma.sql`
      SELECT ii."invoiceId" AS invoiceid,
             COALESCE(SUM(ii.quantity * i."purchasePrice" / NULLIF(1 + i."taxRate" / 100, 0)), 0)::float AS cogs
      FROM "InvoiceItem" ii JOIN "Item" i ON i.id = ii."itemId"
      WHERE ii."invoiceId" IN (${Prisma.join(ids)})
      GROUP BY 1
    `),
    db.creditNote.groupBy({
      by: ["invoiceId"],
      where: { businessId, invoiceId: { in: ids } },
      _sum: { netAmount: true, cogs: true, totalAmount: true },
    }),
  ]);
  const cogsMap = new Map(cogsRows.map((r) => [r.invoiceid, Number(r.cogs)]));
  const cnMap = new Map(cnRows.map((r) => [r.invoiceId, r._sum]));
  const out = new Map<string, number>();
  for (const b of bills) {
    const cn = cnMap.get(b.id);
    const gross =
      Number(b.subtotal) -
      Number(b.discount) -
      Number(cn?.netAmount ?? 0) -
      ((cogsMap.get(b.id) ?? 0) - Number(cn?.cogs ?? 0));
    const netValue = Number(b.total) - Number(cn?.totalAmount ?? 0);
    out.set(b.id, netValue > 0.009 ? gross / netValue : 0);
  }
  return out;
}

// Totals for one period.
export function summariseCollections(events: CollectionEvent[]) {
  let received = 0;
  let refunded = 0;
  let adjusted = 0;
  let profit = 0;
  for (const e of events) {
    if (e.kind === "RECEIPT") received += e.amount;
    else if (e.kind === "REFUND") refunded += -e.amount;
    else adjusted += e.amount;
    profit += e.profit;
  }
  return { received, refunded, adjusted, settled: received - refunded + adjusted, profit };
}
