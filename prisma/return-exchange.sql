-- Sales return / exchange reconciliation.
--
-- A return can now be recorded as an EXCHANGE: the customer hands goods back
-- and takes other products instead, all on the same bill. To keep the books
-- reversible, the credit note remembers the replacement lines it added and the
-- receipt raised for any extra amount the customer paid, so undoing the return
-- also strips those lines off the bill, puts their stock back and unwinds the
-- cash-book entry.
--
-- Safe to run multiple times (idempotent). Apply in the Neon SQL Editor when
-- you cannot reach the database directly with `npx prisma db push`.

ALTER TABLE "CreditNote" ADD COLUMN IF NOT EXISTS "exchangeLines" JSONB;
ALTER TABLE "CreditNote" ADD COLUMN IF NOT EXISTS "collectPaymentId" TEXT;
