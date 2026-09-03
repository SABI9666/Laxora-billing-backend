-- Bills remember whether their rates were entered GST-inclusive, so editing
-- reopens in the same mode and newly added products default to it.
-- Run once against the production database (or use `npx prisma db push`).

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "taxInclusive" BOOLEAN NOT NULL DEFAULT false;
