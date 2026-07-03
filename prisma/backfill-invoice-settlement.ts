import { PrismaClient } from "@prisma/client";
import { recomputeAllLinkedInvoiceSettlements } from "../src/lib/settlement";

const prisma = new PrismaClient();

// Manual backfill for bills that already have bill-linked charges.
//
// Bill-linked charges (commission, damage, transport, …) settle part of the
// bill: they count toward amountPaid and the PAID/PARTIAL status, exactly
// like payments. Charges recorded before this rule never triggered that
// recompute, so their bills still show the old due amount. The same backfill
// also runs automatically on server startup; this script exists for running
// it by hand (e.g. against a database the server isn't pointed at).
//
// Idempotent — the recompute derives amountPaid/status from scratch, so
// running it again produces the same result.
async function main() {
  const n = await recomputeAllLinkedInvoiceSettlements(prisma);
  console.log(
    n === 0
      ? "Nothing to backfill — no bill-linked charges found."
      : `Recomputed settlement for ${n} bill(s) with linked charges.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
