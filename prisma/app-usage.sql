-- App usage (time worked in the application) table.
-- Safe to run multiple times (idempotent). Apply in the Neon SQL Editor when
-- you cannot reach the database directly with `prisma db push`.

CREATE TABLE IF NOT EXISTS "AppUsage" (
  "id"         TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "day"        TEXT NOT NULL,
  "seconds"    INTEGER NOT NULL DEFAULT 0,
  "lastPingAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AppUsage_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "AppUsage"
    ADD CONSTRAINT "AppUsage_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "AppUsage_businessId_userId_day_key"
  ON "AppUsage"("businessId", "userId", "day");
CREATE INDEX IF NOT EXISTS "AppUsage_businessId_day_idx"
  ON "AppUsage"("businessId", "day");
