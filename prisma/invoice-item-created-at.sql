-- Bill lines remember when they were added.
--
-- "+ Add" on an existing bill and the replacement goods of an exchange used
-- to be indistinguishable from the original lines, so the party ledger showed
-- one "Sale Invoice" entry at the bill's date carrying the grown total. With
-- a stamp on every line the ledger can show "Items added" / "Exchange: items
-- taken" as their own dated entries and the invoice line at its original
-- amount.
--
-- Existing lines are stamped with their bill's creation time, so nothing that
-- already exists changes shape; only lines added from now on split out.
--
-- Safe to run multiple times. Apply in the Neon SQL Editor when you cannot
-- reach the database directly with `npx prisma db push`.

ALTER TABLE "InvoiceItem" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "InvoiceItem" ii
SET "createdAt" = i."createdAt"
FROM "Invoice" i
WHERE ii."invoiceId" = i.id
  AND ii."createdAt" > i."createdAt" + INTERVAL '10 minutes'
  AND ii."createdAt" > NOW() - INTERVAL '10 minutes';
