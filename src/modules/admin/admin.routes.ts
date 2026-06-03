import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, conflict, notFound } from "../../utils/errors";
import { hashPassword } from "../../utils/password";

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
        _sum: { total: true, subtotal: true, discount: true, taxAmount: true },
        _count: true,
      }),
      prisma.invoice.aggregate({
        where: { businessId: id, type: "PURCHASE", ...filter },
        _sum: { total: true, taxAmount: true },
        _count: true,
      }),
    ]);

    // Cost of goods sold = quantity * purchase price for items sold.
    const conditions = [
      Prisma.sql`inv."businessId" = ${id}`,
      Prisma.sql`inv.type = 'SALE'`,
    ];
    if (from) conditions.push(Prisma.sql`inv."invoiceDate" >= ${from}`);
    if (to) conditions.push(Prisma.sql`inv."invoiceDate" <= ${to}`);
    const cogsRows = await prisma.$queryRaw<Array<{ cogs: number }>>(Prisma.sql`
      SELECT COALESCE(SUM(ii.quantity * i."purchasePrice"), 0)::float AS cogs
      FROM "InvoiceItem" ii
      JOIN "Invoice" inv ON inv.id = ii."invoiceId"
      JOIN "Item" i ON i.id = ii."itemId"
      WHERE ${Prisma.join(conditions, " AND ")}
    `);
    const cogs = Number(cogsRows[0]?.cogs ?? 0);

    const salesNet = Number(sales._sum.subtotal ?? 0) - Number(sales._sum.discount ?? 0);
    const grossProfit = salesNet - cogs;

    // Monthly profit/loss: revenue (net) and COGS per month.
    const monthlyRows = await prisma.$queryRaw<
      Array<{ month: string; salesnet: number; cogs: number }>
    >(Prisma.sql`
      SELECT to_char(date_trunc('month', inv."invoiceDate"), 'YYYY-MM') AS month,
             COALESCE(SUM(inv.subtotal - inv.discount), 0)::float AS salesnet,
             COALESCE(SUM(c.cost), 0)::float AS cogs
      FROM "Invoice" inv
      LEFT JOIN LATERAL (
        SELECT SUM(ii.quantity * i."purchasePrice") AS cost
        FROM "InvoiceItem" ii JOIN "Item" i ON i.id = ii."itemId"
        WHERE ii."invoiceId" = inv.id
      ) c ON true
      WHERE ${Prisma.join(conditions, " AND ")}
      GROUP BY 1 ORDER BY 1
    `);

    // Per-bill profit/loss (most recent 100 sales).
    const billRows = await prisma.$queryRaw<
      Array<{ number: string; date: Date; revenue: number; cogs: number }>
    >(Prisma.sql`
      SELECT inv."invoiceNumber" AS number, inv."invoiceDate" AS date,
             (inv.subtotal - inv.discount)::float AS revenue,
             COALESCE(c.cost, 0)::float AS cogs
      FROM "Invoice" inv
      LEFT JOIN LATERAL (
        SELECT SUM(ii.quantity * i."purchasePrice") AS cost
        FROM "InvoiceItem" ii JOIN "Item" i ON i.id = ii."itemId"
        WHERE ii."invoiceId" = inv.id
      ) c ON true
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY inv."invoiceDate" DESC, inv."invoiceNumber" DESC
      LIMIT 100
    `);

    res.json({
      shop: business.name,
      period: { from: from ?? null, to: to ?? null },
      pnl: {
        salesGross: round2(Number(sales._sum.total ?? 0)),
        salesNet: round2(salesNet),
        cogs: round2(cogs),
        grossProfit: round2(grossProfit),
        grossMarginPct: salesNet ? round2((grossProfit / salesNet) * 100) : 0,
        taxCollected: round2(Number(sales._sum.taxAmount ?? 0)),
        purchases: round2(Number(purchases._sum.total ?? 0)),
        taxPaid: round2(Number(purchases._sum.taxAmount ?? 0)),
        salesCount: sales._count,
        purchaseCount: purchases._count,
      },
      monthly: monthlyRows.map((m) => {
        const sNet = round2(Number(m.salesnet));
        const c = round2(Number(m.cogs));
        return { month: m.month, salesNet: sNet, cogs: c, profit: round2(sNet - c) };
      }),
      bills: billRows.map((b) => {
        const rev = round2(Number(b.revenue));
        const c = round2(Number(b.cogs));
        return {
          number: b.number,
          date: b.date,
          revenue: rev,
          cogs: c,
          profit: round2(rev - c),
        };
      }),
    });
  })
);

// GET /api/admin/businesses/:id/sales-report?from=&to= — sales totals broken
// down by month, for the selected date range.
router.get(
  "/businesses/:id/sales-report",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const business = await prisma.business.findUnique({
      where: { id },
      select: { name: true },
    });
    if (!business) throw notFound("Shop not found");

    const { from, to, filter } = dateRange(req);

    const conditions = [
      Prisma.sql`"businessId" = ${id}`,
      Prisma.sql`type = 'SALE'`,
    ];
    if (from) conditions.push(Prisma.sql`"invoiceDate" >= ${from}`);
    if (to) conditions.push(Prisma.sql`"invoiceDate" <= ${to}`);

    const months = await prisma.$queryRaw<
      Array<{ month: string; count: number; total: number; tax: number }>
    >(Prisma.sql`
      SELECT to_char(date_trunc('month', "invoiceDate"), 'YYYY-MM') AS month,
             COUNT(*)::int AS count,
             COALESCE(SUM(total), 0)::float AS total,
             COALESCE(SUM("taxAmount"), 0)::float AS tax
      FROM "Invoice"
      WHERE ${Prisma.join(conditions, " AND ")}
      GROUP BY 1
      ORDER BY 1 DESC
    `);

    const totals = await prisma.invoice.aggregate({
      where: { businessId: id, type: "SALE", ...filter },
      _sum: { total: true, taxAmount: true },
      _count: true,
    });

    res.json({
      shop: business.name,
      period: { from: from ?? null, to: to ?? null },
      months: months.map((m) => ({
        month: m.month,
        count: Number(m.count),
        total: round2(Number(m.total)),
        tax: round2(Number(m.tax)),
      })),
      totals: {
        total: round2(Number(totals._sum.total ?? 0)),
        tax: round2(Number(totals._sum.taxAmount ?? 0)),
        count: totals._count,
      },
    });
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
      include: { business: { select: { name: true } } },
    });
    if (!party) throw notFound("Party not found");
    const invoiceType = party.type === "CUSTOMER" ? "SALE" : "PURCHASE";

    const [invoices, payments] = await Promise.all([
      prisma.invoice.findMany({
        where: { partyId: party.id, type: invoiceType as never },
        select: { invoiceNumber: true, invoiceDate: true, total: true },
      }),
      prisma.payment.findMany({
        where: { partyId: party.id },
        select: { paymentDate: true, amount: true, method: true },
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
        openingBalance: round2(Number(party.openingBalance)),
        shop: party.business.name,
      },
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
