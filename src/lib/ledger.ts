import { Prisma, PrismaClient } from "@prisma/client";

type Db = Prisma.TransactionClient | PrismaClient;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const inr = (n: number) =>
  "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

// One goods line shown under a ledger entry: what was billed, added, returned
// or taken in exchange. Rate and amount are what the customer pays (incl.
// GST), so the lines add up to the entry's figure.
export type LedgerItem = {
  description: string;
  quantity: number;
  unit: string;
  taxRate: number;
  rate: number;
  amount: number;
};

// One row of the bill-wise summary at the foot of the statement: how each
// bill stands after everything that happened on it.
export type LedgerBill = {
  invoiceId: string;
  invoiceNumber: string;
  date: Date;
  original: number; // value when raised
  added: number; // lines put on later (incl. exchange replacements)
  total: number; // current bill value
  returned: number;
  net: number; // total − returned: what the party finally has to pay
  received: number; // settling payments on this bill
  refunded: number; // money handed back on this bill
  chargesAdjusted: number; // bill-linked charges deducted from what is owed
  due: number;
  status: "PAID" | "PARTIAL" | "UNPAID" | "EXCESS";
};

export type LedgerEntry = {
  date: Date;
  kind: string;
  ref: string;
  // Free-text detail under the line: a return's reason, a charge's note, how
  // something was settled.
  note?: string;
  // Goods behind the figure, when there are any.
  items?: LedgerItem[];
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
  bills: LedgerBill[];
  closingBalance: number;
}> {
  const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;
  const businessId = party.businessId;
  const invoiceType: "SALE" | "PURCHASE" = party.type === "CUSTOMER" ? "SALE" : "PURCHASE";
  // A payment in the party's usual direction (customer pays IN, we pay a
  // supplier OUT) reduces what's owed; the opposite direction is a refund.
  const reduceDir = party.type === "CUSTOMER" ? "IN" : "OUT";

  const invoiceSelect = {
    id: true,
    invoiceNumber: true,
    invoiceDate: true,
    createdAt: true,
    total: true,
    amountPaid: true,
  } as const;
  const itemSelect = {
    id: true,
    itemId: true,
    description: true,
    quantity: true,
    rate: true,
    taxRate: true,
    amount: true,
    item: { select: { unit: true } },
  } as const;
  type InvoiceRow = Prisma.InvoiceGetPayload<{ select: typeof invoiceSelect }> & {
    items: Array<Prisma.InvoiceItemGetPayload<{ select: typeof itemSelect }> & { createdAt: Date }>;
  };

  // InvoiceItem.createdAt is applied by hand (prisma/invoice-item-created-at.sql).
  // Until it exists on this database the ledger must still open, so fall
  // back to treating every line as part of the original bill.
  const loadInvoices = async (): Promise<InvoiceRow[]> => {
    const where = { partyId: party.id, businessId, type: invoiceType };
    try {
      return await db.invoice.findMany({
        where,
        select: { ...invoiceSelect, items: { select: { ...itemSelect, createdAt: true } } },
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== "P2022" && code !== "P2010") throw err;
      const rows = await db.invoice.findMany({
        where,
        select: { ...invoiceSelect, items: { select: itemSelect } },
      });
      return rows.map((r) => ({
        ...r,
        items: r.items.map((it) => ({ ...it, createdAt: r.createdAt })),
      }));
    }
  };

  const [invoices, payments, creditNotes] = await Promise.all([
    loadInvoices(),
    db.payment.findMany({
      where: { partyId: party.id, businessId },
      select: {
        id: true,
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
        refundPaymentId: true,
        collectPaymentId: true,
        lines: true,
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
  // exchange replacements as their own dated lines, each listing its goods. --
  type ExchangeLine = {
    invoiceItemId?: string;
    itemId?: string | null;
    quantity?: number;
    rate?: number;
    taxRate?: number;
    amount?: number;
  };
  type ReturnLine = {
    invoiceItemId?: string;
    itemId?: string | null;
    quantity?: number;
    rate?: number;
    taxRate?: number;
  };
  const asLines = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

  const exchangeItemIds = new Set<string>();
  for (const cn of creditNotes)
    for (const l of asLines<ExchangeLine>(cn.exchangeLines))
      if (l.invoiceItemId) exchangeItemIds.add(l.invoiceItemId);

  const gross = (amount: Prisma.Decimal | number, taxRate: Prisma.Decimal | number) =>
    Number(amount) * (1 + Number(taxRate) / 100);

  type Line = InvoiceRow["items"][number];
  const lineItem = (it: Line): LedgerItem => ({
    description: it.description,
    quantity: round3(Number(it.quantity)),
    unit: it.item?.unit || "PCS",
    taxRate: Number(it.taxRate),
    rate: round2(gross(it.rate, it.taxRate)),
    amount: round2(gross(it.amount, it.taxRate)),
  });
  // Per-bill figures for the summary at the foot of the statement.
  const billStat = new Map<
    string,
    { original: number; added: number; returned: number; received: number; refunded: number; chargesAdjusted: number }
  >();
  const stat = (id: string) => {
    let x = billStat.get(id);
    if (!x) {
      x = { original: 0, added: 0, returned: 0, received: 0, refunded: 0, chargesAdjusted: 0 };
      billStat.set(id, x);
    }
    return x;
  };

  // Bill lines by id so returns and exchanges can name the goods they refer to.
  const lineById = new Map<string, Line>();
  for (const inv of invoices) for (const it of inv.items) lineById.set(it.id, it);

  // Old return notes only carry an itemId — resolve those to product names.
  const wantNames = new Set<string>();
  for (const cn of creditNotes)
    for (const l of asLines<ReturnLine>(cn.lines))
      if (!(l.invoiceItemId && lineById.has(l.invoiceItemId)) && l.itemId) wantNames.add(l.itemId);
  const itemName = new Map<string, string>();
  const itemUnit = new Map<string, string>();
  if (wantNames.size) {
    const named = await db.item.findMany({
      where: { id: { in: [...wantNames] } },
      select: { id: true, name: true, unit: true },
    });
    for (const n of named) {
      itemName.set(n.id, n.name);
      itemUnit.set(n.id, n.unit);
    }
  }
  const unitOf = (l: { invoiceItemId?: string; itemId?: string | null }) =>
    (l.invoiceItemId && lineById.get(l.invoiceItemId)?.item?.unit) ||
    (l.itemId && itemUnit.get(l.itemId)) ||
    "PCS";
  const describe = (l: { invoiceItemId?: string; itemId?: string | null }, fallback: string) =>
    (l.invoiceItemId && lineById.get(l.invoiceItemId)?.description) ||
    (l.itemId && itemName.get(l.itemId)) ||
    fallback;

  const countNote = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

  for (const inv of invoices) {
    totals.billed += Number(inv.total);
    // Anything stamped well after the bill was created was added later.
    const cutoff = inv.createdAt.getTime() + 10 * 60 * 1000;
    let laterGross = 0;
    const original: LedgerItem[] = [];
    const byDay = new Map<string, { date: Date; gross: number; items: LedgerItem[] }>();
    for (const it of inv.items) {
      const g = gross(it.amount, it.taxRate);
      if (exchangeItemIds.has(it.id)) {
        laterGross += g; // shown under the exchange, below
        continue;
      }
      if (it.createdAt.getTime() > cutoff) {
        laterGross += g;
        const k = dayKey(it.createdAt);
        const cur = byDay.get(k) ?? { date: it.createdAt, gross: 0, items: [] };
        cur.gross += g;
        cur.items.push(lineItem(it));
        if (it.createdAt < cur.date) cur.date = it.createdAt;
        byDay.set(k, cur);
        continue;
      }
      original.push(lineItem(it));
    }
    const st = stat(inv.id);
    st.original = round2(Number(inv.total) - laterGross);
    st.added = round2(laterGross);
    entries.push({
      date: inv.invoiceDate,
      kind: invoiceType === "SALE" ? "Sale Invoice" : "Purchase Invoice",
      ref: inv.invoiceNumber,
      note: original.length
        ? `${countNote(original.length, "item")} billed${
            laterGross > 0.009 ? ` — bill later grew by ${inr(round2(laterGross))}, see below` : ""
          }`
        : undefined,
      items: original,
      debit: st.original,
      credit: 0,
    });
    for (const add of byDay.values()) {
      entries.push({
        date: add.date,
        kind: "Items added",
        ref: inv.invoiceNumber,
        note: `${countNote(add.items.length, "item")} added to the bill after it was raised`,
        items: add.items,
        debit: round2(add.gross),
        credit: 0,
      });
    }
  }

  // ---- Payments and refunds. -----------------------------------------------
  const exchangeReceiptIds = new Set(
    creditNotes.map((c) => c.collectPaymentId).filter((x): x is string => !!x)
  );
  const returnRefundIds = new Set(
    creditNotes.map((c) => c.refundPaymentId).filter((x): x is string => !!x)
  );
  for (const p of payments) {
    const reduces = p.direction === reduceDir;
    const amt = Number(p.amount);
    if (reduces) totals.received += amt;
    else totals.refunded += amt;
    if (p.invoiceId && billNo.has(p.invoiceId)) {
      if (reduces) stat(p.invoiceId).received += amt;
      else stat(p.invoiceId).refunded += amt;
    }
    const isReturnRefund =
      !reduces && (returnRefundIds.has(p.id) || p.purpose === "Sales Return Refund");
    const isExchangeDiff = reduces && exchangeReceiptIds.has(p.id);
    const kind = reduces
      ? isExchangeDiff
        ? `Exchange difference received (${p.method})`
        : `Payment (${p.method})`
      : isReturnRefund
      ? `Return refund (${p.method})`
      : `Refund (${p.method})`;
    const note = isReturnRefund
      ? "money handed back on a return — this amount is owed again"
      : isExchangeDiff
      ? "extra paid because the replacement goods cost more than the goods returned"
      : [
          reduces
            ? p.invoiceId
              ? "received against this bill"
              : "on account — not tied to a bill, adjusts the running balance"
            : "money handed back to the party",
          p.notes || undefined,
        ]
          .filter(Boolean)
          .join(" · ");
    entries.push({
      date: p.paymentDate,
      kind,
      ref: (p.invoiceId && billNo.get(p.invoiceId)) || "",
      note,
      debit: reduces ? 0 : amt,
      credit: reduces ? amt : 0,
    });
  }

  // ---- Returns and exchanges. ----------------------------------------------
  // A plain return is one credit line listing the goods that came back. An
  // exchange is that same line followed by a debit line for the replacement
  // goods, and both spell out the difference and how it was settled.
  for (const cn of creditNotes) {
    const amt = Number(cn.totalAmount);
    totals.returns += amt;
    if (cn.invoiceId && billNo.has(cn.invoiceId)) stat(cn.invoiceId).returned += amt;
    const exchLines = asLines<ExchangeLine>(cn.exchangeLines);
    const isExchange = exchLines.length > 0;

    const returnedItems: LedgerItem[] = asLines<ReturnLine>(cn.lines).map((l) => {
      const qty = Number(l.quantity ?? 0);
      const rate = gross(l.rate ?? 0, l.taxRate ?? 0);
      return {
        description: describe(l, "Returned goods"),
        quantity: round3(qty),
        unit: unitOf(l),
        taxRate: Number(l.taxRate ?? 0),
        rate: round2(rate),
        amount: round2(qty * rate),
      };
    });

    const takenItems: LedgerItem[] = exchLines.map((l) => {
      const line = l.invoiceItemId ? lineById.get(l.invoiceItemId) : undefined;
      if (line) return lineItem(line);
      const qty = Number(l.quantity ?? 0);
      const rate = gross(l.rate ?? 0, l.taxRate ?? 0);
      return {
        description: describe(l, "Replacement goods"),
        quantity: round3(qty),
        unit: unitOf(l),
        taxRate: Number(l.taxRate ?? 0),
        rate: round2(rate),
        amount: round2(l.amount != null ? gross(l.amount, l.taxRate ?? 0) : qty * rate),
      };
    });
    const taken = round2(takenItems.reduce((s, i) => s + i.amount, 0));
    const difference = round2(taken - amt);

    const bits: string[] = [];
    if (returnedItems.length)
      bits.push(
        `${countNote(returnedItems.length, "item")} taken back worth ${inr(round2(amt))}`
      );
    if (cn.reason) bits.push(`reason: ${cn.reason}`);
    if (isExchange) {
      bits.push(`exchanged for ${countNote(takenItems.length, "item")} worth ${inr(taken)} — next line`);
      if (difference > 0.009)
        bits.push(
          `party pays ${inr(difference)} more${
            cn.collectPaymentId ? " (collected — see the receipt)" : " (added to what is owed)"
          }`
        );
      else if (difference < -0.009)
        bits.push(
          `party is owed ${inr(-difference)} back${
            cn.refundMethod
              ? ` (refunded via ${cn.refundMethod.toLowerCase()} — see the refund line)`
              : " (adjusted against the bill)"
          }`
        );
      else bits.push("same value — nothing to pay either way");
    } else {
      bits.push(
        cn.refundMethod
          ? `refunded via ${cn.refundMethod.toLowerCase()} — see the refund line`
          : "adjusted against the bill, no money handed back"
      );
    }
    entries.push({
      date: cn.date,
      kind: isExchange ? "Exchange: goods returned" : "Sales Return",
      ref: cn.invoiceNumber ?? "",
      note: bits.join(" · "),
      items: returnedItems,
      debit: 0,
      credit: amt,
    });
    if (isExchange) {
      entries.push({
        date: cn.date,
        kind: "Exchange: replacement goods",
        ref: cn.invoiceNumber ?? "",
        note: `${countNote(takenItems.length, "item")} given in place of the returned goods, put on the same bill`,
        items: takenItems,
        debit: taken,
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
      stat(inv.id).chargesAdjusted += settled;
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

  // Same-day order reads like the day happened: bill, additions, returns
  // and exchanges, then the money that moved because of them.
  const rank = (e: LedgerEntry) =>
    /Invoice$/.test(e.kind) ? 0
    : e.kind === "Items added" ? 1
    : e.kind === "Sales Return" || e.kind === "Exchange: goods returned" ? 2
    : e.kind.startsWith("Exchange: replacement") ? 3
    : e.kind.startsWith("Payment") || e.kind.startsWith("Exchange difference") ? 4
    : /refund/i.test(e.kind) ? 5
    : 6;
  entries.sort((a, b) => a.date.getTime() - b.date.getTime() || rank(a) - rank(b));

  let balance = Number(party.openingBalance);
  const ledger = entries.map((e) => {
    balance += e.debit - e.credit;
    return {
      date: e.date,
      kind: e.kind,
      ref: e.ref,
      note: e.note ?? "",
      items: e.items ?? [],
      debit: round2(e.debit),
      credit: round2(e.credit),
      balance: round2(balance),
    };
  });

  const bills: LedgerBill[] = invoices
    .map((inv) => {
      const st = stat(inv.id);
      const total = round2(Number(inv.total));
      const net = round2(total - st.returned);
      const due = round2(total - Number(inv.amountPaid) - st.returned + st.refunded);
      const status: LedgerBill["status"] =
        due < -0.009 ? "EXCESS" : due <= 0.009 ? "PAID" : st.received + st.chargesAdjusted > 0.009 ? "PARTIAL" : "UNPAID";
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        date: inv.invoiceDate,
        original: round2(st.original),
        added: round2(st.added),
        total,
        returned: round2(st.returned),
        net,
        received: round2(st.received),
        refunded: round2(st.refunded),
        chargesAdjusted: round2(st.chargesAdjusted),
        due,
        status,
      };
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  return {
    ledger,
    bills,
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
