import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { INCOME_PURPOSE_LIST } from "../../lib/income";

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
          select: { total: true, amountPaid: true },
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

    const totalReceivable = receivableInvoices.reduce(
      (s, i) => s + (Number(i.total) - Number(i.amountPaid)),
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
    const period = String(req.query.period || "month");
    const y = ist.getUTCFullYear();
    const m = ist.getUTCMonth();
    let periodStart: Date;
    if (period === "quarter") {
      periodStart = new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1) - IST_MS);
    } else if (period === "year") {
      // Indian financial year: starts 1 April.
      periodStart = new Date(Date.UTC(m >= 3 ? y : y - 1, 3, 1) - IST_MS);
    } else {
      periodStart = new Date(Date.UTC(y, m, 1) - IST_MS);
    }
    const weekStart = new Date(todayStart.getTime() - 6 * 24 * 3600 * 1000);

    // Sales + cash-out pieces for a period → profit (net revenue is ex-GST;
    // COGS is de-grossed to ex-GST to match; expenses subtract fully).
    // Service/other income (credit vouchers, e.g. LED service) is added on top
    // of sales — it has no COGS, so the full amount is profit.
    const profitFor = async (from: Date) => {
      const [rev, cogsRows, exp, svc] = await Promise.all([
        prisma.invoice.aggregate({
          where: { businessId, type: "SALE", invoiceDate: { gte: from } },
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
        `),
        prisma.expense.aggregate({
          where: { businessId, date: { gte: from } },
          _sum: { amount: true },
        }),
        prisma.payment.aggregate({
          where: {
            businessId,
            direction: "IN",
            purpose: { in: INCOME_PURPOSE_LIST },
            paymentDate: { gte: from },
          },
          _sum: { amount: true },
        }),
      ]);
      const netRevenue =
        Number(rev._sum.subtotal ?? 0) - Number(rev._sum.discount ?? 0);
      const cogs = Number(cogsRows[0]?.cogs ?? 0);
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

    const [
      today,
      month,
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
      profitFor(todayStart),
      profitFor(periodStart),
      prisma.invoice.findMany({
        where: { businessId, type: "SALE", invoiceDate: { gte: weekStart } },
        select: { invoiceDate: true, total: true, channel: true },
      }),
      prisma.invoice.findMany({
        where: { businessId, type: "SALE", status: { in: ["UNPAID", "PARTIAL"] } },
        select: { total: true, amountPaid: true },
      }),
      prisma.invoice.findMany({
        where: { businessId, type: "PURCHASE", status: { in: ["UNPAID", "PARTIAL"] } },
        select: { total: true, amountPaid: true },
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

    const due = (rows: { total: unknown; amountPaid: unknown }[]) =>
      rows
        .map((r) => Number(r.total) - Number(r.amountPaid))
        .filter((d) => d > 0.009);
    const recv = due(receivables);
    const pay = due(payables);

    res.json({
      overview: {
        today,
        // Selected period's figures (kept under `month` for compatibility).
        month,
        period,
        periodStart,
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
