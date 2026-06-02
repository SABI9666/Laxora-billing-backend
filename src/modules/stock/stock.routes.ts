import { Router } from "express";
import { z } from "zod";
import { Prisma, StockMovementType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, notFound, forbidden } from "../../utils/errors";
import { requireRole, SHOP_MANAGERS } from "../../middleware/roles";
import { recordStockMovement } from "../../lib/stock";

const router = Router();

// GET /api/stock/movements?itemId=&type=&limit= — the audit trail.
router.get(
  "/movements",
  asyncHandler(async (req, res) => {
    const { itemId, type } = req.query;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const movements = await prisma.stockMovement.findMany({
      where: {
        businessId: req.businessId!,
        ...(itemId ? { itemId: String(itemId) } : {}),
        ...(type ? { type: type as StockMovementType } : {}),
      },
      include: { item: { select: { id: true, name: true, sku: true, unit: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    res.json({ movements });
  })
);

// GET /api/stock/low — items at or below their reorder level.
router.get(
  "/low",
  asyncHandler(async (req, res) => {
    const items = await prisma.$queryRaw<
      Array<Record<string, unknown>>
    >(Prisma.sql`SELECT id, name, sku, barcode, unit, "stockQty", "lowStockAlert"
                 FROM "Item"
                 WHERE "businessId" = ${req.businessId!}
                 AND "isService" = false
                 AND "stockQty" <= "lowStockAlert"
                 ORDER BY "stockQty" ASC`);
    res.json({ items });
  })
);

const adjustSchema = z.object({
  itemId: z.string().min(1),
  // Stock-in (GRN), manual adjustment up/down, or write-off.
  type: z.enum(["IN", "OUT", "ADJUST"]).default("ADJUST"),
  // Always positive; `type` decides the direction (ADJUST may be either —
  // use a negative quantity to remove stock for an ADJUST).
  quantity: z.number().refine((n) => n !== 0, "quantity cannot be zero"),
  reason: z.string().optional(),
  reference: z.string().optional(),
});

// POST /api/stock/adjust — stock-in / manual correction / write-off.
router.post(
  "/adjust",
  requireRole(...SHOP_MANAGERS),
  validateBody(adjustSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof adjustSchema>;
    const businessId = req.businessId!;

    const item = await prisma.item.findFirst({
      where: { id: body.itemId, businessId },
    });
    if (!item) throw notFound("Item not found");
    if (item.isService) throw badRequest("Cannot track stock for a service item");

    // Resolve the signed change from the requested type.
    const magnitude = Math.abs(body.quantity);
    let signed: number;
    if (body.type === "IN") signed = magnitude;
    else if (body.type === "OUT") signed = -magnitude;
    else signed = body.quantity; // ADJUST keeps the caller's sign

    const balanceAfter = await prisma.$transaction((tx) =>
      recordStockMovement(tx, {
        businessId,
        itemId: body.itemId,
        type: body.type as StockMovementType,
        quantity: signed,
        reason: body.reason ?? null,
        reference: body.reference ?? null,
        createdById: req.auth!.userId,
      })
    );

    res.status(201).json({ itemId: body.itemId, balanceAfter });
  })
);

const transferSchema = z.object({
  itemId: z.string().min(1),
  toBusinessId: z.string().min(1),
  quantity: z.number().positive(),
  reason: z.string().optional(),
});

// POST /api/stock/transfer — move stock to another shop in the same franchise.
// The destination shop must already hold a matching item (same SKU, else same
// name) so balances stay consistent across shops.
router.post(
  "/transfer",
  requireRole(...SHOP_MANAGERS),
  validateBody(transferSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof transferSchema>;
    const fromBusinessId = req.businessId!;

    if (body.toBusinessId === fromBusinessId) {
      throw badRequest("Source and destination shops must differ");
    }

    const [source, fromShop, toShop] = await Promise.all([
      prisma.item.findFirst({ where: { id: body.itemId, businessId: fromBusinessId } }),
      prisma.business.findUnique({ where: { id: fromBusinessId } }),
      prisma.business.findUnique({ where: { id: body.toBusinessId } }),
    ]);

    if (!source) throw notFound("Item not found in this shop");
    if (source.isService) throw badRequest("Cannot transfer a service item");
    if (!toShop) throw notFound("Destination shop not found");

    // Both shops must belong to the same franchise.
    if (!fromShop?.franchiseId || fromShop.franchiseId !== toShop.franchiseId) {
      throw forbidden("Shops must belong to the same franchise to transfer stock");
    }

    if (Number(source.stockQty) < body.quantity) {
      throw badRequest("Insufficient stock to transfer");
    }

    // Find or create the matching item in the destination shop.
    let destItem = await prisma.item.findFirst({
      where: {
        businessId: body.toBusinessId,
        ...(source.sku
          ? { sku: source.sku }
          : { name: { equals: source.name, mode: "insensitive" } }),
      },
    });

    const transferRef = `TRF-${Date.now()}`;

    const result = await prisma.$transaction(async (tx) => {
      if (!destItem) {
        destItem = await tx.item.create({
          data: {
            businessId: body.toBusinessId,
            name: source.name,
            sku: source.sku,
            barcode: source.barcode,
            brand: source.brand,
            wattage: source.wattage,
            hsn: source.hsn,
            unit: source.unit,
            salePrice: source.salePrice,
            purchasePrice: source.purchasePrice,
            taxRate: source.taxRate,
            stockQty: 0,
            lowStockAlert: source.lowStockAlert,
          },
        });
      }

      const fromBalance = await recordStockMovement(tx, {
        businessId: fromBusinessId,
        itemId: source.id,
        type: StockMovementType.TRANSFER_OUT,
        quantity: -body.quantity,
        reason: body.reason ?? `Transfer to ${toShop.name}`,
        reference: transferRef,
        createdById: req.auth!.userId,
      });

      const toBalance = await recordStockMovement(tx, {
        businessId: body.toBusinessId,
        itemId: destItem.id,
        type: StockMovementType.TRANSFER_IN,
        quantity: body.quantity,
        reason: body.reason ?? `Transfer from ${fromShop!.name}`,
        reference: transferRef,
        createdById: req.auth!.userId,
      });

      return { transferRef, fromBalance, toBalance, destItemId: destItem.id };
    });

    res.status(201).json(result);
  })
);

export default router;
