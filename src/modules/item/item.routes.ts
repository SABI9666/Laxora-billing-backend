import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, notFound } from "../../utils/errors";
import { requireRole, SHOP_MANAGERS } from "../../middleware/roles";

const router = Router();

const itemSchema = z.object({
  name: z.string().min(1),
  categoryId: z.string().optional().nullable(),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  brand: z.string().optional(),
  wattage: z.string().optional(),
  hsn: z.string().optional(),
  unit: z.string().default("PCS"),
  salePrice: z.number().nonnegative().default(0),
  purchasePrice: z.number().nonnegative().default(0),
  taxRate: z.number().min(0).max(100).default(0),
  stockQty: z.number().default(0),
  lowStockAlert: z.number().default(0),
  isService: z.boolean().default(false),
});

// Ensures a categoryId (if provided) belongs to the active shop.
async function assertCategory(businessId: string, categoryId?: string | null) {
  if (!categoryId) return;
  const category = await prisma.category.findFirst({
    where: { id: categoryId, businessId },
  });
  if (!category) throw badRequest("Invalid categoryId for this shop");
}

// GET /api/items?search=&categoryId=&lowStock=true&barcode=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { search, categoryId, barcode, lowStock } = req.query;
    const items = await prisma.item.findMany({
      where: {
        businessId: req.businessId!,
        ...(search
          ? {
              OR: [
                { name: { contains: String(search), mode: "insensitive" } },
                { sku: { contains: String(search), mode: "insensitive" } },
                { barcode: { contains: String(search), mode: "insensitive" } },
                { brand: { contains: String(search), mode: "insensitive" } },
              ],
            }
          : {}),
        ...(categoryId ? { categoryId: String(categoryId) } : {}),
        ...(barcode ? { barcode: String(barcode) } : {}),
      },
      include: { category: { select: { id: true, name: true } } },
      orderBy: { name: "asc" },
    });

    // Low-stock filter is applied in memory (Decimal comparison).
    const filtered =
      lowStock === "true"
        ? items.filter(
            (i) => !i.isService && Number(i.stockQty) <= Number(i.lowStockAlert)
          )
        : items;

    res.json({ items: filtered });
  })
);

// GET /api/items/lookup?barcode= — fast single-item lookup for POS scanning.
router.get(
  "/lookup",
  asyncHandler(async (req, res) => {
    const { barcode, sku } = req.query;
    if (!barcode && !sku) throw badRequest("barcode or sku is required");
    const item = await prisma.item.findFirst({
      where: {
        businessId: req.businessId!,
        ...(barcode ? { barcode: String(barcode) } : {}),
        ...(sku ? { sku: String(sku) } : {}),
      },
      include: { category: { select: { id: true, name: true } } },
    });
    if (!item) throw notFound("No item matches that code");
    res.json({ item });
  })
);

// GET /api/items/:id
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const item = await prisma.item.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
      include: { category: { select: { id: true, name: true } } },
    });
    if (!item) throw notFound("Item not found");
    res.json({ item });
  })
);

// POST /api/items
router.post(
  "/",
  requireRole(...SHOP_MANAGERS),
  validateBody(itemSchema),
  asyncHandler(async (req, res) => {
    await assertCategory(req.businessId!, req.body.categoryId);
    const item = await prisma.item.create({
      data: { ...req.body, businessId: req.businessId! },
    });
    res.status(201).json({ item });
  })
);

// PUT /api/items/:id
router.put(
  "/:id",
  requireRole(...SHOP_MANAGERS),
  validateBody(itemSchema.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.item.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!existing) throw notFound("Item not found");
    await assertCategory(req.businessId!, req.body.categoryId);
    const item = await prisma.item.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json({ item });
  })
);

// DELETE /api/items/:id
router.delete(
  "/:id",
  requireRole(...SHOP_MANAGERS),
  asyncHandler(async (req, res) => {
    const existing = await prisma.item.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!existing) throw notFound("Item not found");
    await prisma.item.delete({ where: { id: req.params.id } });
    res.status(204).send();
  })
);

export default router;
