import { NextFunction, Request, Response } from "express";
import { ZodSchema } from "zod";
import { badRequest } from "../utils/errors";

// Validates req.body against a Zod schema and replaces it with the parsed value.
export const validateBody =
  (schema: ZodSchema) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(badRequest("Validation failed", result.error.flatten()));
    }
    req.body = result.data;
    next();
  };
