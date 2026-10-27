import { Prisma, PrismaClient } from "@prisma/client";

// ---------------------------------------------------------------------------
// Financial-year bill numbers.
//
// Shops number their bills by Indian financial year: "26-27" for Apr 2026 –
// Mar 2027, followed by a running number — 26-27847, 26-27999, 26-271000.
// Some shops were set up with the prefix "26-" and the counter started at
// 27001, so the year's "27" lived inside the counter. Once that counter
// passed 27999 the next bill came out as 26-28000 — the year looked wrong.
//
// The fix keeps the year in the prefix where it belongs: prefix "26-27" and
// the counter continues from 1000, so 26-27999 is followed by 26-271000.
// ---------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;

// For a "YY-" prefix whose counter carries the year's second half
// (27xxx under "26-"), what the series becomes. Null when the prefix is not
// that shape or the counter has not run past the year's thousand.
export function fySplit(prefix: string | null | undefined, seq: number) {
  const m = /^(\d{2})-$/.exec(prefix ?? "");
  if (!m) return null;
  const yy = Number(m[1]);
  const tail = (yy + 1) % 100;
  const base = tail * 1000; // 27000 under "26-"
  if (seq < base + 1000) return null; // still inside 27001 … 27999
  return {
    prefix: `${m[1]}-${String(tail).padStart(2, "0")}`,
    base,
    seq: seq - base,
  };
}

const fmt = (prefix: string, n: number) => `${prefix}${String(n).padStart(4, "0")}`;

// Moves one shop onto the "YY-YY" prefix and renumbers the bills that already
// came out past the year's thousand (26-28000 → 26-271000, …), everywhere the
// number is written down. Returns how many bills were renumbered, or null when
// the shop did not need it.
export async function convertShopSeries(tx: Tx, businessId: string): Promise<number | null> {
  const biz = await tx.business.findUnique({
    where: { id: businessId },
    select: { saleInvoicePrefix: true, nextSaleNo: true },
  });
  if (!biz) return null;
  // The next number would be past the year's thousand, or already is.
  const split = fySplit(biz.saleInvoicePrefix, Math.max(biz.nextSaleNo, 0));
  if (!split) return null;
  const oldPrefix = biz.saleInvoicePrefix!;

  // Claim the change on the business row first. A bill being raised at the
  // same moment waits on this row, and a second server instance doing the
  // same repair finds nothing left to change.
  const claimed = await tx.business.updateMany({
    where: { id: businessId, saleInvoicePrefix: oldPrefix, nextSaleNo: biz.nextSaleNo },
    data: { saleInvoicePrefix: split.prefix, nextSaleNo: biz.nextSaleNo - split.base },
  });
  if (claimed.count === 0) return null;

  // Bills already issued past the thousand.
  const bills = await tx.invoice.findMany({
    where: { businessId, type: "SALE", invoiceNumber: { startsWith: oldPrefix } },
    select: { id: true, invoiceNumber: true },
  });
  const moves: { id: string; from: string; to: string }[] = [];
  for (const b of bills) {
    const rest = b.invoiceNumber.slice(oldPrefix.length);
    if (!/^\d+$/.test(rest)) continue;
    const n = Number(rest);
    if (n < split.base + 1000) continue; // 26-27xxx stays as it is
    moves.push({ id: b.id, from: b.invoiceNumber, to: fmt(split.prefix, n - split.base) });
  }
  if (!moves.length) return 0;

  const clash = await tx.invoice.findFirst({
    where: { businessId, type: "SALE", invoiceNumber: { in: moves.map((m) => m.to) } },
    select: { invoiceNumber: true },
  });
  if (clash) throw new Error(`Bill number ${clash.invoiceNumber} already exists — not renumbering`);

  for (const m of moves) {
    await tx.invoice.update({ where: { id: m.id }, data: { invoiceNumber: m.to } });
    await tx.creditNote.updateMany({
      where: { businessId, invoiceId: m.id },
      data: { invoiceNumber: m.to },
    });
    await tx.stockMovement.updateMany({
      where: { businessId, reference: m.from },
      data: { reference: m.to },
    });
    await tx.invoiceDeleteRequest.updateMany({
      where: { businessId, invoiceNumber: m.from },
      data: { invoiceNumber: m.to },
    });
    await tx.returnDeleteRequest.updateMany({
      where: { businessId, invoiceNumber: m.from },
      data: { invoiceNumber: m.to },
    });
    // Voucher and charge notes that quote the number ("Refund for return on …").
    await tx.$executeRaw`
      UPDATE "Payment" SET notes = replace(notes, ${m.from}, ${m.to})
      WHERE "businessId" = ${businessId} AND notes LIKE ${"%" + m.from + "%"}`;
    await tx.$executeRaw`
      UPDATE "Expense" SET note = replace(note, ${m.from}, ${m.to})
      WHERE "businessId" = ${businessId} AND note LIKE ${"%" + m.from + "%"}`;
  }
  return moves.length;
}

// Startup repair: every shop whose counter already ran past its year's
// thousand. Idempotent — once moved, a shop no longer matches.
export async function fixFinancialYearSeries(db: PrismaClient) {
  const shops = await db.business.findMany({
    where: { saleInvoicePrefix: { not: null } },
    select: { id: true, name: true, saleInvoicePrefix: true, nextSaleNo: true },
  });
  const done: string[] = [];
  for (const s of shops) {
    if (!fySplit(s.saleInvoicePrefix, s.nextSaleNo)) continue;
    const n = await db.$transaction((tx) => convertShopSeries(tx, s.id));
    if (n !== null) done.push(`${s.name}: prefix → ${fySplit(s.saleInvoicePrefix, s.nextSaleNo)!.prefix}, ${n} bill(s) renumbered`);
  }
  return done;
}
