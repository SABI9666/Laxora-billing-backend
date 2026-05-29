import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { notFound } from "../../utils/errors";

const router = Router();

const partySchema = z.object({
  name: z.string().min(1),
  type: z.enum(["CUSTOMER", "SUPPLIER"]).default("CUSTOMER"),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  gstin: z.string().optional(),
  billingAddress: z.string().optional(),
  openingBalance: z.number().default(0),
});

// GET /api/parties?type=CUSTOMER&search=foo
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { type, search } = req.query;
    const parties = await prisma.party.findMany({
      where: {
        businessId: req.businessId!,
        ...(type ? { type: type as "CUSTOMER" | "SUPPLIER" } : {}),
        ...(search
          ? { name: { contains: String(search), mode: "insensitive" } }
          : {}),
      },
      orderBy: { name: "asc" },
    });
    res.json({ parties });
  })
);

// GET /api/parties/:id
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const party = await prisma.party.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!party) throw notFound("Party not found");
    res.json({ party });
  })
);

// POST /api/parties
router.post(
  "/",
  validateBody(partySchema),
  asyncHandler(async (req, res) => {
    const party = await prisma.party.create({
      data: { ...req.body, businessId: req.businessId! },
    });
    res.status(201).json({ party });
  })
);

// PUT /api/parties/:id
router.put(
  "/:id",
  validateBody(partySchema.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.party.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!existing) throw notFound("Party not found");
    const party = await prisma.party.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json({ party });
  })
);

// DELETE /api/parties/:id
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = await prisma.party.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!existing) throw notFound("Party not found");
    await prisma.party.delete({ where: { id: req.params.id } });
    res.status(204).send();
  })
);

export default router;
