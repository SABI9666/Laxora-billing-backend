import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, conflict, notFound } from "../../utils/errors";
import { hashPassword } from "../../utils/password";
import { deleteInvoiceWithReversal } from "../../lib/invoiceOps";
import { reverseCreditNote } from "../../lib/returnOps";

// Cross-tenant, platform-owner endpoints. Mounted behind requirePlatformAdmin.
const router = Router();

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Builds an optional invoiceDate range filter from ?from=&to= query params.
function dateRange(req: { query: Record<string, unknown> }) {
  const from = req.query.from ? new Date(String(req.query.from)) : undefined;
  const to = req.query.to ? new Date(String(req.query.to)) : undefined;
  const filter =
    from || to
      ? { invoiceDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {};
  return { from, to, filter };
}

// GET /api/admin/stats — platform-wide headline numbers.
router.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    const [users, businesses, franchises, invoices, parties, salesAgg] =
      await Promise.all([
        prisma.user.count(),
        prisma.business.count(),
        prisma.franchise.count(),
        prisma.invoice.count(),
        prisma.party.count(),
        prisma.invoice.aggregate({
          where: { type: "SALE" },
          _sum: { total: true },
        }),
      ]);
    res.json({
      stats: {
        users,
        businesses,
        franchises,
        invoices,
        parties,
        totalSalesVolume: Number(salesAgg._sum.total ?? 0),
      },
    });
  })
);

// GET /api/admin/businesses — every business with owner + activity counts.
router.get(
  "/businesses",
  asyncHandler(async (req, res) => {
    const search = req.query.search ? String(req.query.search) : undefined;
    const businesses = await prisma.business.findMany({
      where: search
        ? { name: { contains: search, mode: "insensitive" } }
        : undefined,
      include: {
        owner: { select: { id: true, name: true, email: true } },
        franchise: { select: { id: true, name: true } },
        _count: { select: { invoices: true, parties: true, items: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ businesses });
  })
);

// POST /api/admin/businesses — create a new shop (owned by the platform admin).
router.post(
  "/businesses",
  validateBody(
    z.object({
      name: z.string().min(1),
      code: z.string().optional(),
      gstin: z.string().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const business = await prisma.business.create({
      data: { ...req.body, ownerId: req.auth!.userId },
    });
    res.status(201).json({ business });
  })
);

// GET /api/admin/franchises — every franchise with owner + shop count.
router.get(
  "/franchises",
  asyncHandler(async (_req, res) => {
    const franchises = await prisma.franchise.findMany({
      include: {
        owner: { select: { id: true, name: true, email: true } },
        _count: { select: { shops: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ franchises });
  })
);

// GET /api/admin/businesses/:id/details — full detail for one shop, so the
// platform admin can select a shop and see everything about it.
router.get(
  "/businesses/:id/details",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const business = await prisma.business.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        franchise: { select: { id: true, name: true } },
      },
    });
    if (!business) throw notFound("Shop not found");

    const [salesAgg, purchaseAgg, receivableInvoices, partyCount, itemCount, recentInvoices, lowStock, stockValue] =
      await Promise.all([
        prisma.invoice.aggregate({
          where: { businessId: id, type: "SALE" },
          _sum: { total: true },
          _count: true,
        }),
        prisma.invoice.aggregate({
          where: { businessId: id, type: "PURCHASE" },
          _sum: { total: true },
          _count: true,
        }),
        prisma.invoice.findMany({
          where: { businessId: id, type: "SALE", status: { in: ["UNPAID", "PARTIAL"] } },
          select: { total: true, amountPaid: true },
        }),
        prisma.party.count({ where: { businessId: id } }),
        prisma.item.count({ where: { businessId: id } }),
        prisma.invoice.findMany({
          where: { businessId: id },
          include: { party: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
          take: 10,
        }),
        prisma.$queryRaw<Array<Record<string, unknown>>>(
          Prisma.sql`SELECT id, name, sku, unit, "stockQty", "lowStockAlert"
                     FROM "Item"
                     WHERE "businessId" = ${id} AND "isService" = false
                     AND "stockQty" <= "lowStockAlert"
                     ORDER BY "stockQty" ASC`
        ),
        prisma.$queryRaw<Array<{ value: number }>>(
          Prisma.sql`SELECT COALESCE(SUM("stockQty" * "purchasePrice"), 0)::float AS value
                     FROM "Item" WHERE "businessId" = ${id} AND "isService" = false`
        ),
      ]);

    const totalReceivable = receivableInvoices.reduce(
      (s, i) => s + (Number(i.total) - Number(i.amountPaid)),
      0
    );

    res.json({
      business: {
        id: business.id,
        name: business.name,
        code: business.code,
        gstin: business.gstin,
        phone: business.phone,
        address: business.address,
        owner: business.owner,
        franchise: business.franchise,
      },
      kpis: {
        totalSales: Number(salesAgg._sum.total ?? 0),
        salesCount: salesAgg._count,
        totalPurchases: Number(purchaseAgg._sum.total ?? 0),
        purchaseCount: purchaseAgg._count,
        totalReceivable: Math.round(totalReceivable * 100) / 100,
        partyCount,
        itemCount,
        lowStockCount: lowStock.length,
        stockValue: Math.round(Number(stockValue[0]?.value ?? 0) * 100) / 100,
      },
      recentInvoices,
      lowStockItems: lowStock,
    });
  })
);

// GET /api/admin/businesses/:id/pnl?from=&to= — Profit & Loss for one shop.
router.get(
  "/businesses/:id/pnl",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const business = await prisma.business.findUnique({
      where: { id },
      select: { id: true, name: true },
    });
    if (!business) throw notFound("Shop not found");

    const { from, to, filter } = dateRange(req);

    const [sales, purchases] = await Promise.all([
      prisma.invoice.aggregate({
        where: { businessId: id, type: "SALE", ...filter },
        _sum: { total: true, amountPaid: true, taxAmount: true },
        _count: true,
      }),
      prisma.invoice.aggregate({
        where: { businessId: id, type: "PURCHASE", ...filter },
        _sum: { total: true, taxAmount: true },
        _count: true,
      }),
    ]);

    // P&L is on a CASH basis: revenue = what was actually collected
    // (amountPaid), so it updates as payments are recorded and reflects the
    // final settled amount. Tax inside the collected amount is excluded, and
    // cost of goods sold is subtracted. Purchase prices are entered GST-
    // inclusive, so COGS is divided by (1 + taxRate/100) to make it ex-GST —
    // matching ex-GST net sales — for an exact gross profit.
    const conditions = [
      Prisma.sql`inv."businessId" = ${id}`,
      Prisma.sql`inv.type = 'SALE'`,
    ];
    if (from) conditions.push(Prisma.sql`inv."invoiceDate" >= ${from}`);
    if (to) conditions.push(Prisma.sql`inv."invoiceDate" <= ${to}`);

    // Tax actually collected = tax share of the paid portion of each bill.
    const taxRealizedRows = await prisma.$queryRaw<Array<{ tax: number }>>(Prisma.sql`
      SELECT COALESCE(SUM(inv."taxAmount" * inv."amountPaid" / NULLIF(inv.total, 0)), 0)::float AS tax
      FROM "Invoice" inv
      WHERE ${Prisma.join(conditions, " AND ")}
    `);
    const cogsRows = await prisma.$queryRaw<Array<{ cogs: number }>>(Prisma.sql`
      SELECT COALESCE(SUM(ii.quantity * i."purchasePrice" / (1 + i."taxRate" / 100)), 0)::float AS cogs
      FROM "InvoiceItem" ii
      JOIN "Invoice" inv ON inv.id = ii."invoiceId"
      JOIN "Item" i ON i.id = ii."itemId"
      WHERE ${Prisma.join(conditions, " AND ")}
    `);
    const cogs = Number(cogsRows[0]?.cogs ?? 0);

    const salesGross = Number(sales._sum.total ?? 0); // total billed
    const amountCollected = Number(sales._sum.amountPaid ?? 0); // actually received
    const taxCollected = Number(taxRealizedRows[0]?.tax ?? 0);
    const netRevenue = amountCollected - taxCollected; // realised sales, ex-tax
    const grossProfit = netRevenue - cogs;
    const outstanding = salesGross - amountCollected; // still to be received

    // Expenses / charges (commission, damage, returns, etc.) reduce profit.
    const expConditions = [Prisma.sql`"businessId" = ${id}`];
    if (from) expConditions.push(Prisma.sql`date >= ${from}`);
    if (to) expConditions.push(Prisma.sql`date <= ${to}`);
    const [expTotalRows, monthlyExpRows, retTotalRows, monthlyRetRows] = await Promise.all([
      prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT COALESCE(SUM(amount), 0)::float AS total FROM "Expense"
        WHERE ${Prisma.join(expConditions, " AND ")}
      `),
      prisma.$queryRaw<Array<{ month: string; exp: number }>>(Prisma.sql`
        SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month,
               COALESCE(SUM(amount), 0)::float AS exp
        FROM "Expense" WHERE ${Prisma.join(expConditions, " AND ")}
        GROUP BY 1
      `),
      // Returns (credit notes) reduce revenue and cost of goods.
      prisma.$queryRaw<Array<{ net: number; tax: number; cogs: number }>>(Prisma.sql`
        SELECT COALESCE(SUM("netAmount"), 0)::float AS net,
               COALESCE(SUM("taxAmount"), 0)::float AS tax,
               COALESCE(SUM(cogs), 0)::float AS cogs
        FROM "CreditNote" WHERE ${Prisma.join(expConditions, " AND ")}
      `),
      prisma.$queryRaw<Array<{ month: string; net: number; cogs: number }>>(Prisma.sql`
        SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month,
               COALESCE(SUM("netAmount"), 0)::float AS net,
               COALESCE(SUM(cogs), 0)::float AS cogs
        FROM "CreditNote" WHERE ${Prisma.join(expConditions, " AND ")}
        GROUP BY 1
      `),
    ]);
    const totalExpenses = Number(expTotalRows[0]?.total ?? 0);
    const expByMonth = new Map(monthlyExpRows.map((r) => [r.month, Number(r.exp)]));

    // Apply returns: reduce net revenue and cost of goods.
    const returnsNet = Number(retTotalRows[0]?.net ?? 0);
    const returnsCogs = Number(retTotalRows[0]?.cogs ?? 0);
    const returnsTotal = returnsNet + Number(retTotalRows[0]?.tax ?? 0);
    const adjNetRevenue = netRevenue - returnsNet;
    const adjCogs = cogs - returnsCogs;
    const adjGrossProfit = adjNetRevenue - adjCogs;
    const netProfit = adjGrossProfit - totalExpenses;
    const retByMonth = new Map(
      monthlyRetRows.map((r) => [r.month, { net: Number(r.net), cogs: Number(r.cogs) }])
    );

    // Monthly profit/loss, cash basis, net of expenses.
    const monthlyRows = await prisma.$queryRaw<
      Array<{ month: string; collected: number; taxrealized: number; cogs: number }>
    >(Prisma.sql`
      SELECT to_char(date_trunc('month', inv."invoiceDate"), 'YYYY-MM') AS month,
             COALESCE(SUM(inv."amountPaid"), 0)::float AS collected,
             COALESCE(SUM(inv."taxAmount" * inv."amountPaid" / NULLIF(inv.total, 0)), 0)::float AS taxrealized,
             COALESCE(SUM(c.cost), 0)::float AS cogs
      FROM "Invoice" inv
      LEFT JOIN LATERAL (
        SELECT SUM(ii.quantity * i."purchasePrice" / (1 + i."taxRate" / 100)) AS cost
        FROM "InvoiceItem" ii JOIN "Item" i ON i.id = ii."itemId"
        WHERE ii."invoiceId" = inv.id
      ) c ON true
      WHERE ${Prisma.join(conditions, " AND ")}
      GROUP BY 1
    `);

    // Merge sales-derived months with expense-only months.
    const salesByMonth = new Map<string, { net: number; cogs: number }>();
    for (const m of monthlyRows) {
      salesByMonth.set(m.month, {
        net: Number(m.collected) - Number(m.taxrealized),
        cogs: Number(m.cogs),
      });
    }
    const allMonths = new Set<string>([
      ...salesByMonth.keys(),
      ...expByMonth.keys(),
      ...retByMonth.keys(),
    ]);
    const monthly = Array.from(allMonths)
      .sort()
      .map((month) => {
        const s = salesByMonth.get(month) ?? { net: 0, cogs: 0 };
        const exp = expByMonth.get(month) ?? 0;
        const ret = retByMonth.get(month) ?? { net: 0, cogs: 0 };
        const net = s.net - ret.net; // revenue net of returns
        const cgs = s.cogs - ret.cogs; // cost net of returned goods
        return {
          month,
          salesNet: round2(net),
          cogs: round2(cgs),
          expenses: round2(exp),
          profit: round2(net - cgs - exp),
        };
      });

    // Per-bill profit/loss (most recent 100 sales) incl. charges on that bill.
    const billRows = await prisma.$queryRaw<
      Array<{
        id: string;
        number: string;
        date: Date;
        collected: number;
        taxrealized: number;
        cogs: number;
        expense: number;
        retnet: number;
        retcogs: number;
      }>
    >(Prisma.sql`
      SELECT inv.id AS id, inv."invoiceNumber" AS number, inv."invoiceDate" AS date,
             inv."amountPaid"::float AS collected,
             (inv."taxAmount" * inv."amountPaid" / NULLIF(inv.total, 0))::float AS taxrealized,
             COALESCE(c.cost, 0)::float AS cogs,
             COALESCE(e.exp, 0)::float AS expense,
             COALESCE(r.net, 0)::float AS retnet,
             COALESCE(r.cogs, 0)::float AS retcogs
      FROM "Invoice" inv
      LEFT JOIN LATERAL (
        SELECT SUM(ii.quantity * i."purchasePrice" / (1 + i."taxRate" / 100)) AS cost
        FROM "InvoiceItem" ii JOIN "Item" i ON i.id = ii."itemId"
        WHERE ii."invoiceId" = inv.id
      ) c ON true
      LEFT JOIN LATERAL (
        SELECT SUM(amount) AS exp FROM "Expense" ex WHERE ex."invoiceId" = inv.id
      ) e ON true
      LEFT JOIN LATERAL (
        SELECT SUM("netAmount") AS net, SUM(cogs) AS cogs
        FROM "CreditNote" cn WHERE cn."invoiceId" = inv.id
      ) r ON true
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY inv."invoiceDate" DESC, inv."invoiceNumber" DESC
      LIMIT 100
    `);

    res.json({
      shop: business.name,
      period: { from: from ?? null, to: to ?? null },
      pnl: {
        salesGross: round2(salesGross),
        amountCollected: round2(amountCollected),
        outstanding: round2(outstanding),
        returns: round2(returnsTotal),
        salesNet: round2(adjNetRevenue),
        cogs: round2(adjCogs),
        grossProfit: round2(adjGrossProfit),
        grossMarginPct: adjNetRevenue ? round2((adjGrossProfit / adjNetRevenue) * 100) : 0,
        expenses: round2(totalExpenses),
        netProfit: round2(netProfit),
        netMarginPct: adjNetRevenue ? round2((netProfit / adjNetRevenue) * 100) : 0,
        taxCollected: round2(taxCollected),
        purchases: round2(Number(purchases._sum.total ?? 0)),
        taxPaid: round2(Number(purchases._sum.taxAmount ?? 0)),
        salesCount: sales._count,
        purchaseCount: purchases._count,
      },
      monthly,
      bills: billRows.map((b) => {
        const rev = round2(Number(b.collected) - Number(b.taxrealized) - Number(b.retnet));
        const c = round2(Number(b.cogs) - Number(b.retcogs));
        const exp = round2(Number(b.expense));
        return {
          id: b.id,
          number: b.number,
          date: b.date,
          revenue: rev,
          cogs: c,
          expense: exp,
          profit: round2(rev - c - exp),
        };
      }),
    });
  })
);

// GET /api/admin/invoices/:invoiceId — full invoice (items, party, shop) so
// the admin can open/print any bill.
router.get(
  "/invoices/:invoiceId",
  asyncHandler(async (req, res) => {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.invoiceId },
      include: {
        items: true,
        party: true,
        business: {
          select: { name: true, gstin: true, phone: true, email: true, address: true },
        },
        payments: { orderBy: { paymentDate: "asc" } },
      },
    });
    if (!invoice) throw notFound("Bill not found");
    res.json({ invoice });
  })
);

// GET /api/admin/invoices/:invoiceId/pnl — full P&L breakdown for ONE bill.
router.get(
  "/invoices/:invoiceId/pnl",
  asyncHandler(async (req, res) => {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.invoiceId },
      include: {
        items: true,
        party: { select: { name: true } },
        business: { select: { name: true } },
      },
    });
    if (!invoice) throw notFound("Bill not found");

    const [cogsRows, chargeGroups, returnAgg] = await Promise.all([
      prisma.$queryRaw<Array<{ cogs: number }>>(Prisma.sql`
        SELECT COALESCE(SUM(ii.quantity * i."purchasePrice" / (1 + i."taxRate" / 100)), 0)::float AS cogs
        FROM "InvoiceItem" ii JOIN "Item" i ON i.id = ii."itemId"
        WHERE ii."invoiceId" = ${invoice.id}
      `),
      prisma.expense.groupBy({
        by: ["category"],
        where: { invoiceId: invoice.id },
        _sum: { amount: true },
      }),
      prisma.creditNote.aggregate({
        where: { invoiceId: invoice.id },
        _sum: { netAmount: true, totalAmount: true, cogs: true },
      }),
    ]);

    const grossCogs = Number(cogsRows[0]?.cogs ?? 0);
    const charges = chargeGroups.map((g) => ({
      category: g.category,
      amount: round2(Number(g._sum.amount ?? 0)),
    }));
    const chargesTotal = charges.reduce((s, c) => s + c.amount, 0);

    const returnNet = Number(returnAgg._sum.netAmount ?? 0);
    const returnTotal = Number(returnAgg._sum.totalAmount ?? 0);
    const returnCogs = Number(returnAgg._sum.cogs ?? 0);

    const subtotal = Number(invoice.subtotal);
    const discount = Number(invoice.discount);
    const gst = Number(invoice.taxAmount);
    const total = Number(invoice.total);
    // Net of returns.
    const netSale = subtotal - discount - returnNet; // ex-GST, after returns
    const cogs = grossCogs - returnCogs;
    const grossProfit = netSale - cogs;
    const netProfit = grossProfit - chargesTotal;

    res.json({
      bill: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        date: invoice.invoiceDate,
        party: invoice.party?.name ?? "—",
        shop: invoice.business?.name ?? "—",
        status: invoice.status,
      },
      statement: {
        subtotal: round2(subtotal),
        discount: round2(discount),
        netSale: round2(netSale),
        gst: round2(gst),
        totalBilled: round2(total), // incl GST
        amountCollected: round2(Number(invoice.amountPaid)),
        outstanding: round2(total - Number(invoice.amountPaid) - returnTotal),
        returns: round2(returnTotal),
        cogs: round2(cogs),
        grossProfit: round2(grossProfit),
        charges,
        chargesTotal: round2(chargesTotal),
        netProfit: round2(netProfit),
        netMarginPct: netSale ? round2((netProfit / netSale) * 100) : 0,
      },
    });
  })
);

// GET /api/admin/businesses/:id/sales-report?from=&to=&groupBy=month|quarter|year
// Sales totals split by sales channel (retail/POS vs online) and grouped by the
// chosen period.
router.get(
  "/businesses/:id/sales-report",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const business = await prisma.business.findUnique({
      where: { id },
      select: { name: true },
    });
    if (!business) throw notFound("Shop not found");

    const { from, to } = dateRange(req);

    // Period grouping: month (default), quarter or year.
    const groupByRaw = String(req.query.groupBy ?? "month").toLowerCase();
    const groupBy = ["month", "quarter", "year"].includes(groupByRaw)
      ? groupByRaw
      : "month";
    const labelExpr =
      groupBy === "year"
        ? Prisma.sql`to_char(date_trunc('year', "invoiceDate"), 'YYYY')`
        : groupBy === "quarter"
        ? Prisma.sql`to_char(date_trunc('quarter', "invoiceDate"), 'YYYY-"Q"Q')`
        : Prisma.sql`to_char(date_trunc('month', "invoiceDate"), 'YYYY-MM')`;

    const conditions = [
      Prisma.sql`"businessId" = ${id}`,
      Prisma.sql`type = 'SALE'`,
    ];
    if (from) conditions.push(Prisma.sql`"invoiceDate" >= ${from}`);
    if (to) conditions.push(Prisma.sql`"invoiceDate" <= ${to}`);

    const rows = await prisma.$queryRaw<
      Array<{
        period: string;
        count: number;
        total: number;
        tax: number;
        online_count: number;
        online_total: number;
        online_tax: number;
        pos_count: number;
        pos_total: number;
        pos_tax: number;
      }>
    >(Prisma.sql`
      SELECT ${labelExpr} AS period,
             COUNT(*)::int AS count,
             COALESCE(SUM(total), 0)::float AS total,
             COALESCE(SUM("taxAmount"), 0)::float AS tax,
             COUNT(*) FILTER (WHERE channel = 'ONLINE')::int AS online_count,
             COALESCE(SUM(total) FILTER (WHERE channel = 'ONLINE'), 0)::float AS online_total,
             COALESCE(SUM("taxAmount") FILTER (WHERE channel = 'ONLINE'), 0)::float AS online_tax,
             COUNT(*) FILTER (WHERE channel = 'POS')::int AS pos_count,
             COALESCE(SUM(total) FILTER (WHERE channel = 'POS'), 0)::float AS pos_total,
             COALESCE(SUM("taxAmount") FILTER (WHERE channel = 'POS'), 0)::float AS pos_tax
      FROM "Invoice"
      WHERE ${Prisma.join(conditions, " AND ")}
      GROUP BY 1
      ORDER BY 1 DESC
    `);

    const periods = rows.map((r) => ({
      // `month` kept as an alias for backward compatibility with older clients.
      period: r.period,
      month: r.period,
      count: Number(r.count),
      total: round2(Number(r.total)),
      tax: round2(Number(r.tax)),
      online: {
        count: Number(r.online_count),
        total: round2(Number(r.online_total)),
        tax: round2(Number(r.online_tax)),
      },
      retail: {
        count: Number(r.pos_count),
        total: round2(Number(r.pos_total)),
        tax: round2(Number(r.pos_tax)),
      },
    }));

    const sum = (pick: (p: (typeof periods)[number]) => number) =>
      round2(periods.reduce((s, p) => s + pick(p), 0));
    const sumInt = (pick: (p: (typeof periods)[number]) => number) =>
      periods.reduce((s, p) => s + pick(p), 0);

    res.json({
      shop: business.name,
      groupBy,
      period: { from: from ?? null, to: to ?? null },
      // `months` kept for backward compatibility; `periods` is the new shape.
      months: periods,
      periods,
      totals: {
        total: sum((p) => p.total),
        tax: sum((p) => p.tax),
        count: sumInt((p) => p.count),
        online: {
          total: sum((p) => p.online.total),
          tax: sum((p) => p.online.tax),
          count: sumInt((p) => p.online.count),
        },
        retail: {
          total: sum((p) => p.retail.total),
          tax: sum((p) => p.retail.tax),
          count: sumInt((p) => p.retail.count),
        },
      },
    });
  })
);

// GET /api/admin/businesses/:id/suppliers-analysis?from=&to= — per-supplier
// performance: total purchased (IN), total sold of their products (OUT),
// profit and margin, so you can see which supplier performs best.
router.get(
  "/businesses/:id/suppliers-analysis",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const { from, to } = dateRange(req);

    const purCond = [Prisma.sql`"businessId" = ${id}`, Prisma.sql`type = 'PURCHASE'`];
    if (from) purCond.push(Prisma.sql`"invoiceDate" >= ${from}`);
    if (to) purCond.push(Prisma.sql`"invoiceDate" <= ${to}`);

    const saleCond = [
      Prisma.sql`inv."businessId" = ${id}`,
      Prisma.sql`inv.type = 'SALE'`,
      Prisma.sql`i."supplierId" IS NOT NULL`,
    ];
    if (from) saleCond.push(Prisma.sql`inv."invoiceDate" >= ${from}`);
    if (to) saleCond.push(Prisma.sql`inv."invoiceDate" <= ${to}`);

    const [suppliers, purchaseRows, salesRows, itemCountRows, stockRows] = await Promise.all([
      prisma.party.findMany({
        where: { businessId: id, type: "SUPPLIER" },
        select: { id: true, name: true, phone: true },
        orderBy: { name: "asc" },
      }),
      prisma.$queryRaw<Array<{ sid: string; inval: number }>>(Prisma.sql`
        SELECT "partyId" AS sid, COALESCE(SUM(total), 0)::float AS inval
        FROM "Invoice" WHERE ${Prisma.join(purCond, " AND ")} GROUP BY 1
      `),
      prisma.$queryRaw<Array<{ sid: string; outval: number; cogs: number }>>(Prisma.sql`
        SELECT i."supplierId" AS sid,
               COALESCE(SUM(ii.amount), 0)::float AS outval,
               COALESCE(SUM(ii.quantity * i."purchasePrice" / (1 + i."taxRate" / 100)), 0)::float AS cogs
        FROM "InvoiceItem" ii
        JOIN "Item" i ON i.id = ii."itemId"
        JOIN "Invoice" inv ON inv.id = ii."invoiceId"
        WHERE ${Prisma.join(saleCond, " AND ")} GROUP BY 1
      `),
      prisma.$queryRaw<Array<{ sid: string; cnt: number }>>(Prisma.sql`
        SELECT "supplierId" AS sid, COUNT(*)::int AS cnt FROM "Item"
        WHERE "businessId" = ${id} AND "supplierId" IS NOT NULL GROUP BY 1
      `),
      // Stock value of each supplier's products as of the selected "To" date
      // (reconstructed from the stock ledger). No date => current stock.
      prisma.$queryRaw<Array<{ sid: string; value: number }>>(Prisma.sql`
        SELECT i."supplierId" AS sid,
               COALESCE(SUM(${
                 to
                   ? Prisma.sql`(i."stockQty" - COALESCE((SELECT SUM(quantity) FROM "StockMovement" sm WHERE sm."itemId" = i.id AND sm."createdAt" > ${to}), 0))`
                   : Prisma.sql`i."stockQty"`
               } * i."purchasePrice"), 0)::float AS value
        FROM "Item" i
        WHERE i."businessId" = ${id} AND i."supplierId" IS NOT NULL AND i."isService" = false
        GROUP BY 1
      `),
    ]);

    const inMap = new Map(purchaseRows.map((r) => [r.sid, Number(r.inval)]));
    const outMap = new Map(
      salesRows.map((r) => [r.sid, { out: Number(r.outval), cogs: Number(r.cogs) }])
    );
    const cntMap = new Map(itemCountRows.map((r) => [r.sid, Number(r.cnt)]));
    const stockMap = new Map(stockRows.map((r) => [r.sid, Number(r.value)]));

    const rows = suppliers
      .map((s) => {
        const purchaseIn = inMap.get(s.id) ?? 0;
        const so = outMap.get(s.id) ?? { out: 0, cogs: 0 };
        const profit = so.out - so.cogs;
        return {
          id: s.id,
          name: s.name,
          phone: s.phone,
          purchaseIn: round2(purchaseIn),
          salesOut: round2(so.out),
          cogs: round2(so.cogs),
          profit: round2(profit),
          marginPct: so.out ? round2((profit / so.out) * 100) : 0,
          productCount: cntMap.get(s.id) ?? 0,
          stockValue: round2(stockMap.get(s.id) ?? 0),
        };
      })
      .sort((a, b) => b.profit - a.profit);

    const best = rows.find((r) => r.profit > 0) ?? null;
    res.json({
      suppliers: rows,
      best: best ? { name: best.name, profit: best.profit, marginPct: best.marginPct } : null,
    });
  })
);

// GET /api/admin/parties/:partyId/stock?from=&to= — all stock items supplied
// by this supplier. Stock value is as of the "To" date; stock in/out are the
// movements within the date range.
router.get(
  "/parties/:partyId/stock",
  asyncHandler(async (req, res) => {
    const party = await prisma.party.findUnique({
      where: { id: req.params.partyId },
      select: { id: true, name: true, businessId: true },
    });
    if (!party) throw notFound("Supplier not found");

    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;

    const rangeCond = (signFilter: ReturnType<typeof Prisma.sql>) => {
      const conds = [Prisma.sql`sm."itemId" = i.id`, signFilter];
      if (from) conds.push(Prisma.sql`sm."createdAt" >= ${from}`);
      if (to) conds.push(Prisma.sql`sm."createdAt" <= ${to}`);
      return Prisma.join(conds, " AND ");
    };

    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        sku: string | null;
        unit: string;
        purchaseprice: number;
        saleprice: number;
        lowalert: number;
        qtyasof: number;
        inqty: number;
        outqty: number;
      }>
    >(Prisma.sql`
      SELECT i.id, i.name, i.sku, i.unit,
             i."purchasePrice"::float AS purchaseprice,
             i."salePrice"::float AS saleprice,
             i."lowStockAlert"::float AS lowalert,
             (i."stockQty" - ${
               to
                 ? Prisma.sql`COALESCE((SELECT SUM(quantity) FROM "StockMovement" sm WHERE sm."itemId" = i.id AND sm."createdAt" > ${to}), 0)`
                 : Prisma.sql`0`
             })::float AS qtyasof,
             COALESCE((SELECT SUM(quantity) FROM "StockMovement" sm WHERE ${rangeCond(
               Prisma.sql`quantity > 0`
             )}), 0)::float AS inqty,
             COALESCE((SELECT SUM(-quantity) FROM "StockMovement" sm WHERE ${rangeCond(
               Prisma.sql`quantity < 0`
             )}), 0)::float AS outqty
      FROM "Item" i
      WHERE i."supplierId" = ${party.id} AND i."isService" = false
      ORDER BY i.name ASC
    `);

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      sku: r.sku,
      unit: r.unit,
      stockQty: round2(Number(r.qtyasof)),
      stockIn: round2(Number(r.inqty)),
      stockOut: round2(Number(r.outqty)),
      purchasePrice: round2(Number(r.purchaseprice)),
      salePrice: round2(Number(r.saleprice)),
      low: Number(r.qtyasof) <= Number(r.lowalert),
      value: round2(Number(r.qtyasof) * Number(r.purchaseprice)),
    }));

    res.json({
      supplier: { id: party.id, name: party.name },
      asOf: to ?? null,
      totalValue: round2(items.reduce((s, r) => s + r.value, 0)),
      items,
    });
  })
);

// GET /api/admin/businesses/:id/cashbook?from=&to= — day book: daily credit
// (money in) / debit (money out), running cash & bank balances, plus the
// receivable and payable bills behind "balance to receive / to pay".
router.get(
  "/businesses/:id/cashbook",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const business = await prisma.business.findUnique({
      where: { id },
      select: { name: true, openingCash: true, openingBank: true },
    });
    if (!business) throw notFound("Shop not found");

    const { from, to } = dateRange(req);

    // Cash = CASH method; everything else (bank/UPI/card/cheque) hits the bank.
    // "Bank Deposit"/"Bank Withdrawal" are internal cash<->bank transfers (they
    // move money between cash and bank, but aren't real credit/debit).
    const flows = (
      rows: Array<{ direction: string; method: string; purpose: string | null; amt: number }>
    ) => {
      let credit = 0,
        debit = 0,
        cashDelta = 0,
        bankDelta = 0;
      for (const r of rows) {
        if (r.purpose === "Bank Deposit") {
          cashDelta -= r.amt;
          bankDelta += r.amt;
          continue;
        }
        if (r.purpose === "Bank Withdrawal") {
          bankDelta -= r.amt;
          cashDelta += r.amt;
          continue;
        }
        const cash = r.method === "CASH";
        if (r.direction === "IN") {
          credit += r.amt;
          cash ? (cashDelta += r.amt) : (bankDelta += r.amt);
        } else {
          debit += r.amt;
          cash ? (cashDelta -= r.amt) : (bankDelta -= r.amt);
        }
      }
      return { credit, debit, cashDelta, bankDelta };
    };

    const [beforeRows, rangeRows, receivableInvoices, payableInvoices, creditNotes] =
      await Promise.all([
        // Movements before the period — to roll the opening balance forward.
        from
          ? prisma.$queryRaw<
              Array<{ direction: string; method: string; purpose: string | null; amt: number }>
            >(
              Prisma.sql`SELECT direction::text, method::text, purpose, COALESCE(SUM(amount),0)::float AS amt
                         FROM "Payment" WHERE "businessId" = ${id} AND "paymentDate" < ${from}
                         GROUP BY 1, 2, 3`
            )
          : Promise.resolve([]),
        prisma.$queryRaw<
          Array<{ day: string; direction: string; method: string; purpose: string | null; amt: number }>
        >(Prisma.sql`
          SELECT to_char(date_trunc('day', "paymentDate"), 'YYYY-MM-DD') AS day,
                 direction::text, method::text, purpose, COALESCE(SUM(amount),0)::float AS amt
          FROM "Payment"
          WHERE "businessId" = ${id}
            ${from ? Prisma.sql`AND "paymentDate" >= ${from}` : Prisma.empty}
            ${to ? Prisma.sql`AND "paymentDate" <= ${to}` : Prisma.empty}
          GROUP BY 1, 2, 3, 4 ORDER BY 1
        `),
        prisma.invoice.findMany({
          where: { businessId: id, type: "SALE", status: { in: ["UNPAID", "PARTIAL"] } },
          include: { party: { select: { name: true } } },
          orderBy: { invoiceDate: "asc" },
        }),
        prisma.invoice.findMany({
          where: { businessId: id, type: "PURCHASE", status: { in: ["UNPAID", "PARTIAL"] } },
          include: { party: { select: { name: true } } },
          orderBy: { invoiceDate: "asc" },
        }),
        prisma.creditNote.groupBy({
          by: ["invoiceId"],
          where: { businessId: id },
          _sum: { totalAmount: true },
        }),
      ]);

    // Expenses paid in cash/bank also move money out of the shop, so fold them
    // into the cash book (money given). Expenses without a method don't move
    // cash (e.g. a charge booked against a bill).
    const expBeforeRows = from
      ? await prisma.$queryRaw<Array<{ method: string; amt: number }>>(
          Prisma.sql`SELECT method, COALESCE(SUM(amount),0)::float AS amt
                     FROM "Expense"
                     WHERE "businessId" = ${id} AND method IS NOT NULL AND date < ${from}
                     GROUP BY 1`
        )
      : [];
    const expRangeRows = await prisma.$queryRaw<
      Array<{ day: string; method: string; amt: number }>
    >(Prisma.sql`
      SELECT to_char(date_trunc('day', date), 'YYYY-MM-DD') AS day,
             method, COALESCE(SUM(amount),0)::float AS amt
      FROM "Expense"
      WHERE "businessId" = ${id} AND method IS NOT NULL
        ${from ? Prisma.sql`AND date >= ${from}` : Prisma.empty}
        ${to ? Prisma.sql`AND date <= ${to}` : Prisma.empty}
      GROUP BY 1, 2 ORDER BY 1
    `);
    const asExpenseFlow = (r: { method: string; amt: number }) => ({
      direction: "OUT",
      method: r.method,
      purpose: "Expense" as string | null,
      amt: r.amt,
    });

    const cnMap = new Map(
      creditNotes.map((c) => [c.invoiceId, Number(c._sum.totalAmount ?? 0)])
    );
    const bill = (inv: (typeof receivableInvoices)[number]) => {
      const due =
        Number(inv.total) - Number(inv.amountPaid) - (cnMap.get(inv.id) ?? 0);
      return {
        id: inv.id,
        number: inv.invoiceNumber,
        party: inv.party?.name ?? "—",
        date: inv.invoiceDate,
        total: round2(Number(inv.total)),
        paid: round2(Number(inv.amountPaid)),
        due: round2(due),
      };
    };
    const receivables = receivableInvoices.map(bill).filter((b) => b.due > 0.009);
    const payables = payableInvoices.map(bill).filter((b) => b.due > 0.009);

    // Opening balances at the start of the period.
    const before = flows([...beforeRows, ...expBeforeRows.map(asExpenseFlow)]);
    let cash = Number(business.openingCash) + before.cashDelta;
    let bank = Number(business.openingBank) + before.bankDelta;
    const openingCash = round2(cash);
    const openingBank = round2(bank);

    // Daily rows with running balances.
    const byDay = new Map<
      string,
      Array<{ direction: string; method: string; purpose: string | null; amt: number }>
    >();
    for (const r of rangeRows) {
      const list = byDay.get(r.day) ?? [];
      list.push(r);
      byDay.set(r.day, list);
    }
    for (const r of expRangeRows) {
      const list = byDay.get(r.day) ?? [];
      list.push(asExpenseFlow(r));
      byDay.set(r.day, list);
    }
    const days = Array.from(byDay.keys())
      .sort()
      .map((day) => {
        const f = flows(byDay.get(day)!);
        cash += f.cashDelta;
        bank += f.bankDelta;
        return {
          day,
          credit: round2(f.credit),
          debit: round2(f.debit),
          cashBalance: round2(cash),
          bankBalance: round2(bank),
        };
      });

    res.json({
      shop: business.name,
      openingCash,
      openingBank,
      cashBalance: round2(cash),
      bankBalance: round2(bank),
      toReceive: round2(receivables.reduce((s, b) => s + b.due, 0)),
      toPay: round2(payables.reduce((s, b) => s + b.due, 0)),
      days,
      receivables,
      payables,
    });
  })
);

// GET /api/admin/businesses/:id/vouchers?direction=IN|OUT&from=&to= — credit /
// payment voucher report with party, bill and cash/bank details.
router.get(
  "/businesses/:id/vouchers",
  asyncHandler(async (req, res) => {
    const { from, to, filter: _f } = dateRange(req);
    const direction = req.query.direction ? String(req.query.direction) : undefined;
    const payments = await prisma.payment.findMany({
      where: {
        businessId: req.params.id,
        ...(direction === "IN" || direction === "OUT" ? { direction } : {}),
        ...(from || to
          ? {
              paymentDate: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      include: {
        party: { select: { name: true, type: true } },
        invoice: { select: { invoiceNumber: true } },
      },
      orderBy: { paymentDate: "desc" },
      take: 500,
    });
    res.json({ payments });
  })
);

// GET /api/admin/businesses/:id/parties?type=CUSTOMER|SUPPLIER — ledger summary
// (balance per party) used by the customer ledger / purchase ledger reports.
router.get(
  "/businesses/:id/parties",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const type =
      String(req.query.type ?? "CUSTOMER").toUpperCase() === "SUPPLIER"
        ? "SUPPLIER"
        : "CUSTOMER";
    const invoiceType = type === "CUSTOMER" ? "SALE" : "PURCHASE";

    const parties = await prisma.party.findMany({
      where: { businessId: id, type: type as never },
      orderBy: { name: "asc" },
    });
    const [invAgg, payAgg] = await Promise.all([
      prisma.invoice.groupBy({
        by: ["partyId"],
        where: { businessId: id, type: invoiceType as never },
        _sum: { total: true },
      }),
      prisma.payment.groupBy({
        by: ["partyId"],
        where: { businessId: id },
        _sum: { amount: true },
      }),
    ]);
    const invMap = new Map(invAgg.map((r) => [r.partyId, Number(r._sum.total ?? 0)]));
    const payMap = new Map(payAgg.map((r) => [r.partyId, Number(r._sum.amount ?? 0)]));

    const rows = parties.map((p) => {
      const billed = invMap.get(p.id) ?? 0;
      const paid = payMap.get(p.id) ?? 0;
      return {
        id: p.id,
        name: p.name,
        phone: p.phone,
        gstin: p.gstin,
        billed: round2(billed),
        paid: round2(paid),
        balance: round2(Number(p.openingBalance) + billed - paid),
      };
    });
    res.json({ type, parties: rows });
  })
);

// GET /api/admin/parties/:partyId/ledger — full transaction ledger for a party
// (customer or supplier) with a running balance.
router.get(
  "/parties/:partyId/ledger",
  asyncHandler(async (req, res) => {
    const party = await prisma.party.findUnique({
      where: { id: req.params.partyId },
      include: {
        business: {
          select: { name: true, gstin: true, phone: true, email: true, address: true },
        },
      },
    });
    if (!party) throw notFound("Party not found");
    const invoiceType = party.type === "CUSTOMER" ? "SALE" : "PURCHASE";

    const [invoices, payments, creditNotes] = await Promise.all([
      prisma.invoice.findMany({
        where: { partyId: party.id, type: invoiceType as never },
        select: { invoiceNumber: true, invoiceDate: true, total: true },
      }),
      prisma.payment.findMany({
        where: { partyId: party.id },
        select: { paymentDate: true, amount: true, method: true },
      }),
      // Returns (credit notes) reduce what the party owes.
      prisma.creditNote.findMany({
        where: { partyId: party.id },
        select: { date: true, totalAmount: true, invoiceNumber: true },
      }),
    ]);

    type Entry = { date: Date; kind: string; ref: string; debit: number; credit: number };
    const entries: Entry[] = [];
    for (const inv of invoices) {
      entries.push({
        date: inv.invoiceDate,
        kind: invoiceType === "SALE" ? "Sale Invoice" : "Purchase Invoice",
        ref: inv.invoiceNumber,
        debit: Number(inv.total),
        credit: 0,
      });
    }
    for (const p of payments) {
      entries.push({
        date: p.paymentDate,
        kind: `Payment (${p.method})`,
        ref: "",
        debit: 0,
        credit: Number(p.amount),
      });
    }
    for (const cn of creditNotes) {
      entries.push({
        date: cn.date,
        kind: "Sales Return",
        ref: cn.invoiceNumber ?? "",
        debit: 0,
        credit: Number(cn.totalAmount),
      });
    }
    entries.sort((a, b) => a.date.getTime() - b.date.getTime());

    let balance = Number(party.openingBalance);
    const ledger = entries.map((e) => {
      balance += e.debit - e.credit;
      return {
        date: e.date,
        kind: e.kind,
        ref: e.ref,
        debit: round2(e.debit),
        credit: round2(e.credit),
        balance: round2(balance),
      };
    });

    res.json({
      party: {
        id: party.id,
        name: party.name,
        type: party.type,
        phone: party.phone,
        gstin: party.gstin,
        billingAddress: party.billingAddress,
        openingBalance: round2(Number(party.openingBalance)),
        shop: party.business.name,
      },
      business: party.business,
      closingBalance: round2(balance),
      ledger,
    });
  })
);

// ---- Shop logins: one login per shop (created by the platform admin) -------

const shopLoginSchema = z.object({
  name: z.string().min(1),
  username: z
    .string()
    .min(3)
    .regex(/^[a-zA-Z0-9._-]+$/, "Use letters, numbers, dot, underscore or dash only"),
  password: z.string().min(6),
});

// GET /api/admin/businesses/:id/logins — the logins that can access this shop.
router.get(
  "/businesses/:id/logins",
  asyncHandler(async (req, res) => {
    const memberships = await prisma.membership.findMany({
      where: { businessId: req.params.id },
      include: { user: { select: { id: true, name: true, username: true, email: true } } },
      orderBy: { createdAt: "asc" },
    });
    res.json({
      logins: memberships.map((m) => ({
        userId: m.user.id,
        name: m.user.name,
        username: m.user.username,
        email: m.user.email,
        role: m.role,
      })),
    });
  })
);

// POST /api/admin/businesses/:id/login — create ONE login for this shop. The
// account can manage only this shop (role MANAGER).
router.post(
  "/businesses/:id/login",
  validateBody(shopLoginSchema),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const business = await prisma.business.findUnique({ where: { id } });
    if (!business) throw notFound("Shop not found");

    const username = String(req.body.username).toLowerCase();
    const syntheticEmail = `${username}@shop.laxora`;
    const existing = await prisma.user.findFirst({
      where: { OR: [{ username }, { email: syntheticEmail }, { email: username }] },
    });
    if (existing) throw conflict("That username is already taken");

    const passwordHash = await hashPassword(req.body.password);
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: { name: req.body.name, username, email: syntheticEmail, passwordHash },
      });
      await tx.membership.create({
        data: { userId: u.id, businessId: id, role: "MANAGER" },
      });
      return u;
    });

    res.status(201).json({
      login: { userId: user.id, name: user.name, username: user.username },
    });
  })
);

// POST /api/admin/logins/:userId/password — reset a shop login's password.
router.post(
  "/logins/:userId/password",
  validateBody(z.object({ password: z.string().min(6) })),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!user) throw notFound("Login not found");
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(req.body.password) },
    });
    res.json({ ok: true });
  })
);

// DELETE /api/admin/logins/:userId — remove a shop login.
router.delete(
  "/logins/:userId",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: { isPlatformAdmin: true },
    });
    if (!user) throw notFound("Login not found");
    if (user.isPlatformAdmin) throw badRequest("Cannot delete a platform admin here");
    await prisma.user.delete({ where: { id: req.params.userId } });
    res.status(204).send();
  })
);

// ---- Product edit approvals ------------------------------------------------

// GET /api/admin/change-requests?status=PENDING — product edits awaiting review.
// pendingCount includes invoice-deletion requests so the sidebar badge covers both.
router.get(
  "/change-requests",
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : "PENDING";
    const [requests, deletePending] = await Promise.all([
      prisma.itemChangeRequest.findMany({
        where: { status },
        include: { business: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      prisma.invoiceDeleteRequest.count({ where: { status: "PENDING" } }),
    ]);
    res.json({ requests, pendingCount: requests.length + deletePending });
  })
);

// ---- Invoice deletion approvals ---------------------------------------------

// GET /api/admin/delete-requests?status=PENDING
router.get(
  "/delete-requests",
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : "PENDING";
    const requests = await prisma.invoiceDeleteRequest.findMany({
      where: { status },
      include: { business: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ requests });
  })
);

// POST /api/admin/delete-requests/:id/approve — delete the bill (stock reversed).
router.post(
  "/delete-requests/:id/approve",
  asyncHandler(async (req, res) => {
    const request = await prisma.invoiceDeleteRequest.findUnique({
      where: { id: req.params.id },
    });
    if (!request) throw notFound("Request not found");
    if (request.status !== "PENDING") throw badRequest("This request was already reviewed");

    await deleteInvoiceWithReversal(request.invoiceId, request.businessId, req.auth!.userId);
    await prisma.invoiceDeleteRequest.update({
      where: { id: request.id },
      data: { status: "APPROVED", reviewedAt: new Date() },
    });
    res.json({ ok: true });
  })
);

// POST /api/admin/delete-requests/:id/reject — keep the bill.
router.post(
  "/delete-requests/:id/reject",
  asyncHandler(async (req, res) => {
    const request = await prisma.invoiceDeleteRequest.findUnique({
      where: { id: req.params.id },
    });
    if (!request) throw notFound("Request not found");
    await prisma.invoiceDeleteRequest.update({
      where: { id: request.id },
      data: { status: "REJECTED", reviewedAt: new Date() },
    });
    res.status(204).send();
  })
);

// ---- Return removal approvals ----------------------------------------------

// GET /api/admin/return-removals?status=PENDING — wrong returns awaiting review.
router.get(
  "/return-removals",
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : "PENDING";
    const requests = await prisma.returnRemovalRequest.findMany({
      where: { status },
      include: { business: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ requests, pendingCount: requests.length });
  })
);

// POST /api/admin/return-removals/:id/approve — reverse the return.
router.post(
  "/return-removals/:id/approve",
  asyncHandler(async (req, res) => {
    const request = await prisma.returnRemovalRequest.findUnique({
      where: { id: req.params.id },
    });
    if (!request) throw notFound("Request not found");
    if (request.status !== "PENDING") throw badRequest("This request was already reviewed");

    const reviewer = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { name: true, username: true, email: true },
    });

    // reverseCreditNote is a no-op if the note was already removed; either way
    // the request is closed so it leaves the queue.
    await reverseCreditNote(request.creditNoteId, request.businessId, req.auth!.userId);
    await prisma.returnRemovalRequest.update({
      where: { id: request.id },
      data: {
        status: "APPROVED",
        reviewedAt: new Date(),
        reviewedByName: reviewer?.name ?? reviewer?.username ?? reviewer?.email ?? null,
      },
    });
    res.json({ ok: true });
  })
);

// POST /api/admin/return-removals/:id/reject — keep the return.
router.post(
  "/return-removals/:id/reject",
  asyncHandler(async (req, res) => {
    const request = await prisma.returnRemovalRequest.findUnique({
      where: { id: req.params.id },
    });
    if (!request) throw notFound("Request not found");
    const reviewer = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { name: true, username: true, email: true },
    });
    await prisma.returnRemovalRequest.update({
      where: { id: request.id },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedByName: reviewer?.name ?? reviewer?.username ?? reviewer?.email ?? null,
      },
    });
    res.status(204).send();
  })
);

// GET /api/admin/change-requests/:id — request + current item, for the diff.
router.get(
  "/change-requests/:id",
  asyncHandler(async (req, res) => {
    const request = await prisma.itemChangeRequest.findUnique({
      where: { id: req.params.id },
      include: { business: { select: { name: true } } },
    });
    if (!request) throw notFound("Request not found");
    const item = await prisma.item.findUnique({ where: { id: request.itemId } });
    res.json({ request, item });
  })
);

// POST /api/admin/change-requests/:id/approve — apply the edit.
router.post(
  "/change-requests/:id/approve",
  asyncHandler(async (req, res) => {
    const request = await prisma.itemChangeRequest.findUnique({
      where: { id: req.params.id },
    });
    if (!request) throw notFound("Request not found");
    if (request.status !== "PENDING") throw badRequest("This request was already reviewed");
    await prisma.$transaction(async (tx) => {
      await tx.item.update({
        where: { id: request.itemId },
        data: request.changes as Prisma.ItemUpdateInput,
      });
      await tx.itemChangeRequest.update({
        where: { id: request.id },
        data: { status: "APPROVED", reviewedAt: new Date() },
      });
    });
    res.json({ ok: true });
  })
);

// POST /api/admin/change-requests/:id/reject — discard the edit.
router.post(
  "/change-requests/:id/reject",
  asyncHandler(async (req, res) => {
    const request = await prisma.itemChangeRequest.findUnique({
      where: { id: req.params.id },
    });
    if (!request) throw notFound("Request not found");
    await prisma.itemChangeRequest.update({
      where: { id: request.id },
      data: { status: "REJECTED", reviewedAt: new Date() },
    });
    res.status(204).send();
  })
);

// GET /api/admin/users — every user with their business count.
router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const search = req.query.search ? String(req.query.search) : undefined;
    const users = await prisma.user.findMany({
      where: search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
            ],
          }
        : undefined,
      select: {
        id: true,
        name: true,
        email: true,
        isPlatformAdmin: true,
        createdAt: true,
        _count: { select: { memberships: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ users });
  })
);

// DELETE /api/admin/businesses/:id — remove a business and all its data.
router.delete(
  "/businesses/:id",
  asyncHandler(async (req, res) => {
    const biz = await prisma.business.findUnique({ where: { id: req.params.id } });
    if (!biz) throw notFound("Business not found");
    // Cascades delete memberships, parties, items, invoices, payments.
    await prisma.business.delete({ where: { id: req.params.id } });
    res.status(204).send();
  })
);

export default router;
