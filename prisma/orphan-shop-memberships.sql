-- Repair: shops nobody can select.
--
-- Access to a shop is granted by the Membership table alone — the tenant
-- middleware, the sidebar shop switcher and the select-shop screen all read it.
-- Shops created through Admin → Shops were saved with an owner but WITHOUT a
-- membership, so they show in the admin panel while being unreachable in the
-- shop app: they never appear in the shop dropdown and their "Shop Logins"
-- list comes back empty.
--
-- This gives every shop's owner the missing OWNER membership. New shops get
-- one automatically now, so this only needs running once for existing data.
-- Safe to run multiple times (it skips shops that already have one).

INSERT INTO "Membership" ("id", "userId", "businessId", "role", "createdAt")
SELECT gen_random_uuid()::text, b."ownerId", b."id", 'OWNER'::"Role", NOW()
FROM "Business" b
WHERE NOT EXISTS (
  SELECT 1 FROM "Membership" m
  WHERE m."businessId" = b."id" AND m."userId" = b."ownerId"
);

-- Check what is now reachable, and by whom:
--   SELECT b.name, b.code, u.username, u.email, m.role
--   FROM "Business" b
--   LEFT JOIN "Membership" m ON m."businessId" = b.id
--   LEFT JOIN "User" u ON u.id = m."userId"
--   ORDER BY b.name;
