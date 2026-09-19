-- Website listing copy for a product, shown on the Laxorashopping storefront.
--
--   specification — one "Label: Value" per line, e.g.
--                     Material: Aluminium
--                     Beam angle: 120°
--                   which the site renders as a specification table. Free text
--                   still shows as a paragraph.
--   warranty      — plain text, e.g. "2 years" or "6 months manufacturer warranty".
--
-- Idempotent: safe to paste into the Neon SQL editor more than once. The server
-- also applies these on boot (src/lib/schema-guard.ts), so a deploy that goes
-- out before this file is run does not break product reads.

ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "specification" TEXT;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "warranty" TEXT;
