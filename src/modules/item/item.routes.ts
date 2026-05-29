import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { notFound } from "../../utils/errors";

const router = Router();

const itemSchema = z.object({
  name: z.string().min(1),
  sku: z.string().optional(),
  hsn: z.string().optional(),
  unit: z.string().default("PCS"),
  salePrice: z.number().nonnegative().default(0),
  purchasePrice: z.number().nonnegative().default(0),
  taxRate: z.number().min(0).max(100).default(0),
  stockQty: z.number().default(0),
  lowStockAlert: z.number().default(0),
  isService: z.boolean().default(false),
});

// GET /api/items?search=&lowStock=true
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { search } = req.query;
    const items = await prisma.item.findMany({
      where: {
        businessId: req.businessId!,
        ...(search
          ? { name: { contains: String(search), mode: "insensitive" } }
          : {}),
      },
      orderBy: { name: "asc" },
    });
    res.json({ items });
  })
);

// GET /api/items/:id
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const item = await prisma.item.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!item) throw notFound("Item not found");
    res.json({ item });
  })
);

// POST /api/items
router.post(
  "/",
  validateBody(itemSchema),
  asyncHandler(async (req, res) => {
    const item = await prisma.item.create({
      data: { ...req.body, businessId: req.businessId! },
    });
    res.status(201).json({ item });
  })
);

// PUT /api/items/:id
router.put(
  "/:id",
  validateBody(itemSchema.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.item.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!existing) throw notFound("Item not found");
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
