import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, forbidden, notFound } from "../../utils/errors";

// These routes are mounted with `authenticate` but WITHOUT `resolveTenant`,
// because a franchise admin works across many shops rather than one.
const router = Router();

// Loads a franchise the caller is allowed to see (owner or platform admin).
async function getAccessibleFranchise(userId: string, franchiseId: string) {
  const [franchise, user] = await Promise.all([
    prisma.franchise.findUnique({ where: { id: franchiseId } }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { isPlatformAdmin: true },
    }),
  ]);
  if (!franchise) throw notFound("Franchise not found");
  if (franchise.ownerId !== userId && !user?.isPlatformAdmin) {
    throw forbidden("You do not have access to this franchise");
  }
  return franchise;
}

const franchiseSchema = z.object({
  name: z.string().min(1),
  gstin: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().optional(),
  logoUrl: z.string().url().optional().or(z.literal("")),
});

// GET /api/franchise — franchises owned by the caller.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const franchises = await prisma.franchise.findMany({
      where: { ownerId: req.auth!.userId },
      include: { _count: { select: { shops: true } } },
      orderBy: { createdAt: "asc" },
    });
    res.json({ franchises });
  })
);

// POST /api/franchise — create a new franchise owned by the caller.
router.post(
  "/",
  validateBody(franchiseSchema),
  asyncHandler(async (req, res) => {
    const franchise = await prisma.franchise.create({
      data: { ...req.body, ownerId: req.auth!.userId },
    });
    res.status(201).json({ franchise });
  })
);

// GET /api/franchise/:id — franchise detail with its shops.
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    await getAccessibleFranchise(req.auth!.userId, req.params.id);
    const franchise = await prisma.franchise.findUnique({
      where: { id: req.params.id },
      include: {
        shops: {
          select: { id: true, name: true, code: true, isActive: true, gstin: true },
          orderBy: { name: "asc" },
        },
      },
    });
    res.json({ franchise });
  })
);

const shopSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  gstin: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  address: z.string().optional(),
});

// POST /api/franchise/:id/shops — open a new shop under the franchise.
router.post(
  "/:id/shops",
  validateBody(shopSchema),
  asyncHandler(async (req, res) => {
    const franchise = await getAccessibleFranchise(req.auth!.userId, req.params.id);
    const shop = await prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          ...req.body,
          ownerId: franchise.ownerId,
          franchiseId: franchise.id,
        },
      });
      // The franchise owner gets a membership so they can administer the shop.
      await tx.membership.create({
        data: { userId: franchise.ownerId, businessId: business.id, role: "OWNER" },
      });
      return business;
    });
    res.status(201).json({ shop });
  })
);

// POST /api/franchise/:id/attach — bring an existing standalone shop into the
// franchise (the caller must own both the franchise and the shop).
router.post(
  "/:id/attach",
  validateBody(z.object({ businessId: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const franchise = await getAccessibleFranchise(req.auth!.userId, req.params.id);
    const business = await prisma.business.findUnique({
      where: { id: req.body.businessId },
    });
    if (!business) throw notFound("Shop not found");
    if (business.ownerId !== req.auth!.userId) {
      throw forbidden("You can only attach shops you own");
    }
    if (business.franchiseId && business.franchiseId !== franchise.id) {
      throw badRequest("Shop already belongs to another franchise");
    }
    const updated = await prisma.business.update({
      where: { id: business.id },
      data: { franchiseId: franchise.id },
    });
    res.json({ shop: updated });
  })
);

// GET /api/franchise/:id/report — consolidated KPIs across every shop, with a
// per-shop breakdown for side-by-side comparison.
router.get(
  "/:id/report",
  asyncHandler(async (req, res) => {
    await getAccessibleFranchise(req.auth!.userId, req.params.id);

    const shops = await prisma.business.findMany({
      where: { franchiseId: req.params.id },
      select: { id: true, name: true, code: true, isActive: true },
      orderBy: { name: "asc" },
    });

    const perShop = await Promise.all(
      shops.map(async (shop) => {
        const [sales, purchases, receivable, lowStock, itemCount] = await Promise.all([
          prisma.invoice.aggregate({
            where: { businessId: shop.id, type: "SALE" },
            _sum: { total: true },
            _count: true,
          }),
          prisma.invoice.aggregate({
            where: { businessId: shop.id, type: "PURCHASE" },
            _sum: { total: true },
          }),
          prisma.invoice.findMany({
            where: {
              businessId: shop.id,
              type: "SALE",
              status: { in: ["UNPAID", "PARTIAL"] },
            },
            select: { total: true, amountPaid: true },
          }),
          prisma.item.count({
            where: {
              businessId: shop.id,
              isService: false,
              stockQty: { lte: prisma.item.fields.lowStockAlert },
            },
          }),
          prisma.item.count({ where: { businessId: shop.id } }),
        ]);

        const totalReceivable = receivable.reduce(
          (s, i) => s + (Number(i.total) - Number(i.amountPaid)),
          0
        );

        return {
          shopId: shop.id,
          name: shop.name,
          code: shop.code,
          isActive: shop.isActive,
          totalSales: Number(sales._sum.total ?? 0),
          salesCount: sales._count,
          totalPurchases: Number(purchases._sum.total ?? 0),
          totalReceivable: Math.round(totalReceivable * 100) / 100,
          lowStockCount: lowStock,
          itemCount,
        };
      })
    );

    const totals = perShop.reduce(
      (acc, s) => ({
        totalSales: acc.totalSales + s.totalSales,
        totalPurchases: acc.totalPurchases + s.totalPurchases,
        totalReceivable: acc.totalReceivable + s.totalReceivable,
        salesCount: acc.salesCount + s.salesCount,
        lowStockCount: acc.lowStockCount + s.lowStockCount,
      }),
      { totalSales: 0, totalPurchases: 0, totalReceivable: 0, salesCount: 0, lowStockCount: 0 }
    );

    const bestShop =
      perShop.length > 0
        ? perShop.reduce((best, s) => (s.totalSales > best.totalSales ? s : best))
        : null;

    res.json({
      shopCount: shops.length,
      totals: {
        ...totals,
        totalReceivable: Math.round(totals.totalReceivable * 100) / 100,
      },
      bestShop: bestShop ? { shopId: bestShop.shopId, name: bestShop.name, totalSales: bestShop.totalSales } : null,
      shops: perShop,
    });
  })
);

export default router;
