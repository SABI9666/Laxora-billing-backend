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
});

// GET /api/categories — list categories (with item counts) for the shop.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const categories = await prisma.category.findMany({
      where: { businessId: req.businessId! },
      orderBy: { name: "asc" },
      include: { _count: { select: { items: true } } },
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
    try {
      const category = await prisma.category.create({
        data: { name: req.body.name, businessId: req.businessId! },
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
    const category = await prisma.category.update({
      where: { id: req.params.id },
      data: req.body,
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
