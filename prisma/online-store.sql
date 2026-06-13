-- Laxora online store + website catalog schema changes.
-- Safe to run multiple times (idempotent). Apply in the Neon SQL Editor when
-- you cannot reach the database directly with `prisma db push`.

-- 1. Invoice channel (POS vs ONLINE) + idempotent online-order reference.
DO $$ BEGIN
  CREATE TYPE "InvoiceChannel" AS ENUM ('POS', 'ONLINE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "nextOnlineSaleNo" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "onlineStoreApiKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Business_onlineStoreApiKey_key"
  ON "Business"("onlineStoreApiKey");

ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "channel" "InvoiceChannel" NOT NULL DEFAULT 'POS';
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "externalRef" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_businessId_externalRef_key"
  ON "Invoice"("businessId", "externalRef");
CREATE INDEX IF NOT EXISTS "Invoice_businessId_channel_idx"
  ON "Invoice"("businessId", "channel");

-- 2. Two-level categories (main category -> subcategory).
ALTER TABLE "Category" ADD COLUMN IF NOT EXISTS "parentId" TEXT;
DO $$ BEGIN
  ALTER TABLE "Category"
    ADD CONSTRAINT "Category_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "Category"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "Category_parentId_idx" ON "Category"("parentId");

-- 3. Product web/catalog fields (images, description, MRP, publish flag).
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "imageUrl2" TEXT;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "imageUrl3" TEXT;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "mrp" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "publishOnline" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "Item_businessId_publishOnline_idx"
  ON "Item"("businessId", "publishOnline");
