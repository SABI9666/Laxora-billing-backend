import { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { forbidden, unauthorized } from "../utils/errors";

// Allows the request only if the authenticated user is a platform admin.
// Used for cross-tenant admin endpoints (no business scoping).
export async function requirePlatformAdmin(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  if (!req.auth) return next(unauthorized());
  const user = await prisma.user.findUnique({
    where: { id: req.auth.userId },
    select: { isPlatformAdmin: true },
  });
  if (!user?.isPlatformAdmin) {
    return next(forbidden("Platform admin access required"));
  }
  next();
}
