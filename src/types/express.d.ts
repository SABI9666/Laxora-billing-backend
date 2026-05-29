import { Role } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      // Set by the auth middleware after verifying the JWT.
      auth?: { userId: string; email: string };
      // Set by the tenant middleware after resolving the active business.
      businessId?: string;
      memberRole?: Role;
    }
  }
}

export {};
