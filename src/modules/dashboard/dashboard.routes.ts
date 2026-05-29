import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";

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
