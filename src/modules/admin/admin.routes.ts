import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, conflict, notFound } from "../../utils/errors";
import { hashPassword } from "../../utils/password";
import { deleteInvoiceWithReversal, reverseReturn } from "../../lib/invoiceOps";
import { billDue, reconcilePayments, refundedByInvoice } from "../../lib/settlement";
import { buildPartyLedger } from "../../lib/ledger";
import { INCOME_PURPOSE_LIST } from "../../lib/income";

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
// With ?businessId=… the numbers are scoped to that one shop instead, so the
// Overview page can follow the sidebar's selected shop.
router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const businessId = req.query.businessId ? String(req.query.businessId) : undefined;
    if (businessId) {
      const [business, invoices, parties, items, logins, salesAgg] =
        await Promise.all([
          prisma.business.findUnique({
            where: { id: businessId },
            select: { id: true, name: true, code: true },
          }),
          prisma.invoice.count({ where: { businessId } }),
          prisma.party.count({ where: { businessId } }),
          prisma.item.count({ where: { businessId } }),
          prisma.membership.count({ where: { businessId } }),
          prisma.invoice.aggregate({
            where: { businessId, type: "SALE" },
            _sum: { total: true },
          }),
        ]);
      if (!business) throw notFound("Shop not found");
      res.json({
        shop: business,
        stats: {
          invoices,
          parties,
          items,
          logins,
          totalSalesVolume: Number(salesAgg._sum.total ?? 0),
        },
      });
      return;
    }
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
        // memberships = the logins that can actually open this shop. Zero means
        // the shop is unreachable: it will not appear in anyone's shop switcher.
        _count: {
          select: { invoices: true, parties: true, items: true, memberships: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ businesses });
  })
);

// POST /api/admin/businesses — create a new shop (owned by the platform admin).
// The creating admin also gets a membership on it. Access to a shop is granted
// by Membership alone — resolveTenant, the shop switcher and the select-shop
// screen all read that table — so a shop created without one is orphaned: it
// shows in the admin panel but no one can open or select it anywhere, and its
// "Shop Logins" list comes back empty. Mirrors POST /api/franchise/:id/shops,
// which already creates the owner's membership.
router.post(
  "/businesses",
  validateBody(
    z.object({
      name: z.string().min(1),
      code: z.string().optional(),
      gstin: z.string().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
      // Attach the new shop to a franchise so it immediately shows up as an
      // external transfer target for the franchise's other shops.
      franchiseId: z.string().optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const { franchiseId } = req.body as { franchiseId?: string };
    if (franchiseId) {
      const franchise = await prisma.franchise.findUnique({
        where: { id: franchiseId },
      });
      if (!franchise) throw notFound("Franchise not found");
    }
    const business = await prisma.$transaction(async (tx) => {
      const created = await tx.business.create({
        data: { ...req.body, ownerId: req.auth!.userId },
      });
      await tx.membership.create({
        data: { userId: req.auth!.userId, businessId: created.id, role: "OWNER" },
      });
      return created;
    });
    res.status(201).json({ business });
  })
);

// PATCH /api/admin/businesses/:id/franchise — attach an existing shop to a
// franchise (or detach with franchiseId: null). External stock transfers are
// only offered between shops of the SAME franchise, so a shop created without
// a franchise never appears in the other shops' "Destination shop" list until
// it is attached here.
router.patch(
  "/businesses/:id/franchise",
  validateBody(z.object({ franchiseId: z.string().min(1).nullable() })),
  asyncHandler(async (req, res) => {
    const { franchiseId } = req.body as { franchiseId: string | null };
    const business = await prisma.business.findUnique({
      where: { id: req.params.id },
    });
    if (!business) throw notFound("Shop not found");
    if (franchiseId) {
      const franchise = await prisma.franchise.findUnique({
        where: { id: franchiseId },
      });
      if (!franchise) throw notFound("Franchise not found");
    }
    const updated = await prisma.business.update({
      where: { id: business.id },
      data: { franchiseId },
      include: { franchise: { select: { id: true, name: true } } },
    });
    res.json({ business: updated });
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
        _sum: { total: true, amountPaid: true, taxAmount: true, subtotal: true, discount: true },
        _count: true,
      }),
      prisma.invoice.aggregate({
        where: { businessId: id, type: "PURCHASE", ...filter },
        _sum: { total: true, taxAmount: true },
        _count: true,
      }),
    ]);

    // The P&L is on an ACCRUAL basis (standard accounting): revenue is
    // recognised when a bill is raised — subtotal − discount, i.e. ex-GST —
    // and the cost of the goods on that bill is recognised with it (matching
    // principle). Whether the customer has paid yet does not change profit;
    // collections and the outstanding receivable are reported separately in
    // the "Collections" section. GST is a pass-through liability and is
    // excluded from income entirely. Purchase prices are entered GST-
    // inclusive, so COGS is divided by (1 + taxRate/100) to make it ex-GST —
    // matching ex-GST net sales — for an exact gross profit.
    const conditions = [
      Prisma.sql`inv."businessId" = ${id}`,
      Prisma.sql`inv.type = 'SALE'`,
    ];
    if (from) conditions.push(Prisma.sql`inv."invoiceDate" >= ${from}`);
    if (to) conditions.push(Prisma.sql`inv."invoiceDate" <= ${to}`);

    // Cash actually received = customer payments only, read straight from the
    // Payment table. A bill-linked charge settles the bill's due (it is inside
    // amountPaid) but is NOT customer cash — it is booked as an expense further
    // down. This feeds the Collections section, not profit.
    // Refund vouchers on a return/exchange are OUT movements against a sale
    // bill — they are money going back to the customer, so they are netted off
    // rather than added to what was collected.
    const collectedRows = await prisma.$queryRaw<Array<{ collected: number }>>(Prisma.sql`
      SELECT COALESCE(SUM(CASE WHEN p.direction::text = 'IN' THEN p.amount ELSE -p.amount END), 0)::float AS collected
      FROM "Payment" p
      JOIN "Invoice" inv ON inv.id = p."invoiceId"
      WHERE ${Prisma.join(conditions, " AND ")}
    `);
    const cogsRows = await prisma.$queryRaw<Array<{ cogs: number }>>(Prisma.sql`
      SELECT COALESCE(SUM(ii.quantity * i."purchasePrice" / (1 + i."taxRate" / 100)), 0)::float AS cogs
      FROM "InvoiceItem" ii
      JOIN "Invoice" inv ON inv.id = ii."invoiceId"
      JOIN "Item" i ON i.id = ii."itemId"
      WHERE ${Prisma.join(conditions, " AND ")}
    `);
    const grossCogs = Number(cogsRows[0]?.cogs ?? 0);

    const salesGross = Number(sales._sum.total ?? 0); // total billed incl GST
    const grossSales =
      Number(sales._sum.subtotal ?? 0) - Number(sales._sum.discount ?? 0); // ex-GST revenue billed
    const gstBilled = Number(sales._sum.taxAmount ?? 0); // GST payable on sales
    // amountPaid includes bill-linked charges (they settle the due); use it for
    // the receivable, but use the charge-free "collected" for real cash in.
    const amountSettled = Number(sales._sum.amountPaid ?? 0); // payments + charges
    const amountCollected = Number(collectedRows[0]?.collected ?? 0); // real cash in

    // Expenses / charges (commission, damage, returns, etc.) reduce profit.
    const expConditions = [Prisma.sql`"businessId" = ${id}`];
    if (from) expConditions.push(Prisma.sql`date >= ${from}`);
    if (to) expConditions.push(Prisma.sql`date <= ${to}`);

    // Service / other income = standalone credit vouchers (e.g. LED service).
    // They carry no COGS, so the full amount adds to gross and net profit.
    const svcConditions = [
      Prisma.sql`"businessId" = ${id}`,
      Prisma.sql`direction = 'IN'`,
      Prisma.sql`purpose IN (${Prisma.join(INCOME_PURPOSE_LIST)})`,
    ];
    if (from) svcConditions.push(Prisma.sql`"paymentDate" >= ${from}`);
    if (to) svcConditions.push(Prisma.sql`"paymentDate" <= ${to}`);

    const [expTotalRows, monthlyExpRows, retTotalRows, monthlyRetRows, svcTotalRows, monthlySvcRows] = await Promise.all([
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
      // Service / other income totals and monthly breakdown.
      prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT COALESCE(SUM(amount), 0)::float AS total FROM "Payment"
        WHERE ${Prisma.join(svcConditions, " AND ")}
      `),
      prisma.$queryRaw<Array<{ month: string; inc: number }>>(Prisma.sql`
        SELECT to_char(date_trunc('month', "paymentDate"), 'YYYY-MM') AS month,
               COALESCE(SUM(amount), 0)::float AS inc
        FROM "Payment" WHERE ${Prisma.join(svcConditions, " AND ")}
        GROUP BY 1
      `),
    ]);
    const totalExpenses = Number(expTotalRows[0]?.total ?? 0);
    const expByMonth = new Map(monthlyExpRows.map((r) => [r.month, Number(r.exp)]));
    const serviceIncome = Number(svcTotalRows[0]?.total ?? 0);
    const svcByMonth = new Map(monthlySvcRows.map((r) => [r.month, Number(r.inc)]));

    // Returns (credit notes) reverse revenue and the cost of the goods that
    // came back — both sides of the original sale are backed out.
    const returnsNet = Number(retTotalRows[0]?.net ?? 0);
    const returnsCogs = Number(retTotalRows[0]?.cogs ?? 0);
    const returnsTotal = returnsNet + Number(retTotalRows[0]?.tax ?? 0);
    const netSales = grossSales - returnsNet; // ex-GST revenue, net of returns
    const netCogs = grossCogs - returnsCogs; // cost matched to goods kept sold
    const grossProfitAmt = netSales - netCogs;
    // Service income has no cost of goods, so it flows straight into net profit.
    const netProfit = grossProfitAmt + serviceIncome - totalExpenses;
    // Total income (sales + service) — used as the denominator for net margin so
    // service-only shops still get a meaningful percentage.
    const totalIncome = netSales + serviceIncome;
    // Receivable still open: billed − settled (payments + bill-linked charges)
    // − credit-note value (a return reduces what the customer owes).
    const outstanding = Math.max(0, salesGross - amountSettled - returnsTotal);
    const retByMonth = new Map(
      monthlyRetRows.map((r) => [r.month, { net: Number(r.net), cogs: Number(r.cogs) }])
    );

    // Monthly profit/loss, accrual basis: revenue and matched COGS land in the
    // month the bill was raised; returns land in the month of the credit note.
    const monthlyRows = await prisma.$queryRaw<
      Array<{ month: string; net: number; cogs: number }>
    >(Prisma.sql`
      SELECT to_char(date_trunc('month', inv."invoiceDate"), 'YYYY-MM') AS month,
             COALESCE(SUM(inv.subtotal - inv.discount), 0)::float AS net,
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
      salesByMonth.set(m.month, { net: Number(m.net), cogs: Number(m.cogs) });
    }
    const allMonths = new Set<string>([
      ...salesByMonth.keys(),
      ...expByMonth.keys(),
      ...retByMonth.keys(),
      ...svcByMonth.keys(),
    ]);
    const monthly = Array.from(allMonths)
      .sort()
      .map((month) => {
        const s = salesByMonth.get(month) ?? { net: 0, cogs: 0 };
        const exp = expByMonth.get(month) ?? 0;
        const ret = retByMonth.get(month) ?? { net: 0, cogs: 0 };
        const svc = svcByMonth.get(month) ?? 0; // service / other income
        const net = s.net - ret.net; // revenue net of returns
        const cgs = s.cogs - ret.cogs; // cost net of returned goods
        return {
          month,
          salesNet: round2(net),
          serviceIncome: round2(svc),
          cogs: round2(cgs),
          expenses: round2(exp),
          profit: round2(net + svc - cgs - exp),
        };
      });

    // Per-bill profit/loss (most recent 100 sales) incl. charges on that bill.
    // Same accrual formula as the single-bill P&L modal, so a row and its
    // detail view always agree: net sale (ex-GST, after discount and returns)
    // − matched COGS − bill-linked charges. Collection status rides along.
    const billRows = await prisma.$queryRaw<
      Array<{
        id: string;
        number: string;
        date: Date;
        status: string;
        netsale: number;
        total: number;
        settled: number;
        collected: number;
        cogs: number;
        expense: number;
        retnet: number;
        rettotal: number;
        retcogs: number;
        refunded: number;
      }>
    >(Prisma.sql`
      SELECT inv.id AS id, inv."invoiceNumber" AS number, inv."invoiceDate" AS date,
             inv.status AS status,
             (inv.subtotal - inv.discount)::float AS netsale,
             inv.total::float AS total,
             inv."amountPaid"::float AS settled,
             COALESCE(pm.paid, 0)::float AS collected,
             COALESCE(c.cost, 0)::float AS cogs,
             COALESCE(e.exp, 0)::float AS expense,
             COALESCE(r.net, 0)::float AS retnet,
             COALESCE(r.total, 0)::float AS rettotal,
             COALESCE(r.cogs, 0)::float AS retcogs,
             COALESCE(rf.refunded, 0)::float AS refunded
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
        -- Only money that flows the settling way counts as collected: a sale is
        -- settled by receipts (IN), a purchase by payments (OUT). The opposite
        -- direction on the same bill is a refund on a return/exchange — it must
        -- not be added to what the customer paid.
        SELECT COALESCE(SUM(amount), 0) AS paid FROM "Payment" p
        WHERE p."invoiceId" = inv.id
          AND p.direction::text = CASE WHEN inv.type::text = 'PURCHASE' THEN 'OUT' ELSE 'IN' END
      ) pm ON true
      LEFT JOIN LATERAL (
        SELECT SUM("netAmount") AS net, SUM("totalAmount") AS total, SUM(cogs) AS cogs
        FROM "CreditNote" cn WHERE cn."invoiceId" = inv.id
      ) r ON true
      LEFT JOIN LATERAL (
        -- Money paid back on the bill (cash refunded on a return) is owed again.
        SELECT COALESCE(SUM(amount), 0) AS refunded FROM "Payment" p
        WHERE p."invoiceId" = inv.id
          AND p.direction::text <> CASE WHEN inv.type::text = 'PURCHASE' THEN 'OUT' ELSE 'IN' END
      ) rf ON true
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY inv."invoiceDate" DESC, inv."invoiceNumber" DESC
      LIMIT 100
    `);

    res.json({
      shop: business.name,
      period: { from: from ?? null, to: to ?? null },
      pnl: {
        salesGross: round2(salesGross),
        grossSales: round2(grossSales),
        amountCollected: round2(amountCollected),
        outstanding: round2(outstanding),
        returns: round2(returnsTotal),
        returnsNet: round2(returnsNet),
        salesNet: round2(netSales),
        serviceIncome: round2(serviceIncome),
        cogs: round2(netCogs),
        grossProfit: round2(grossProfitAmt),
        grossMarginPct: netSales ? round2((grossProfitAmt / netSales) * 100) : 0,
        expenses: round2(totalExpenses),
        netProfit: round2(netProfit),
        netMarginPct: totalIncome ? round2((netProfit / totalIncome) * 100) : 0,
        taxCollected: round2(gstBilled),
        purchases: round2(Number(purchases._sum.total ?? 0)),
        taxPaid: round2(Number(purchases._sum.taxAmount ?? 0)),
        salesCount: sales._count,
        purchaseCount: purchases._count,
      },
      monthly,
      bills: billRows.map((b) => {
        const rev = round2(Number(b.netsale) - Number(b.retnet));
        const c = round2(Number(b.cogs) - Number(b.retcogs));
        const exp = round2(Number(b.expense));
        const due = Math.max(
          0,
          Number(b.total) - Number(b.settled) - Number(b.rettotal) + Number(b.refunded)
        );
        return {
          id: b.id,
          number: b.number,
          date: b.date,
          status: b.status,
          revenue: rev,
          cogs: c,
          expense: exp,
          profit: round2(rev - c - exp),
          collected: round2(Number(b.collected)),
          outstanding: round2(due),
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

    const [cogsRows, chargeGroups, returnAgg, payAgg] = await Promise.all([
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
      // Real customer cash for this bill (payments only, not settling charges).
      // Grouped by direction so a refund voucher on a return/exchange is netted
      // off instead of counting as more money collected.
      prisma.payment.groupBy({
        by: ["direction"],
        where: { invoiceId: invoice.id },
        _sum: { amount: true },
      }),
    ]);
    const settleDir = invoice.type === "PURCHASE" ? "OUT" : "IN";
    const cashCollected =
      Number(payAgg.find((g) => g.direction === settleDir)?._sum.amount ?? 0) -
      Number(payAgg.find((g) => g.direction !== settleDir)?._sum.amount ?? 0);

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
        // Cash collected = customer payments only; amountPaid also folds in the
        // bill-linked charges that settle the due, so it drives outstanding.
        amountCollected: round2(cashCollected),
        outstanding: round2(
          Math.max(
            0,
            billDue({
              total,
              amountPaid: invoice.amountPaid,
              returned: returnTotal,
              refunded: Number(
                payAgg.find((g) => g.direction !== settleDir)?._sum.amount ?? 0
              ),
            })
          )
        ),
        returns: round2(returnTotal),
        cogs: round2(cogs),
        grossProfit: round2(grossProfit),
        grossMarginPct: netSale ? round2((grossProfit / netSale) * 100) : 0,
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

    // Payments made to suppliers (money out) in the period.
    const payCond = [
      Prisma.sql`"businessId" = ${id}`,
      Prisma.sql`direction = 'OUT'`,
      Prisma.sql`"partyId" IS NOT NULL`,
    ];
    if (from) payCond.push(Prisma.sql`"paymentDate" >= ${from}`);
    if (to) payCond.push(Prisma.sql`"paymentDate" <= ${to}`);

    // Stock movements of suppliers' products in the period (how fast they move).
    const moveCond = [
      Prisma.sql`i."businessId" = ${id}`,
      Prisma.sql`i."supplierId" IS NOT NULL`,
    ];
    if (from) moveCond.push(Prisma.sql`sm."createdAt" >= ${from}`);
    if (to) moveCond.push(Prisma.sql`sm."createdAt" <= ${to}`);

    // Per-item OUT total within the period — used to flag idle (no-sale) stock.
    const outRange = (() => {
      const c = [Prisma.sql`sm."itemId" = i.id`, Prisma.sql`sm.quantity < 0`];
      if (from) c.push(Prisma.sql`sm."createdAt" >= ${from}`);
      if (to) c.push(Prisma.sql`sm."createdAt" <= ${to}`);
      return Prisma.join(c, " AND ");
    })();

    const [
      suppliers,
      purchaseRows,
      salesRows,
      itemCountRows,
      stockRows,
      payRows,
      moveRows,
      idleRows,
    ] = await Promise.all([
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
      // Cash paid to each supplier in the period.
      prisma.$queryRaw<Array<{ sid: string; paid: number }>>(Prisma.sql`
        SELECT "partyId" AS sid, COALESCE(SUM(amount), 0)::float AS paid
        FROM "Payment" WHERE ${Prisma.join(payCond, " AND ")} GROUP BY 1
      `),
      // Units received / sold of each supplier's products in the period.
      prisma.$queryRaw<Array<{ sid: string; inunits: number; outunits: number }>>(Prisma.sql`
        SELECT i."supplierId" AS sid,
               COALESCE(SUM(sm.quantity) FILTER (WHERE sm.quantity > 0), 0)::float AS inunits,
               COALESCE(SUM(-sm.quantity) FILTER (WHERE sm.quantity < 0), 0)::float AS outunits
        FROM "StockMovement" sm JOIN "Item" i ON i.id = sm."itemId"
        WHERE ${Prisma.join(moveCond, " AND ")} GROUP BY 1
      `),
      // Idle stock per supplier: products still on hand that had NO sale/issue
      // in the period — dead money sitting on the shelf.
      prisma.$queryRaw<Array<{ sid: string; idleval: number; idlecnt: number }>>(Prisma.sql`
        SELECT i."supplierId" AS sid,
               COALESCE(SUM(CASE WHEN COALESCE(o.outq, 0) = 0 AND i."stockQty" > 0
                                 THEN i."stockQty" * i."purchasePrice" ELSE 0 END), 0)::float AS idleval,
               COUNT(*) FILTER (WHERE COALESCE(o.outq, 0) = 0 AND i."stockQty" > 0)::int AS idlecnt
        FROM "Item" i
        LEFT JOIN LATERAL (
          SELECT SUM(-sm.quantity) AS outq FROM "StockMovement" sm WHERE ${outRange}
        ) o ON true
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
    const payMap = new Map(payRows.map((r) => [r.sid, Number(r.paid)]));
    const moveMap = new Map(
      moveRows.map((r) => [r.sid, { in: Number(r.inunits), out: Number(r.outunits) }])
    );
    const idleMap = new Map(
      idleRows.map((r) => [r.sid, { val: Number(r.idleval), cnt: Number(r.idlecnt) }])
    );

    const rows = suppliers
      .map((s) => {
        const purchaseIn = inMap.get(s.id) ?? 0;
        const so = outMap.get(s.id) ?? { out: 0, cogs: 0 };
        const profit = so.out - so.cogs;
        const mv = moveMap.get(s.id) ?? { in: 0, out: 0 };
        const idle = idleMap.get(s.id) ?? { val: 0, cnt: 0 };
        const paid = payMap.get(s.id) ?? 0;
        return {
          id: s.id,
          name: s.name,
          phone: s.phone,
          purchaseIn: round2(purchaseIn),
          paidInPeriod: round2(paid),
          // Credit taken this period = bought now, not yet paid (adds to payable).
          payableDelta: round2(purchaseIn - paid),
          salesOut: round2(so.out),
          cogs: round2(so.cogs),
          profit: round2(profit),
          marginPct: so.out ? round2((profit / so.out) * 100) : 0,
          unitsIn: round2(mv.in),
          unitsOut: round2(mv.out),
          idleValue: round2(idle.val),
          idleCount: idle.cnt,
          productCount: cntMap.get(s.id) ?? 0,
          stockValue: round2(stockMap.get(s.id) ?? 0),
        };
      })
      .sort((a, b) => b.profit - a.profit);

    const best = rows.find((r) => r.profit > 0) ?? null;
    // Fastest-moving supplier = most units of their products sold in the period.
    const movers = rows.filter((r) => r.unitsOut > 0);
    const fastest = movers.length
      ? movers.reduce((a, b) => (b.unitsOut > a.unitsOut ? b : a))
      : null;
    // Most idle supplier = highest value of unsold stock sitting on the shelf.
    const idlers = rows
      .filter((r) => r.idleValue > 0)
      .sort((a, b) => b.idleValue - a.idleValue);
    const mostIdle = idlers[0] ?? null;

    const cashFlow = {
      purchased: round2(rows.reduce((s, r) => s + r.purchaseIn, 0)),
      paid: round2(rows.reduce((s, r) => s + r.paidInPeriod, 0)),
      stockValue: round2(rows.reduce((s, r) => s + r.stockValue, 0)),
      idleValue: round2(rows.reduce((s, r) => s + r.idleValue, 0)),
      payableDelta: round2(
        rows.reduce((s, r) => s + r.purchaseIn, 0) -
          rows.reduce((s, r) => s + r.paidInPeriod, 0)
      ),
    };

    res.json({
      suppliers: rows,
      best: best ? { name: best.name, profit: best.profit, marginPct: best.marginPct } : null,
      fastest: fastest
        ? { name: fastest.name, unitsOut: fastest.unitsOut, salesOut: fastest.salesOut }
        : null,
      mostIdle: mostIdle
        ? { name: mostIdle.name, idleValue: mostIdle.idleValue, idleCount: mostIdle.idleCount }
        : null,
      cashFlow,
    });
  })
);

// GET /api/admin/businesses/:id/stock-movement?from=&to= — the material
// movement register for a shop: for every product, how much came IN and went
// OUT in the period, what is on hand now (as of the "To" date), the date of
// first entry / last entry / last exit, how many days it has been sitting since
// it last moved, and how many days of cover the current stock gives at the
// recent sales pace. The response also calls out the fastest-moving products
// and the ones that have sat in stock the longest.
router.get(
  "/businesses/:id/stock-movement",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const business = await prisma.business.findUnique({
      where: { id },
      select: { name: true },
    });
    if (!business) throw notFound("Shop not found");

    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;

    // Range filter for the in/out totals. Entry/exit dates are tracked across
    // all time so "date of entry / exit" stays meaningful regardless of range.
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
        brand: string | null;
        unit: string;
        purchaseprice: number;
        saleprice: number;
        lowalert: number;
        onhand: number;
        inqty: number;
        outqty: number;
        createdat: Date;
        firstin: Date | null;
        lastin: Date | null;
        lastout: Date | null;
      }>
    >(Prisma.sql`
      SELECT i.id, i.name, i.sku, i.brand, i.unit,
             i."createdAt" AS createdat,
             i."purchasePrice"::float AS purchaseprice,
             i."salePrice"::float AS saleprice,
             i."lowStockAlert"::float AS lowalert,
             (i."stockQty" - ${
               to
                 ? Prisma.sql`COALESCE((SELECT SUM(quantity) FROM "StockMovement" sm WHERE sm."itemId" = i.id AND sm."createdAt" > ${to}), 0)`
                 : Prisma.sql`0`
             })::float AS onhand,
             COALESCE((SELECT SUM(quantity) FROM "StockMovement" sm WHERE ${rangeCond(
               Prisma.sql`quantity > 0`
             )}), 0)::float AS inqty,
             COALESCE((SELECT SUM(-quantity) FROM "StockMovement" sm WHERE ${rangeCond(
               Prisma.sql`quantity < 0`
             )}), 0)::float AS outqty,
             (SELECT MIN("createdAt") FROM "StockMovement" sm WHERE sm."itemId" = i.id AND quantity > 0) AS firstin,
             (SELECT MAX("createdAt") FROM "StockMovement" sm WHERE sm."itemId" = i.id AND quantity > 0) AS lastin,
             (SELECT MAX("createdAt") FROM "StockMovement" sm WHERE sm."itemId" = i.id AND quantity < 0) AS lastout
      FROM "Item" i
      WHERE i."businessId" = ${id} AND i."isService" = false
      ORDER BY i.name ASC
    `);

    const dayMs = 86_400_000;
    const asOf = to ?? new Date();
    const daysBetween = (a: Date, b: Date) =>
      Math.max(0, Math.round((b.getTime() - a.getTime()) / dayMs));
    const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

    const items = rows.map((r) => {
      // Entry date: the first stock-in from the ledger, falling back to when
      // the product was created (covers products added before opening stock was
      // logged automatically). So every product always has an entry date.
      const firstIn = r.firstin ? new Date(r.firstin) : new Date(r.createdat);
      const lastIn = r.lastin ? new Date(r.lastin) : null;
      const lastOut = r.lastout ? new Date(r.lastout) : null;
      const onHand = round2(Number(r.onhand));
      const inQty = round2(Number(r.inqty));
      const outQty = round2(Number(r.outqty));
      const value = round2(onHand * Number(r.purchaseprice));
      // How long the product has existed, and how long since it last moved out.
      const ageDays = daysBetween(firstIn, asOf);
      const stockedDays = lastOut
        ? daysBetween(lastOut, asOf)
        : daysBetween(firstIn, asOf);
      // Average daily out over the active window → days of cover left (DIO).
      const windowStart = from ?? firstIn ?? asOf;
      const windowDays = Math.max(1, daysBetween(windowStart, asOf));
      const velocity = outQty / windowDays; // units sold per day
      const daysCover = velocity > 0 ? Math.round(onHand / velocity) : null;
      return {
        id: r.id,
        name: r.name,
        sku: r.sku,
        brand: r.brand,
        unit: r.unit,
        purchasePrice: round2(Number(r.purchaseprice)),
        salePrice: round2(Number(r.saleprice)),
        onHand,
        inQty,
        outQty,
        inValue: round2(inQty * Number(r.purchaseprice)),
        outValue: round2(outQty * Number(r.purchaseprice)),
        value,
        firstIn,
        lastIn,
        lastOut,
        ageDays,
        stockedDays,
        daysCover,
        velocity: round3(velocity),
        low: onHand <= Number(r.lowalert),
        idle: !!stockedDays && stockedDays >= 90 && onHand > 0,
      };
    });

    // Fastest moving = most units sold out in the period. Most days in stock =
    // products still on hand that have sat the longest since they last moved.
    const fastMoving = items
      .filter((i) => i.outQty > 0)
      .sort((a, b) => b.outQty - a.outQty)
      .slice(0, 5);
    const slowMoving = items
      .filter((i) => i.onHand > 0 && i.stockedDays != null)
      .sort((a, b) => (b.stockedDays ?? 0) - (a.stockedDays ?? 0))
      .slice(0, 5);

    res.json({
      shop: business.name,
      asOf,
      period: { from: from ?? null, to: to ?? null },
      totals: {
        products: items.length,
        stockValue: round2(items.reduce((s, i) => s + i.value, 0)),
        inQty: round2(items.reduce((s, i) => s + i.inQty, 0)),
        outQty: round2(items.reduce((s, i) => s + i.outQty, 0)),
        inValue: round2(items.reduce((s, i) => s + i.inValue, 0)),
        outValue: round2(items.reduce((s, i) => s + i.outValue, 0)),
        lowStock: items.filter((i) => i.low).length,
        idle: items.filter((i) => i.idle).length,
      },
      fastMoving,
      slowMoving,
      items,
    });
  })
);

// POST /api/admin/reconcile-payments — one-click, idempotent repair: spreads
// every settling voucher that has a party but no bill across that party's
// open bills (oldest first), then re-derives any bill still marked PARTIAL so
// paise leftovers clear. The same pass runs on every API start; this lets an
// admin trigger it immediately, for one shop (?businessId=) or all.
router.post(
  "/reconcile-payments",
  asyncHandler(async (req, res) => {
    const businessId = req.query.businessId ? String(req.query.businessId) : undefined;
    const result = await reconcilePayments(prisma, businessId);
    res.json(result);
  })
);

// POST /api/admin/stock/backfill-entry-dates — one-click, idempotent backfill:
// for every in-stock, non-service product that has no inward (entry) movement
// yet, insert an "Opening stock" IN movement dated today so it gets an entry
// date. Products added after auto-logging already have one and are skipped.
router.post(
  "/stock/backfill-entry-dates",
  asyncHandler(async (_req, res) => {
    const today = new Date();
    const products = await prisma.item.findMany({
      where: {
        isService: false,
        stockQty: { gt: 0 },
        stockMovements: { none: { quantity: { gt: 0 } } },
      },
      select: { id: true, businessId: true, stockQty: true },
    });
    if (products.length > 0) {
      await prisma.stockMovement.createMany({
        data: products.map((p) => ({
          businessId: p.businessId,
          itemId: p.id,
          type: "IN" as const,
          quantity: p.stockQty,
          balanceAfter: p.stockQty,
          reason: "Opening stock (backfilled)",
          createdAt: today,
        })),
      });
    }
    res.json({ backfilled: products.length, date: today });
  })
);

// GET /api/admin/items/:itemId/movements?from=&to= — the full entry/exit
// timeline for ONE product, with the running on-hand balance after each move.
router.get(
  "/items/:itemId/movements",
  asyncHandler(async (req, res) => {
    const item = await prisma.item.findUnique({
      where: { id: req.params.itemId },
      include: {
        business: { select: { name: true } },
        supplier: { select: { name: true } },
      },
    });
    if (!item) throw notFound("Product not found");

    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;

    const movements = await prisma.stockMovement.findMany({
      where: {
        itemId: item.id,
        ...(from || to
          ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    const inQty = movements
      .filter((m) => Number(m.quantity) > 0)
      .reduce((s, m) => s + Number(m.quantity), 0);
    const outQty = movements
      .filter((m) => Number(m.quantity) < 0)
      .reduce((s, m) => s - Number(m.quantity), 0);

    res.json({
      item: {
        id: item.id,
        name: item.name,
        sku: item.sku,
        unit: item.unit,
        brand: item.brand,
        stockQty: round2(Number(item.stockQty)),
        purchasePrice: round2(Number(item.purchasePrice)),
        salePrice: round2(Number(item.salePrice)),
        shop: item.business.name,
        supplier: item.supplier?.name ?? null,
      },
      summary: { inQty: round2(inQty), outQty: round2(outQty), count: movements.length },
      movements: movements.map((m) => ({
        id: m.id,
        type: m.type,
        quantity: round2(Number(m.quantity)),
        balanceAfter: round2(Number(m.balanceAfter)),
        reason: m.reason,
        reference: m.reference,
        invoiceId: m.invoiceId,
        date: m.createdAt,
      })),
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
        bankDelta = 0,
        inCash = 0,
        inBank = 0,
        outCash = 0,
        outBank = 0,
        // Cash handed into the bank / cash drawn out of the bank.
        toBank = 0,
        toCash = 0;
      for (const r of rows) {
        // Cash deposit: shop cash goes down, bank goes up by the same amount.
        if (r.purpose === "Bank Deposit") {
          cashDelta -= r.amt;
          bankDelta += r.amt;
          toBank += r.amt;
          continue;
        }
        // Bank withdrawal: bank goes down, shop cash goes up.
        if (r.purpose === "Bank Withdrawal") {
          bankDelta -= r.amt;
          cashDelta += r.amt;
          toCash += r.amt;
          continue;
        }
        const cash = r.method === "CASH";
        if (r.direction === "IN") {
          credit += r.amt;
          if (cash) {
            cashDelta += r.amt;
            inCash += r.amt;
          } else {
            bankDelta += r.amt;
            inBank += r.amt;
          }
        } else {
          debit += r.amt;
          if (cash) {
            cashDelta -= r.amt;
            outCash += r.amt;
          } else {
            bankDelta -= r.amt;
            outBank += r.amt;
          }
        }
      }
      return {
        credit,
        debit,
        cashDelta,
        bankDelta,
        inCash,
        inBank,
        outCash,
        outBank,
        toBank,
        toCash,
      };
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
    // A refund paid out on a bill (cash back on a return) is owed again.
    const [recvRefunds, payRefunds] = await Promise.all([
      refundedByInvoice(prisma, id, receivableInvoices.map((i) => i.id), "SALE"),
      refundedByInvoice(prisma, id, payableInvoices.map((i) => i.id), "PURCHASE"),
    ]);
    const bill = (inv: (typeof receivableInvoices)[number]) => {
      const due = billDue({
        total: inv.total,
        amountPaid: inv.amountPaid,
        returned: cnMap.get(inv.id),
        refunded: (inv.type === "SALE" ? recvRefunds : payRefunds).get(inv.id),
      });
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
    // Period totals of cash <-> bank transfers, for the balance cards.
    let toBankTotal = 0,
      toCashTotal = 0;
    const days = Array.from(byDay.keys())
      .sort()
      .map((day) => {
        const f = flows(byDay.get(day)!);
        cash += f.cashDelta;
        bank += f.bankDelta;
        toBankTotal += f.toBank;
        toCashTotal += f.toCash;
        return {
          day,
          credit: round2(f.credit),
          debit: round2(f.debit),
          inCash: round2(f.inCash),
          inBank: round2(f.inBank),
          outCash: round2(f.outCash),
          outBank: round2(f.outBank),
          // Cash deposited into the bank / withdrawn back as cash that day.
          toBank: round2(f.toBank),
          toCash: round2(f.toCash),
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
      depositedToBank: round2(toBankTotal),
      withdrawnToCash: round2(toCashTotal),
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
    const [invAgg, payAgg, billInvoices, linkedPayAgg] = await Promise.all([
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
      // For crediting bill-linked charges: each bill's capped settled amount is
      // amountPaid, and the charge portion of it is amountPaid − payments on
      // that bill (0 for bills with no charges).
      prisma.invoice.findMany({
        where: { businessId: id, type: invoiceType as never },
        select: { id: true, partyId: true, amountPaid: true },
      }),
      prisma.payment.groupBy({
        by: ["invoiceId"],
        where: { businessId: id, invoiceId: { not: null } },
        _sum: { amount: true },
      }),
    ]);
    const invMap = new Map(invAgg.map((r) => [r.partyId, Number(r._sum.total ?? 0)]));
    const payMap = new Map(payAgg.map((r) => [r.partyId, Number(r._sum.amount ?? 0)]));
    const linkedPayByInv = new Map(
      linkedPayAgg.map((r) => [r.invoiceId, Number(r._sum.amount ?? 0)])
    );
    // Charge amount that actually settled each party's bills (capped, ≥ 0).
    const chargeAdjMap = new Map<string, number>();
    for (const inv of billInvoices) {
      const settled = Number(inv.amountPaid) - (linkedPayByInv.get(inv.id) ?? 0);
      if (settled > 0)
        chargeAdjMap.set(inv.partyId, (chargeAdjMap.get(inv.partyId) ?? 0) + settled);
    }

    const rows = parties.map((p) => {
      const billed = invMap.get(p.id) ?? 0;
      const paid = (payMap.get(p.id) ?? 0) + (chargeAdjMap.get(p.id) ?? 0);
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

    const { ledger, totals, bills, closingBalance } = await buildPartyLedger(prisma, party);

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
      closingBalance,
      totals,
      bills,
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
      include: {
        user: {
          select: {
            id: true,
            name: true,
            username: true,
            email: true,
            // How many shops this login can access — lets the admin UI show
            // "shared with N other shops" for multi-shop logins.
            _count: { select: { memberships: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    res.json({
      logins: memberships.map((m) => ({
        userId: m.user.id,
        name: m.user.name,
        username: m.user.username,
        email: m.user.email,
        role: m.role,
        shopCount: m.user._count.memberships,
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

// POST /api/admin/businesses/:id/logins/attach — give an EXISTING login access
// to this shop too. Used when one team runs several shops (e.g. Laxora
// Peravoor + Laxora Decorative) with a single username: the staff sign in
// once and switch shops inside the app.
router.post(
  "/businesses/:id/logins/attach",
  validateBody(z.object({ username: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const business = await prisma.business.findUnique({ where: { id } });
    if (!business) throw notFound("Shop not found");

    const uname = String(req.body.username).trim().toLowerCase();
    const user = await prisma.user.findFirst({
      where: {
        OR: [{ username: uname }, { email: uname }, { email: `${uname}@shop.laxora` }],
      },
    });
    if (!user) throw notFound("No login found with that username");

    const existing = await prisma.membership.findUnique({
      where: { userId_businessId: { userId: user.id, businessId: id } },
    });
    if (existing) throw conflict("That login already has access to this shop");

    await prisma.membership.create({
      data: { userId: user.id, businessId: id, role: "MANAGER" },
    });
    res.status(201).json({
      login: { userId: user.id, name: user.name, username: user.username },
    });
  })
);

// DELETE /api/admin/businesses/:id/logins/:userId — remove a login's access to
// THIS shop only. The account itself survives while it still has other shops;
// when this was its last shop the now-orphaned account is deleted with it.
router.delete(
  "/businesses/:id/logins/:userId",
  asyncHandler(async (req, res) => {
    const { id, userId } = req.params;
    const membership = await prisma.membership.findUnique({
      where: { userId_businessId: { userId, businessId: id } },
      include: { user: { select: { isPlatformAdmin: true } } },
    });
    if (!membership) throw notFound("Login not found on this shop");
    if (membership.user.isPlatformAdmin)
      throw badRequest("Cannot remove a platform admin here");

    await prisma.$transaction(async (tx) => {
      await tx.membership.delete({ where: { id: membership.id } });
      const remaining = await tx.membership.count({ where: { userId } });
      if (remaining === 0) await tx.user.delete({ where: { id: userId } });
    });
    res.status(204).send();
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

// GET /api/admin/change-requests?status=PENDING&businessId=… — product edits
// awaiting review, optionally scoped to one shop (sidebar-selected).
// pendingCount includes invoice-deletion requests so the sidebar badge covers both.
router.get(
  "/change-requests",
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : "PENDING";
    const businessId = req.query.businessId ? String(req.query.businessId) : undefined;
    const scope = businessId ? { businessId } : {};
    const [requests, deletePending, returnDeletePending] = await Promise.all([
      prisma.itemChangeRequest.findMany({
        where: { status, ...scope },
        include: { business: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      prisma.invoiceDeleteRequest.count({ where: { status: "PENDING", ...scope } }),
      prisma.returnDeleteRequest.count({ where: { status: "PENDING", ...scope } }),
    ]);
    res.json({
      requests,
      pendingCount: requests.length + deletePending + returnDeletePending,
    });
  })
);

// ---- Invoice deletion approvals ---------------------------------------------

// GET /api/admin/delete-requests?status=PENDING&businessId=…
router.get(
  "/delete-requests",
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : "PENDING";
    const businessId = req.query.businessId ? String(req.query.businessId) : undefined;
    const requests = await prisma.invoiceDeleteRequest.findMany({
      where: { status, ...(businessId ? { businessId } : {}) },
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

// ---- Sales-return deletion approvals ----------------------------------------

// GET /api/admin/return-delete-requests?status=PENDING&businessId=…
router.get(
  "/return-delete-requests",
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : "PENDING";
    const businessId = req.query.businessId ? String(req.query.businessId) : undefined;
    const requests = await prisma.returnDeleteRequest.findMany({
      where: { status, ...(businessId ? { businessId } : {}) },
      include: { business: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ requests });
  })
);

// POST /api/admin/return-delete-requests/:id/approve — reverse the return.
router.post(
  "/return-delete-requests/:id/approve",
  asyncHandler(async (req, res) => {
    const request = await prisma.returnDeleteRequest.findUnique({
      where: { id: req.params.id },
    });
    if (!request) throw notFound("Request not found");
    if (request.status !== "PENDING") throw badRequest("This request was already reviewed");

    // The credit note may have already been reversed (e.g. the bill was
    // deleted). Reverse it if it still exists, then close out the request.
    await reverseReturn(request.creditNoteId, request.businessId, req.auth!.userId);
    await prisma.returnDeleteRequest.update({
      where: { id: request.id },
      data: { status: "APPROVED", reviewedAt: new Date() },
    });
    res.json({ ok: true });
  })
);

// POST /api/admin/return-delete-requests/:id/reject — keep the return.
router.post(
  "/return-delete-requests/:id/reject",
  asyncHandler(async (req, res) => {
    const request = await prisma.returnDeleteRequest.findUnique({
      where: { id: req.params.id },
    });
    if (!request) throw notFound("Request not found");
    await prisma.returnDeleteRequest.update({
      where: { id: request.id },
      data: { status: "REJECTED", reviewedAt: new Date() },
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

// Any /api/admin/* path that matched no route above is a genuine 404. Return it
// as such so the request never falls through to the global tenant middleware,
// which for a platform admin would misleadingly report "No business found for
// this user". That fall-through is what happens when the deployed backend is
// older than the admin panel and is missing a report endpoint the panel calls —
// this 404 (message contains "not found") lets the panel show its proper
// "report isn't available yet — redeploy the backend" hint instead.
router.use((req, res) => {
  res
    .status(404)
    .json({ error: `Admin endpoint not found: ${req.method} ${req.originalUrl}` });
});

export default router;
