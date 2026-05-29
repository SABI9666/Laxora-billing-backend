import { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { forbidden, unauthorized } from "../utils/errors";

// Resolves the active business for the request and verifies membership.
// The client selects the active business via the `x-business-id` header.
// If omitted, the user's first business is used.
export async function resolveTenant(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  if (!req.auth) return next(unauthorized());

  const requested = req.header("x-business-id");

  const membership = await prisma.membership.findFirst({
    where: {
      userId: req.auth.userId,
      ...(requested ? { businessId: requested } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  if (!membership) {
    return next(
      forbidden(
        requested
          ? "You do not have access to this business"
          : "No business found for this user"
      )
    );
  }

  req.businessId = membership.businessId;
  req.memberRole = membership.role;
  next();
}
