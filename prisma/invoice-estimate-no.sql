-- Invoices can reference the estimate/quotation they were raised from.
-- Run once against the production database (or use `npx prisma db push`).

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "estimateNo" TEXT;
