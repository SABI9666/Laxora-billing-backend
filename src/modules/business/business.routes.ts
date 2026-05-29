import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";

const router = Router();

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  gstin: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().optional(),
  logoUrl: z.string().url().optional().or(z.literal("")),
});

// GET /api/business — the active business profile.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const business = await prisma.business.findUnique({
      where: { id: req.businessId! },
    });
    res.json({ business });
  })
);

// PUT /api/business — update the active business profile.
router.put(
  "/",
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const business = await prisma.business.update({
      where: { id: req.businessId! },
      data: req.body,
    });
    res.json({ business });
  })
);

export default router;
