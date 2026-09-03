import { createApp } from "./app";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";
import { recomputeAllLinkedInvoiceSettlements, reconcilePayments } from "./lib/settlement";
import { ensureSchema } from "./lib/schema-guard";

const app = createApp();

// Cloud Run injects PORT; bind to 0.0.0.0 so the container is reachable.
const server = app.listen(env.port, "0.0.0.0", async () => {
  console.log(`Laxora billing API listening on port ${env.port} (${env.nodeEnv})`);

  // Columns the code relies on that may not have been added to the database
  // by hand yet. Runs first so the backfills below see the full schema.
  await ensureSchema(prisma);

  // Bill-linked charges count toward a bill's settled amount; bills whose
  // charges predate that rule still show the old due/status. Idempotent, so
  // it just confirms the current values on every later boot.
  recomputeAllLinkedInvoiceSettlements(prisma)
    .then((n) => {
      if (n > 0) console.log(`Settlement backfill checked ${n} bill(s)`);
    })
    .catch((e) => console.error("Settlement backfill failed:", e));

  // Receipts recorded before they were allocated to bills sit on the party
  // ledger but leave the bills pending. Spread them across the open bills so
  // the ledger and the bill list agree. Idempotent — later boots find nothing.
  reconcilePayments(prisma)
    .then(({ allocated, rechecked }) => {
      if (allocated > 0 || rechecked > 0)
        console.log(
          `Payment reconcile: ${allocated} voucher(s) allocated to bills, ${rechecked} partial bill(s) rechecked`
        );
    })
    .catch((e) => console.error("Payment reconcile failed:", e));
});

// Graceful shutdown so in-flight requests finish on container stop.
const shutdown = (signal: string) => {
  console.log(`${signal} received, shutting down...`);
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
