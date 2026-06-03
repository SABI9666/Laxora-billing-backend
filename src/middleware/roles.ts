import { NextFunction, Request, Response } from "express";
import { Role } from "@prisma/client";
import { forbidden } from "../utils/errors";

// Restricts a route to members holding one of the given roles within the
// active business. Must run after resolveTenant (which sets req.memberRole).
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.memberRole || !roles.includes(req.memberRole)) {
      return next(forbidden("You do not have permission to perform this action"));
    }
    next();
  };
}

// Roles allowed to manage shop masters/stock. FRANCHISE_ADMIN (the owner)
// has full control; CASHIER/STAFF are billing-only.
export const SHOP_MANAGERS: Role[] = [
  Role.OWNER,
  Role.ADMIN,
  Role.MANAGER,
  Role.FRANCHISE_ADMIN,
];

// Roles allowed to create sales/bills at a shop.
export const BILLING_ROLES: Role[] = [
  Role.OWNER,
  Role.ADMIN,
  Role.MANAGER,
  Role.CASHIER,
  Role.STAFF,
  Role.FRANCHISE_ADMIN,
];
