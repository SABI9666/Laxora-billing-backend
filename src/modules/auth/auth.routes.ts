import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { authenticate } from "../../middleware/auth";
import { hashPassword, verifyPassword } from "../../utils/password";
import { signToken } from "../../utils/jwt";
import { conflict, notFound, unauthorized } from "../../utils/errors";

const router = Router();

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  businessName: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// POST /api/auth/register — create user + their first business + owner membership.
router.post(
  "/register",
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const { name, email, password, businessName } = req.body;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw conflict("Email is already registered");

    const passwordHash = await hashPassword(password);

    const { user, business } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { name, email, passwordHash },
      });
      const business = await tx.business.create({
        data: { name: businessName, ownerId: user.id },
      });
      await tx.membership.create({
        data: { userId: user.id, businessId: business.id, role: "OWNER" },
      });
      return { user, business };
    });

    const token = signToken({ userId: user.id, email: user.email });
    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
      business: { id: business.id, name: business.name },
    });
  })
);

// POST /api/auth/login
router.post(
  "/login",
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw unauthorized("Invalid email or password");

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw unauthorized("Invalid email or password");

    const token = signToken({ userId: user.id, email: user.email });
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  })
);

// GET /api/auth/me — current user + their businesses.
router.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: {
        id: true,
        name: true,
        email: true,
        isPlatformAdmin: true,
        memberships: {
          select: {
            role: true,
            business: {
              select: {
                id: true,
                name: true,
                code: true,
                franchiseId: true,
                franchise: { select: { id: true, name: true } },
              },
            },
          },
        },
        ownedFranchises: {
          select: { id: true, name: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!user) throw notFound("User not found");
    res.json({ user });
  })
);

export default router;
