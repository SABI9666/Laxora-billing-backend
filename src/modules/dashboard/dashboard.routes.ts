import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { INCOME_PURPOSE_LIST } from "../../lib/income";
import { billDue, refundedByInvoice } from "../../lib/settlement";

const router = Router();

// GET /api/dashboard/summary — headline numbers for the home screen.
router.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const businessId = req.businessId!;

    const [salesAgg, purchaseAgg, receivableInvoices, partyCount, itemCount, lowStock] =
      await Promise.all([
        prisma.invoice.aggregate({
          where: { businessId, type: "SALE" },
          _sum: { total: true },
          _count: true,
        }),
        prisma.invoice.aggregate({
          where: { businessId, type: "PURCHASE" },
          _sum: { total: true },
          _count: true,
        }),
        prisma.invoice.findMany({
          where: { businessId, type: "SALE", status: { in: ["UNPAID", "PARTIAL"] } },
          select: { id: true, total: true, amountPaid: true },
        }),
        prisma.party.count({ where: { businessId } }),
        prisma.item.count({ where: { businessId } }),
        prisma.$queryRaw<Array<{ count: bigint }>>(
          Prisma.sql`SELECT COUNT(*)::bigint AS count FROM "Item"
                     WHERE "businessId" = ${businessId}
                     AND "isService" = false
                     AND "stockQty" <= "lowStockAlert"`
        ),
      ]);

    // Credit notes reduce what a customer still owes on a bill — keeps this
    // figure in line with the admin cash book's "balance to receive".
    const summaryCn = await prisma.creditNote.groupBy({
      by: ["invoiceId"],
      where: { businessId, invoiceId: { in: receivableInvoices.map((i) => i.id) } },
      _sum: { totalAmount: true },
    });
    const summaryCnMap = new Map(
      summaryCn.map((c) => [c.invoiceId, Number(c._sum.totalAmount ?? 0)])
    );
    const summaryRefunds = await refundedByInvoice(
      prisma,
      businessId,
      receivableInvoices.map((i) => i.id),
      "SALE"
    );
    const totalReceivable = receivableInvoices.reduce(
      (s, i) =>
        s +
        Math.max(
          0,
          billDue({
            total: i.total,
            amountPaid: i.amountPaid,
            returned: summaryCnMap.get(i.id),
            refunded: summaryRefunds.get(i.id),
          })
        ),
      0
    );

    res.json({
      summary: {
        totalSales: Number(salesAgg._sum.total ?? 0),
        salesCount: salesAgg._count,
        totalPurchases: Number(purchaseAgg._sum.total ?? 0),
        purchaseCount: purchaseAgg._count,
        totalReceivable: Math.round(totalReceivable * 100) / 100,
        partyCount,
        itemCount,
        lowStockCount: Number(lowStock[0]?.count ?? 0),
      },
    });
  })
);

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// GET /api/dashboard/overview — rich home-screen data: today's and this
// month's sales & profit, pending payments, a 7-day sales series, and per-day
// counts of entries made in the software (products added/edited, bills, …).
// Days are bucketed in Indian time (IST, UTC+5:30).
router.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const businessId = req.businessId!;
    const IST_MS = 5.5 * 60 * 60 * 1000;
    const dayKey = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
    const now = new Date();
    const ist = new Date(now.getTime() + IST_MS);
    const todayStart = new Date(
      Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_MS
    );
    // Reporting period for the stat cards: month (default), quarter (Apr–Jun,
    // Jul–Sep, Oct–Dec, Jan–Mar) or year (financial year, Apr–Mar).
    //
    // Monthly mode accepts ?month=YYYY-MM so the picker can look back at an
    // earlier month. Every period also carries an explicit END, and the one
    // before it for the "vs last period" comparison. Without that end bound a
    // past month meant "everything from the 1st onwards", so picking July
    // returned exactly the same figures as August.
    const period = String(req.query.period || "month");
    const y = ist.getUTCFullYear();
    const m = ist.getUTCMonth();
    // IST midnight on the 1st of a month, as a UTC instant. Month numbers
    // outside 0–11 roll into the neighbouring year, which is what we want.
    const monthStart = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 1) - IST_MS);

    let periodStart: Date;
    let periodEnd: Date; // exclusive
    let prevStart: Date;
    if (period === "quarter") {
      const q = Math.floor(m / 3) * 3;
      periodStart = monthStart(y, q);
      periodEnd = monthStart(y, q + 3);
      prevStart = monthStart(y, q - 3);
    } else if (period === "year") {
      // Indian financial year: starts 1 April.
      const fy = m >= 3 ? y : y - 1;
      periodStart = monthStart(fy, 3);
      periodEnd = monthStart(fy + 1, 3);
      prevStart = monthStart(fy - 1, 3);
    } else {
      const asked = String(req.query.month ?? "");
      const picked = /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) ? asked : null;
      const py = picked ? Number(picked.slice(0, 4)) : y;
      const pm = picked ? Number(picked.slice(5, 7)) - 1 : m;
      periodStart = monthStart(py, pm);
      periodEnd = monthStart(py, pm + 1);
      prevStart = monthStart(py, pm - 1);
    }
    const prevEnd = periodStart;
    const weekStart = new Date(todayStart.getTime() - 6 * 24 * 3600 * 1000);

    // Sales + cash-out pieces for a period → profit (net revenue is ex-GST;
    // COGS is de-grossed to ex-GST to match; expenses subtract fully).
    // Sales returns (credit notes) reverse both the revenue and the cost of
    // the returned goods, so the profit here always agrees with the P&L
    // report. Service/other income (credit vouchers, e.g. LED service) is
    // added on top of sales — it has no COGS, so the full amount is profit.
    const profitFor = async (from: Date, to: Date) => {
      // `to` is exclusive, so a period covers exactly itself.
      const range = { gte: from, lt: to };
      const [rev, cogsRows, exp, svc, ret] = await Promise.all([
        prisma.invoice.aggregate({
          where: { businessId, type: "SALE", invoiceDate: range },
          _sum: { subtotal: true, discount: true, total: true },
          _count: true,
        }),
        prisma.$queryRaw<Array<{ cogs: number }>>(Prisma.sql`
          SELECT COALESCE(SUM(ii.quantity * i."purchasePrice" / (1 + i."taxRate" / 100)), 0)::float AS cogs
          FROM "InvoiceItem" ii
          JOIN "Invoice" inv ON inv.id = ii."invoiceId"
          JOIN "Item" i ON i.id = ii."itemId"
          WHERE inv."businessId" = ${businessId}
            AND inv.type = 'SALE'
            AND inv."invoiceDate" >= ${from}
            AND inv."invoiceDate" < ${to}
        `),
        prisma.expense.aggregate({
          where: { businessId, date: range },
          _sum: { amount: true },
        }),
        prisma.payment.aggregate({
          where: {
            businessId,
            direction: "IN",
            purpose: { in: INCOME_PURPOSE_LIST },
            paymentDate: range,
          },
          _sum: { amount: true },
        }),
        prisma.creditNote.aggregate({
          where: { businessId, date: range },
          _sum: { netAmount: true, cogs: true },
        }),
      ]);
      const returnsNet = Number(ret._sum.netAmount ?? 0);
      const returnsCogs = Number(ret._sum.cogs ?? 0);
      const netRevenue =
        Number(rev._sum.subtotal ?? 0) - Number(rev._sum.discount ?? 0) - returnsNet;
      const cogs = Number(cogsRows[0]?.cogs ?? 0) - returnsCogs;
      const expenses = Number(exp._sum.amount ?? 0);
      const serviceIncome = Number(svc._sum.amount ?? 0);
      return {
        sales: round2(Number(rev._sum.total ?? 0)),
        bills: rev._count,
        netRevenue: round2(netRevenue),
        serviceIncome: round2(serviceIncome),
        cogs: round2(cogs),
        expenses: round2(expenses),
        profit: round2(netRevenue + serviceIncome - cogs - expenses),
      };
    };

    const todayEnd = new Date(todayStart.getTime() + 24 * 3600 * 1000);

    const [
      today,
      month,
      prev,
      weekSales,
      receivables,
      payables,
      lowStock,
      weekItems,
      weekEdits,
      weekBills,
      weekPayments,
      weekExpenses,
    ] = await Promise.all([
      profitFor(todayStart, todayEnd),
      profitFor(periodStart, periodEnd),
      // The period before the selected one, for the "vs last month/quarter/FY"
      // line on the Sales and Profit cards.
      profitFor(prevStart, prevEnd),
      prisma.invoice.findMany({
        where: { businessId, type: "SALE", invoiceDate: { gte: weekStart } },
        select: { invoiceDate: true, total: true, channel: true },
      }),
      prisma.invoice.findMany({
        where: { businessId, type: "SALE", status: { in: ["UNPAID", "PARTIAL"] } },
        select: { id: true, total: true, amountPaid: true },
      }),
      prisma.invoice.findMany({
        where: { businessId, type: "PURCHASE", status: { in: ["UNPAID", "PARTIAL"] } },
        select: { id: true, total: true, amountPaid: true },
      }),
      prisma.$queryRaw<Array<{ count: bigint }>>(
        Prisma.sql`SELECT COUNT(*)::bigint AS count FROM "Item"
                   WHERE "businessId" = ${businessId}
                   AND "isService" = false
                   AND "stockQty" <= "lowStockAlert"`
      ),
      prisma.item.findMany({
        where: { businessId, createdAt: { gte: weekStart } },
        select: { createdAt: true },
      }),
      prisma.activityLog.findMany({
        where: { businessId, type: "ITEM_EDIT", createdAt: { gte: weekStart } },
        select: { createdAt: true },
      }),
      prisma.invoice.findMany({
        where: { businessId, createdAt: { gte: weekStart } },
        select: { createdAt: true, type: true, channel: true },
      }),
      prisma.payment.findMany({
        where: { businessId, createdAt: { gte: weekStart } },
        select: { createdAt: true },
      }),
      prisma.expense.findMany({
        where: { businessId, createdAt: { gte: weekStart } },
        select: { createdAt: true },
      }),
    ]);

    // Last 7 IST days, oldest → today (noon offset keeps us inside the day).
    const days: string[] = [];
    for (let i = 6; i >= 0; i--) {
      days.push(dayKey(new Date(todayStart.getTime() - i * 24 * 3600 * 1000 + 12 * 3600 * 1000)));
    }

    const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const labelFor = (key: string) => {
      const d = new Date(`${key}T00:00:00Z`);
      return WEEKDAY[d.getUTCDay()];
    };

    const salesByDay = new Map<string, { sales: number; bills: number; online: number }>();
    for (const inv of weekSales) {
      const k = dayKey(inv.invoiceDate);
      const cur = salesByDay.get(k) ?? { sales: 0, bills: 0, online: 0 };
      cur.sales += Number(inv.total);
      cur.bills += 1;
      if (inv.channel === "ONLINE") cur.online += Number(inv.total);
      salesByDay.set(k, cur);
    }

    type Act = {
      productsAdded: number;
      productsEdited: number;
      bills: number;
      purchases: number;
      onlineOrders: number;
      payments: number;
      expenses: number;
    };
    const blankAct = (): Act => ({
      productsAdded: 0,
      productsEdited: 0,
      bills: 0,
      purchases: 0,
      onlineOrders: 0,
      payments: 0,
      expenses: 0,
    });
    const actByDay = new Map<string, Act>();
    const bump = (d: Date, field: keyof Act) => {
      const k = dayKey(d);
      const cur = actByDay.get(k) ?? blankAct();
      cur[field] += 1;
      actByDay.set(k, cur);
    };
    weekItems.forEach((r) => bump(r.createdAt, "productsAdded"));
    weekEdits.forEach((r) => bump(r.createdAt, "productsEdited"));
    weekBills.forEach((r) => {
      if (r.type === "PURCHASE") bump(r.createdAt, "purchases");
      else if (r.channel === "ONLINE") bump(r.createdAt, "onlineOrders");
      else bump(r.createdAt, "bills");
    });
    weekPayments.forEach((r) => bump(r.createdAt, "payments"));
    weekExpenses.forEach((r) => bump(r.createdAt, "expenses"));

    const week = days.map((k) => {
      const s = salesByDay.get(k) ?? { sales: 0, bills: 0, online: 0 };
      const a = actByDay.get(k) ?? blankAct();
      return {
        day: k,
        label: labelFor(k),
        sales: round2(s.sales),
        onlineSales: round2(s.online),
        billCount: s.bills,
        activity: {
          ...a,
          total:
            a.productsAdded +
            a.productsEdited +
            a.bills +
            a.purchases +
            a.onlineOrders +
            a.payments +
            a.expenses,
        },
      };
    });

    // Credit notes reduce what a customer still owes on a bill — keeps the
    // "to receive" card in line with the admin cash book.
    const pendingCn = await prisma.creditNote.groupBy({
      by: ["invoiceId"],
      where: { businessId, invoiceId: { in: receivables.map((i) => i.id) } },
      _sum: { totalAmount: true },
    });
    const pendingCnMap = new Map(
      pendingCn.map((c) => [c.invoiceId, Number(c._sum.totalAmount ?? 0)])
    );
    const [recvRefunds, payRefunds] = await Promise.all([
      refundedByInvoice(prisma, businessId, receivables.map((i) => i.id), "SALE"),
      refundedByInvoice(prisma, businessId, payables.map((i) => i.id), "PURCHASE"),
    ]);
    const due = (
      rows: { id: string; total: unknown; amountPaid: unknown }[],
      cn: Map<string | null, number> | undefined,
      refunds: Map<string, number>
    ) =>
      rows
        .map((r) =>
          billDue({
            total: r.total as number,
            amountPaid: r.amountPaid as number,
            returned: cn?.get(r.id),
            refunded: refunds.get(r.id),
          })
        )
        .filter((d) => d > 0.009);
    const recv = due(receivables, pendingCnMap, recvRefunds);
    const pay = due(payables, undefined, payRefunds);

    res.json({
      overview: {
        today,
        // Selected period's figures (kept under `month` for compatibility).
        month,
        prev,
        period,
        periodStart,
        periodEnd,
        pending: {
          toReceive: round2(recv.reduce((s, d) => s + d, 0)),
          receivableBills: recv.length,
          toPay: round2(pay.reduce((s, d) => s + d, 0)),
          payableBills: pay.length,
        },
        week,
        lowStockCount: Number(lowStock[0]?.count ?? 0),
      },
    });
  })
);

// GET /api/dashboard/trend?bucket=month|week&periods=12 — one row per period
// with sales, purchases and profit, for the dashboard's trend chart. Periods
// are bucketed in Indian time (IST, UTC+5:30): calendar months, or Monday-start
// weeks, always ending with the one we are in now. Profit is built exactly like
// /overview's: ex-GST net revenue plus standalone service income, less
// de-grossed COGS and expenses, with sales returns reversing both the revenue
// and the cost of the goods sent back.
//
// Stock moved between the owner's shops is reported alongside, as transferIn
// and transferOut. A transfer carries no money — no bill, no payment — so it
// is valued at the item's own purchase price (which is stored GST-inclusive,
// like an invoice total, so the figures are directly comparable). Valuing both
// directions at cost means one transfer is worth the same on the sending
// shop's chart as on the receiving shop's. It is deliberately NOT part of
// sales, purchases or profit: relocating your own stock earns nothing.
//
// Also mounted at the older /monthly-trend path so a frontend deployed before
// weekly existed keeps working (it sends no bucket, and month is the default).
const trendHandler = asyncHandler(async (req, res) => {
  const businessId = req.businessId!;
  const IST_MS = 5.5 * 60 * 60 * 1000;
  const bucket = req.query.bucket === "week" ? "week" : "month";

  // `months` is the parameter the first version of this endpoint took; keep
  // honouring it so the older frontend's ?months=6 still narrows the window.
  const askedPeriods = Number(req.query.periods ?? req.query.months);
  const limits = bucket === "week" ? { min: 4, max: 53, fallback: 12 } : { min: 3, max: 24, fallback: 12 };
  const periods = Number.isFinite(askedPeriods)
    ? Math.min(limits.max, Math.max(limits.min, Math.trunc(askedPeriods)))
    : limits.fallback;

  const ist = new Date(Date.now() + IST_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  // Monday = 0, so a week runs Mon–Sun like the shop's own week.
  const weekdayOffset = (ist.getUTCDay() + 6) % 7;

  // IST midnight, as the UTC instant the database stores.
  const istMidnight = (yy: number, mm: number, dd: number) =>
    new Date(Date.UTC(yy, mm, dd) - IST_MS);
  // Start of the period `i` steps from the current one (negative = earlier).
  const periodStart = (i: number) =>
    bucket === "week"
      ? istMidnight(y, m, d - weekdayOffset + i * 7)
      : istMidnight(y, m + i, 1);

  const from = periodStart(-(periods - 1));
  const to = periodStart(1); // exclusive

  // The key both sides agree on: a month is "YYYY-MM", a week is the IST date
  // of its Monday. date_trunc('week') is Monday-based, which is why the
  // JavaScript side counts weekdays from Monday too.
  const keyOf = (col: string) => {
    const c = Prisma.raw(col);
    return bucket === "week"
      ? Prisma.sql`to_char(date_trunc('week', ${c} + interval '330 minutes'), 'YYYY-MM-DD')`
      : Prisma.sql`to_char(${c} + interval '330 minutes', 'YYYY-MM')`;
  };

  // One grouped query per source instead of a per-period round trip — twelve
  // periods cost five queries, not sixty.
  const [invoiceRows, cogsRows, expenseRows, incomeRows, returnRows, transferRows] =
    await Promise.all([
    prisma.$queryRaw<
      Array<{
        key: string;
        sales: number;
        purchases: number;
        grossRevenue: number;
        saleBills: number;
        purchaseBills: number;
      }>
    >(Prisma.sql`
      SELECT ${keyOf('"invoiceDate"')} AS key,
             COALESCE(SUM(CASE WHEN type = 'SALE' THEN total END), 0)::float AS sales,
             COALESCE(SUM(CASE WHEN type = 'PURCHASE' THEN total END), 0)::float AS purchases,
             COALESCE(SUM(CASE WHEN type = 'SALE' THEN subtotal - discount END), 0)::float
               AS "grossRevenue",
             COUNT(*) FILTER (WHERE type = 'SALE')::int AS "saleBills",
             COUNT(*) FILTER (WHERE type = 'PURCHASE')::int AS "purchaseBills"
      FROM "Invoice"
      WHERE "businessId" = ${businessId}
        AND "invoiceDate" >= ${from}
        AND "invoiceDate" < ${to}
      GROUP BY 1
    `),
    prisma.$queryRaw<Array<{ key: string; cogs: number }>>(Prisma.sql`
      SELECT ${keyOf('inv."invoiceDate"')} AS key,
             COALESCE(SUM(ii.quantity * i."purchasePrice" / (1 + i."taxRate" / 100)), 0)::float
               AS cogs
      FROM "InvoiceItem" ii
      JOIN "Invoice" inv ON inv.id = ii."invoiceId"
      JOIN "Item" i ON i.id = ii."itemId"
      WHERE inv."businessId" = ${businessId}
        AND inv.type = 'SALE'
        AND inv."invoiceDate" >= ${from}
        AND inv."invoiceDate" < ${to}
      GROUP BY 1
    `),
    prisma.$queryRaw<Array<{ key: string; expenses: number }>>(Prisma.sql`
      SELECT ${keyOf('"date"')} AS key,
             COALESCE(SUM(amount), 0)::float AS expenses
      FROM "Expense"
      WHERE "businessId" = ${businessId}
        AND "date" >= ${from}
        AND "date" < ${to}
      GROUP BY 1
    `),
    prisma.$queryRaw<Array<{ key: string; income: number }>>(Prisma.sql`
      SELECT ${keyOf('"paymentDate"')} AS key,
             COALESCE(SUM(amount), 0)::float AS income
      FROM "Payment"
      WHERE "businessId" = ${businessId}
        AND direction = 'IN'
        AND purpose IN (${Prisma.join(INCOME_PURPOSE_LIST)})
        AND "paymentDate" >= ${from}
        AND "paymentDate" < ${to}
      GROUP BY 1
    `),
    prisma.$queryRaw<Array<{ key: string; retNet: number; retCogs: number }>>(Prisma.sql`
      SELECT ${keyOf('"date"')} AS key,
             COALESCE(SUM("netAmount"), 0)::float AS "retNet",
             COALESCE(SUM(cogs), 0)::float AS "retCogs"
      FROM "CreditNote"
      WHERE "businessId" = ${businessId}
        AND "date" >= ${from}
        AND "date" < ${to}
      GROUP BY 1
    `),
    // TRANSFER_OUT is stored as a negative quantity (it reduces stock), so it
    // is negated here to give a positive value moved.
    prisma.$queryRaw<Array<{ key: string; transferIn: number; transferOut: number }>>(Prisma.sql`
      SELECT ${keyOf('sm."createdAt"')} AS key,
             COALESCE(SUM(CASE WHEN sm.type = 'TRANSFER_IN'
                               THEN sm.quantity * i."purchasePrice" END), 0)::float AS "transferIn",
             COALESCE(SUM(CASE WHEN sm.type = 'TRANSFER_OUT'
                               THEN -sm.quantity * i."purchasePrice" END), 0)::float AS "transferOut"
      FROM "StockMovement" sm
      JOIN "Item" i ON i.id = sm."itemId"
      WHERE sm."businessId" = ${businessId}
        AND sm.type IN ('TRANSFER_IN', 'TRANSFER_OUT')
        AND sm."createdAt" >= ${from}
        AND sm."createdAt" < ${to}
      GROUP BY 1
    `),
  ]);

  const byKey = <T>(rows: Array<T & { key: string }>) => new Map(rows.map((r) => [r.key, r]));
  const inv = byKey(invoiceRows);
  const cog = byKey(cogsRows);
  const exp = byKey(expenseRows);
  const inc = byKey(incomeRows);
  const ret = byKey(returnRows);
  const trf = byKey(transferRows);

  const MONTH = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  const trend = [];
  for (let i = periods - 1; i >= 0; i--) {
    // The IST calendar date this period starts on.
    const startIst = new Date(periodStart(-i).getTime() + IST_MS);
    const sy = startIst.getUTCFullYear();
    const sm = startIst.getUTCMonth();
    const sd = startIst.getUTCDate();

    let key: string;
    let label: string;
    let fullLabel: string;
    if (bucket === "week") {
      key = `${sy}-${String(sm + 1).padStart(2, "0")}-${String(sd).padStart(2, "0")}`;
      label = `${sd} ${MONTH[sm]}`;
      // The Sunday that closes the week.
      const end = new Date(Date.UTC(sy, sm, sd + 6));
      const ey = end.getUTCFullYear();
      const em = end.getUTCMonth();
      const ed = end.getUTCDate();
      fullLabel =
        sm === em && sy === ey
          ? `${sd}–${ed} ${MONTH[sm]} ${sy}`
          : `${sd} ${MONTH[sm]} – ${ed} ${MONTH[em]} ${ey}`;
    } else {
      key = `${sy}-${String(sm + 1).padStart(2, "0")}`;
      label = MONTH[sm];
      fullLabel = `${MONTH[sm]} ${sy}`;
    }

    const iv = inv.get(key);
    const netRevenue = Number(iv?.grossRevenue ?? 0) - Number(ret.get(key)?.retNet ?? 0);
    const cogs = Number(cog.get(key)?.cogs ?? 0) - Number(ret.get(key)?.retCogs ?? 0);
    const expenses = Number(exp.get(key)?.expenses ?? 0);
    const serviceIncome = Number(inc.get(key)?.income ?? 0);

    trend.push({
      // `month` is the key's original name, kept so the older frontend's
      // React list keys keep working; it holds the week's Monday in week mode.
      month: key,
      key,
      label,
      fullLabel,
      sales: round2(Number(iv?.sales ?? 0)),
      purchases: round2(Number(iv?.purchases ?? 0)),
      netRevenue: round2(netRevenue),
      serviceIncome: round2(serviceIncome),
      cogs: round2(cogs),
      expenses: round2(expenses),
      profit: round2(netRevenue + serviceIncome - cogs - expenses),
      saleBills: Number(iv?.saleBills ?? 0),
      purchaseBills: Number(iv?.purchaseBills ?? 0),
      transferIn: round2(Number(trf.get(key)?.transferIn ?? 0)),
      transferOut: round2(Number(trf.get(key)?.transferOut ?? 0)),
    });
  }

  res.json({ trend, bucket, periods, from, to });
});

router.get("/trend", trendHandler);
router.get("/monthly-trend", trendHandler);

// GET /api/dashboard/recent-invoices
router.get(
  "/recent-invoices",
  asyncHandler(async (req, res) => {
    const invoices = await prisma.invoice.findMany({
      where: { businessId: req.businessId! },
      include: { party: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    res.json({ invoices });
  })
);

export default router;
