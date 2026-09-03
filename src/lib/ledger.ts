import { Prisma, PrismaClient } from "@prisma/client";

type Db = Prisma.TransactionClient | PrismaClient;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const inr = (n: number) =>
  "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export type LedgerEntry = {
  date: Date;
  kind: string;
  ref: string;
  // Free-text detail under the line: a return's reason, a charge's note, how
  // something was settled.
  note?: string;
  debit: number;
  credit: number;
};

export type LedgerTotals = {
  billed: number;
  received: number;
  refunded: number;
  returns: number;
  chargesAdjusted: number;
  chargesGiven: number;
};

// Builds a party's statement of account: every event that changed what they
// owe, in date order, with a running balance. Shared by the shop and admin
// ledgers so the two can never drift apart.
//
// Debits add to what the party owes, credits reduce it (for a supplier the
// roles are the same, seen from the shop's side):
//   Sale Invoice           the bill at the value it was raised for
//   Items added            lines put on the bill later ("+ Add")
//   Payment                money received against a bill (or unallocated)
//   Sales Return           goods taken back — reduces what is owed
//   Return refund          cash handed back on a return — owed again
//   Exchange: items taken  replacement goods on the same bill
//   <Charge> …             bill-linked charges: adjusted, allowed/paid, or memo
export async function buildPartyLedger(
  db: Db,
  party: {
    id: string;
    businessId: string;
    type: "CUSTOMER" | "SUPPLIER";
    openingBalance: Prisma.Decimal | number | string;
  }
): Promise<{
  ledger: Array<LedgerEntry & { balance: number }>;
  totals: LedgerTotals;
  closingBalance: number;
}> {
  const businessId = party.businessId;
  const invoiceType: "SALE" | "PURCHASE" = party.type === "CUSTOMER" ? "SALE" : "PURCHASE";
  // A payment in the party's usual direction (customer pays IN, we pay a
  // supplier OUT) reduces what's owed; the opposite direction is a refund.
  const reduceDir = party.type === "CUSTOMER" ? "IN" : "OUT";

  const [invoices, payments, creditNotes] = await Promise.all([
    db.invoice.findMany({
      where: { partyId: party.id, businessId, type: invoiceType },
      select: {
        id: true,
        invoiceNumber: true,
        invoiceDate: true,
        createdAt: true,
        total: true,
        amountPaid: true,
        items: { select: { id: true, amount: true, taxRate: true, createdAt: true } },
      },
    }),
    db.payment.findMany({
      where: { partyId: party.id, businessId },
      select: {
        paymentDate: true,
        amount: true,
        method: true,
        invoiceId: true,
        direction: true,
        purpose: true,
        notes: true,
      },
    }),
    db.creditNote.findMany({
      where: { partyId: party.id, businessId },
      select: {
        date: true,
        totalAmount: true,
        invoiceNumber: true,
        invoiceId: true,
        reason: true,
        refundMethod: true,
        exchangeLines: true,
      },
    }),
  ]);

  const totals: LedgerTotals = {
    billed: 0,
    received: 0,
    refunded: 0,
    returns: 0,
    chargesAdjusted: 0,
    chargesGiven: 0,
  };
  const entries: LedgerEntry[] = [];
  const billNo = new Map(invoices.map((i) => [i.id, i.invoiceNumber]));

  // ---- Bills: the original value on the bill's date, later additions and
  // exchange replacements as their own dated lines. ------------------------
  type ExchangeLine = { invoiceItemId?: string; amount?: number; taxRate?: number };
  const exchangeItemIds = new Set<string>();
  for (const cn of creditNotes)
    for (const l of (Array.isArray(cn.exchangeLines) ? cn.exchangeLines : []) as ExchangeLine[])
      if (l.invoiceItemId) exchangeItemIds.add(l.invoiceItemId);

  const gross = (amount: Prisma.Decimal | number, taxRate: Prisma.Decimal | number) =>
    Number(amount) * (1 + Number(taxRate) / 100);

  for (const inv of invoices) {
    totals.billed += Number(inv.total);
    // Anything stamped well after the bill was created was added later.
    const cutoff = inv.createdAt.getTime() + 10 * 60 * 1000;
    let laterGross = 0;
    const byDay = new Map<string, { date: Date; gross: number; count: number }>();
    for (const it of inv.items) {
      const g = gross(it.amount, it.taxRate);
      if (exchangeItemIds.has(it.id)) {
        laterGross += g; // shown under the exchange, below
        continue;
      }
      if (it.createdAt.getTime() > cutoff) {
        laterGross += g;
        const k = dayKey(it.createdAt);
        const cur = byDay.get(k) ?? { date: it.createdAt, gross: 0, count: 0 };
        cur.gross += g;
        cur.count += 1;
        if (it.createdAt < cur.date) cur.date = it.createdAt;
        byDay.set(k, cur);
      }
    }
    entries.push({
      date: inv.invoiceDate,
      kind: invoiceType === "SALE" ? "Sale Invoice" : "Purchase Invoice",
      ref: inv.invoiceNumber,
      debit: round2(Number(inv.total) - laterGross),
      credit: 0,
    });
    for (const add of byDay.values()) {
      entries.push({
        date: add.date,
        kind: "Items added",
        ref: inv.invoiceNumber,
        note: `${add.count} line${add.count === 1 ? "" : "s"} added to the bill later`,
        debit: round2(add.gross),
        credit: 0,
      });
    }
  }

  // ---- Payments and refunds. -----------------------------------------------
  for (const p of payments) {
    const reduces = p.direction === reduceDir;
    const amt = Number(p.amount);
    if (reduces) totals.received += amt;
    else totals.refunded += amt;
    const isReturnRefund = !reduces && p.purpose === "Sales Return Refund";
    entries.push({
      date: p.paymentDate,
      kind: reduces
        ? `Payment (${p.method})`
        : isReturnRefund
        ? `Return refund (${p.method})`
        : `Refund (${p.method})`,
      ref: (p.invoiceId && billNo.get(p.invoiceId)) || "",
      note: isReturnRefund
        ? "money handed back on a return — this amount is owed again"
        : p.notes ?? undefined,
      debit: reduces ? 0 : amt,
      credit: reduces ? amt : 0,
    });
  }

  // ---- Returns and exchanges. ----------------------------------------------
  for (const cn of creditNotes) {
    const amt = Number(cn.totalAmount);
    totals.returns += amt;
    const lines = (Array.isArray(cn.exchangeLines) ? cn.exchangeLines : []) as ExchangeLine[];
    const isExchange = lines.length > 0;
    const bits: string[] = [];
    if (cn.reason) bits.push(cn.reason);
    bits.push(
      cn.refundMethod
        ? `refunded via ${cn.refundMethod.toLowerCase()} — see the refund line`
        : "reduces what is owed on the bill"
    );
    entries.push({
      date: cn.date,
      kind: isExchange ? "Sales Return (exchange)" : "Sales Return",
      ref: cn.invoiceNumber ?? "",
      note: bits.join(" · "),
      debit: 0,
      credit: amt,
    });
    if (isExchange) {
      const taken = lines.reduce((s, l) => s + gross(l.amount ?? 0, l.taxRate ?? 0), 0);
      entries.push({
        date: cn.date,
        kind: "Exchange: items taken",
        ref: cn.invoiceNumber ?? "",
        note: `${lines.length} replacement line${lines.length === 1 ? "" : "s"} put on the same bill`,
        debit: round2(taken),
        credit: 0,
      });
    }
  }

  // ---- Bill-linked charges. ------------------------------------------------
  // Every bill-linked charge (commission, electrician, transport, …) gets its
  // own line, named by its category and carrying its note. Deductions credit
  // only the portion that actually cleared the bill: amountPaid is capped at
  // the bill total, so (amountPaid − payments on that bill) is the settling
  // budget, allocated across the bill's charges in date order; any remainder
  // is the shop's own cost and shown as a memo. Money handed to the party
  // itself (a commission given to the electrician) is the standard
  // "allowed / paid" pair — net zero, both visible. Money paid to a third
  // party is a memo only.
  const billCharges = invoices.length
    ? await db.expense.findMany({
        where: { businessId, invoiceId: { in: invoices.map((i) => i.id) } },
        select: {
          invoiceId: true,
          date: true,
          amount: true,
          category: true,
          note: true,
          method: true,
          settlement: true,
        },
      })
    : [];
  type Charge = (typeof billCharges)[number];
  const chargesByInv = new Map<string, Charge[]>();
  for (const x of billCharges) {
    const arr = chargesByInv.get(x.invoiceId!) ?? [];
    arr.push(x);
    chargesByInv.set(x.invoiceId!, arr);
  }
  const linkedPaid = new Map<string, number>();
  for (const p of payments)
    if (p.invoiceId && p.direction === reduceDir)
      linkedPaid.set(p.invoiceId, (linkedPaid.get(p.invoiceId) ?? 0) + Number(p.amount));

  const isPayout = (c: Charge) =>
    c.settlement === "PAID_TO_PARTY" || c.settlement === "PAID_TO_OTHER";
  const name = (c: Charge) => (c.category === "Other" ? "Other charge" : c.category);

  for (const inv of invoices) {
    const charges = chargesByInv.get(inv.id);
    if (!charges) continue;
    const sorted = [...charges].sort((a, b) => a.date.getTime() - b.date.getTime());

    let budget = Math.max(0, Number(inv.amountPaid) - (linkedPaid.get(inv.id) ?? 0));
    for (const c of sorted) {
      if (isPayout(c)) continue;
      const amount = Number(c.amount);
      const settled = round2(Math.min(amount, budget));
      budget = round2(budget - settled);
      totals.chargesAdjusted += settled;
      const unsettled = round2(amount - settled);
      const bits: string[] = [];
      if (c.note) bits.push(c.note);
      bits.push(
        c.method ? `paid out via ${c.method.toLowerCase()}` : "adjusted against the bill, no cash paid"
      );
      if (unsettled > 0.009) {
        bits.push(
          settled > 0.009
            ? `${inr(settled)} of ${inr(amount)} adjusted against the bill; the remaining ${inr(
                unsettled
              )} is the shop's own cost as the bill was otherwise paid`
            : `${inr(amount)} is the shop's own cost — the bill was already paid in full, so nothing was adjusted against it`
        );
      }
      entries.push({
        date: c.date,
        kind: name(c),
        ref: inv.invoiceNumber,
        note: bits.join(" · "),
        debit: 0,
        credit: settled,
      });
    }

    for (const c of sorted) {
      if (!isPayout(c)) continue;
      const amount = Number(c.amount);
      const via = (c.method ?? "CASH").toUpperCase();
      if (c.settlement === "PAID_TO_PARTY") {
        totals.chargesGiven += amount;
        entries.push({
          date: c.date,
          kind: `${name(c)} allowed`,
          ref: inv.invoiceNumber,
          note: [c.note, "allowed out of the bill value"].filter(Boolean).join(" · "),
          debit: 0,
          credit: amount,
        });
        entries.push({
          date: c.date,
          kind: `${name(c)} paid (${via})`,
          ref: inv.invoiceNumber,
          note: `given to party via ${via.toLowerCase()}`,
          debit: amount,
          credit: 0,
        });
      } else {
        entries.push({
          date: c.date,
          kind: name(c),
          ref: inv.invoiceNumber,
          note: [
            c.note,
            `${inr(amount)} paid via ${via.toLowerCase()} to a third party — the shop's cost, not this party's account`,
          ]
            .filter(Boolean)
            .join(" · "),
          debit: 0,
          credit: 0,
        });
      }
    }
  }

  entries.sort((a, b) => a.date.getTime() - b.date.getTime());

  let balance = Number(party.openingBalance);
  const ledger = entries.map((e) => {
    balance += e.debit - e.credit;
    return {
      date: e.date,
      kind: e.kind,
      ref: e.ref,
      note: e.note ?? "",
      debit: round2(e.debit),
      credit: round2(e.credit),
      balance: round2(balance),
    };
  });

  return {
    ledger,
    totals: {
      billed: round2(totals.billed),
      received: round2(totals.received),
      refunded: round2(totals.refunded),
      returns: round2(totals.returns),
      chargesAdjusted: round2(totals.chargesAdjusted),
      chargesGiven: round2(totals.chargesGiven),
    },
    closingBalance: round2(balance),
  };
}
