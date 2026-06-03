import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env";
import api from "./routes";
import { errorHandler, notFoundHandler } from "./middleware/error";

export function createApp() {
  const app = express();

  app.use(helmet());
  // Allow configured origins, any *.vercel.app deployment, and localhost.
  // (Vercel preview URLs change per deploy, so we match the domain.)
  const isAllowedOrigin = (origin?: string | null): boolean => {
    if (!origin) return true; // same-origin, curl, server-to-server
    if (env.corsOrigins.includes(origin)) return true;
    try {
      const host = new URL(origin).hostname;
      if (host === "localhost" || host === "127.0.0.1") return true;
      if (host.endsWith(".vercel.app")) return true;
    } catch {
      /* malformed origin */
    }
    return false;
  };
  app.use(
    cors({
      origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
      credentials: true,
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan(env.nodeEnv === "production" ? "combined" : "dev"));

  // Health check for Cloud Run / uptime probes.
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/api", api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
