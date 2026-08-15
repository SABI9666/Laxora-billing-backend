-- Product edit history: store the old values and the editor's reason with
-- every change request, so the shop's "Edit History" page can show
-- old → new per field. Run once against the production database
-- (or use `npx prisma db push`, which applies the same change).

ALTER TABLE "ItemChangeRequest" ADD COLUMN IF NOT EXISTS "previous" JSONB;
ALTER TABLE "ItemChangeRequest" ADD COLUMN IF NOT EXISTS "reason" TEXT;
