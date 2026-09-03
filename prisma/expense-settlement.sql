-- Bill-linked charges: say what happened to the money.
--
-- A charge against a bill (electrician commission, transport, damage …) can
-- mean three different things, and the ledger, the bill's due and the cash
-- book each need to know which:
--   ADJUST        deducted from what the party owes on the bill; no cash moves
--   PAID_TO_PARTY cash/bank handed to the bill's party (commission given to
--                 the electrician); the bill is NOT reduced
--   PAID_TO_OTHER cash/bank paid to someone else (a transporter); the bill is
--                 NOT reduced
-- Existing rows stay NULL and keep behaving exactly as before.
--
-- Safe to run multiple times. Apply in the Neon SQL Editor when you cannot
-- reach the database directly with `npx prisma db push`.

ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "settlement" TEXT;

-- OPTIONAL, zero-risk backfill: a Commission / Electrician Charge recorded
-- with a cash method against a SALE bill that the customer paid IN FULL by
-- receipts can only have been a payout — the deduction never happened, so
-- marking it PAID_TO_PARTY changes no bill status and no cash-book figure;
-- it only makes the party's ledger show the commission earned and paid.
UPDATE "Expense" e
SET "settlement" = 'PAID_TO_PARTY'
FROM "Invoice" i
WHERE e."invoiceId" = i.id
  AND e."settlement" IS NULL
  AND e."method" IS NOT NULL
  AND e."category" IN ('Commission', 'Electrician Charge')
  AND i.type::text = 'SALE'
  AND (SELECT COALESCE(SUM(p.amount), 0) FROM "Payment" p
       WHERE p."invoiceId" = i.id AND p.direction::text = 'IN') >= i.total - 0.05;
