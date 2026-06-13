import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, notFound } from "../../utils/errors";
import { requireRole, SHOP_MANAGERS } from "../../middleware/roles";

const router = Router();

const categorySchema = z.object({
  name: z.string().min(1),
  // Optional parent category id — set it to make this a subcategory.
  parentId: z.string().optional().nullable(),
});

// Verifies a parentId (if given) is a top-level category of this shop, so we
// only ever build a two-level tree (main category → subcategory).
async function assertParent(businessId: string, parentId?: string | null) {
  if (!parentId) return;
  const parent = await prisma.category.findFirst({
    where: { id: parentId, businessId },
  });
  if (!parent) throw badRequest("Invalid parent category for this shop");
  if (parent.parentId) throw badRequest("Subcategories can only be one level deep");
}

// GET /api/categories — list categories (with item counts + parent) for the shop.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const categories = await prisma.category.findMany({
      where: { businessId: req.businessId! },
      orderBy: { name: "asc" },
      include: {
        _count: { select: { items: true } },
        parent: { select: { id: true, name: true } },
      },
    });
    res.json({ categories });
  })
);

// POST /api/categories
router.post(
  "/",
  requireRole(...SHOP_MANAGERS),
  validateBody(categorySchema),
  asyncHandler(async (req, res) => {
    await assertParent(req.businessId!, req.body.parentId);
    try {
      const category = await prisma.category.create({
        data: {
          name: req.body.name,
          parentId: req.body.parentId || null,
          businessId: req.businessId!,
        },
      });
      res.status(201).json({ category });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw badRequest("A category with this name already exists");
      }
      throw e;
    }
  })
);

// PUT /api/categories/:id
router.put(
  "/:id",
  requireRole(...SHOP_MANAGERS),
  validateBody(categorySchema.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.category.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!existing) throw notFound("Category not found");
    if (req.body.parentId !== undefined) {
      if (req.body.parentId === req.params.id)
        throw badRequest("A category cannot be its own parent");
      await assertParent(req.businessId!, req.body.parentId);
    }
    const category = await prisma.category.update({
      where: { id: req.params.id },
      data: {
        ...(req.body.name !== undefined ? { name: req.body.name } : {}),
        ...(req.body.parentId !== undefined ? { parentId: req.body.parentId || null } : {}),
      },
    });
    res.json({ category });
  })
);

// DELETE /api/categories/:id — items keep existing but lose their category.
router.delete(
  "/:id",
  requireRole(...SHOP_MANAGERS),
  asyncHandler(async (req, res) => {
    const existing = await prisma.category.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!existing) throw notFound("Category not found");
    await prisma.category.delete({ where: { id: req.params.id } });
    res.status(204).send();
  })
);

export default router;
