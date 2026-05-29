import { NextFunction, Request, Response } from "express";
import { verifyToken } from "../utils/jwt";
import { unauthorized } from "../utils/errors";

// Verifies the Bearer token and attaches { userId, email } to req.auth.
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return next(unauthorized("Missing or invalid Authorization header"));
  }
  try {
    const payload = verifyToken(header.slice(7));
    req.auth = { userId: payload.userId, email: payload.email };
    next();
  } catch {
    next(unauthorized("Invalid or expired token"));
  }
}
