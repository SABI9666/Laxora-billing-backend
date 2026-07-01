import { randomBytes } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { requireRole, SHOP_MANAGERS } from "../../middleware/roles";

const router = Router();

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  gstin: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().optional(),
  logoUrl: z.string().url().optional().or(z.literal("")),
  // Starting balances for the cash book (cash in shop / money in bank).
  openingCash: z.number().optional(),
  openingBank: z.number().optional(),
  // Sale invoice numbering: prefix (e.g. "26-") and the next number to issue.
  saleInvoicePrefix: z.string().max(16).optional().or(z.literal("")),
  nextSaleNo: z.number().int().positive().optional(),
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

// --- Online store integration key -----------------------------------------
// The website authenticates to /api/online-store/* with this per-shop key.

// GET /api/business/online-store-key — current key (null if not connected).
router.get(
  "/online-store-key",
  requireRole(...SHOP_MANAGERS),
  asyncHandler(async (req, res) => {
    const business = await prisma.business.findUnique({
      where: { id: req.businessId! },
      select: { onlineStoreApiKey: true },
    });
    res.json({ apiKey: business?.onlineStoreApiKey ?? null });
  })
);

// POST /api/business/online-store-key — generate (or rotate) the key.
router.post(
  "/online-store-key",
  requireRole(...SHOP_MANAGERS),
  asyncHandler(async (req, res) => {
    const apiKey = `lxos_${randomBytes(24).toString("hex")}`;
    await prisma.business.update({
      where: { id: req.businessId! },
      data: { onlineStoreApiKey: apiKey },
    });
    res.json({ apiKey });
  })
);

// DELETE /api/business/online-store-key — disconnect the online store.
router.delete(
  "/online-store-key",
  requireRole(...SHOP_MANAGERS),
  asyncHandler(async (req, res) => {
    await prisma.business.update({
      where: { id: req.businessId! },
      data: { onlineStoreApiKey: null },
    });
    res.status(204).send();
  })
);

export default router;
