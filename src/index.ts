import { createApp } from "./app";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";
import { recomputeAllLinkedInvoiceSettlements } from "./lib/settlement";

const app = createApp();

// Cloud Run injects PORT; bind to 0.0.0.0 so the container is reachable.
const server = app.listen(env.port, "0.0.0.0", () => {
  console.log(`Laxora billing API listening on port ${env.port} (${env.nodeEnv})`);

  // Bill-linked charges count toward a bill's settled amount; bills whose
  // charges predate that rule still show the old due/status. Idempotent, so
  // it just confirms the current values on every later boot.
  recomputeAllLinkedInvoiceSettlements(prisma)
    .then((n) => {
      if (n > 0) console.log(`Settlement backfill checked ${n} bill(s)`);
    })
    .catch((e) => console.error("Settlement backfill failed:", e));
});

// Graceful shutdown so in-flight requests finish on container stop.
const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down...`);
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
