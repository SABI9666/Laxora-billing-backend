import { PrismaClient } from "@prisma/client";

// Columns added by hand-run SQL files in prisma/. The production database is
// migrated by pasting those files into the Neon SQL editor, and a deploy that
// goes out before that step breaks every Prisma read of the affected table
// (opening a bill 500s on a missing InvoiceItem.createdAt, for example).
// Every statement here is idempotent, so the server simply makes sure the
// columns exist on boot; the SQL files remain the documented source.
const STATEMENTS: string[] = [
  // prisma/invoice-tax-inclusive.sql
  `ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "taxInclusive" BOOLEAN NOT NULL DEFAULT false`,
  // prisma/return-exchange.sql
  `ALTER TABLE "CreditNote" ADD COLUMN IF NOT EXISTS "exchangeLines" JSONB`,
  `ALTER TABLE "CreditNote" ADD COLUMN IF NOT EXISTS "collectPaymentId" TEXT`,
  // prisma/expense-settlement.sql (the optional PAID_TO_PARTY backfill is a
  // business decision and stays manual)
  `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "settlement" TEXT`,
  // prisma/invoice-item-created-at.sql — existing lines must be stamped with
  // their bill's time, otherwise the ledger would show them as added later.
  `ALTER TABLE "InvoiceItem" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  `UPDATE "InvoiceItem" ii
     SET "createdAt" = i."createdAt"
     FROM "Invoice" i
     WHERE ii."invoiceId" = i.id
       AND ii."createdAt" > i."createdAt" + INTERVAL '10 minutes'
       AND ii."createdAt" > NOW() - INTERVAL '10 minutes'`,
];

export async function ensureSchema(prisma: PrismaClient): Promise<void> {
  for (const sql of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (e) {
      // Keep going: one failure (e.g. a read-only role) must not stop the
      // other columns from being checked, and the API still starts.
      console.error("Schema guard statement failed:", sql.split("\n")[0].trim(), "-", (e as Error).message);
    }
  }
}
