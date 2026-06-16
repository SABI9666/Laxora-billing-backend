import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// One-time backfill for product entry dates.
//
// Products created before stock-in movements were logged automatically have no
// entry (IN) record in the stock ledger, so the movement register has no real
// entry date for them. We don't know when they actually arrived, so we treat
// TODAY as their entry date: for every in-stock, non-service product that has
// no IN movement yet, we insert one "Opening stock" IN movement dated now.
//
// New products created from here on already log their own entry date on
// creation, so they are skipped (they will have an IN movement). The script is
// idempotent — running it again does nothing because matching products already
// have an IN movement.
async function main() {
  const today = new Date();

  // In-stock, tracked products that have no inward (entry) movement yet.
  const products = await prisma.item.findMany({
    where: {
      isService: false,
      stockQty: { gt: 0 },
      stockMovements: { none: { quantity: { gt: 0 } } },
    },
    select: { id: true, businessId: true, name: true, stockQty: true },
  });

  if (products.length === 0) {
    console.log("Nothing to backfill — every in-stock product already has an entry date.");
    return;
  }

  await prisma.stockMovement.createMany({
    data: products.map((p) => ({
      businessId: p.businessId,
      itemId: p.id,
      type: "IN" as const,
      quantity: p.stockQty,
      balanceAfter: p.stockQty,
      reason: "Opening stock (backfilled)",
      createdAt: today,
    })),
  });

  console.log(
    `Backfilled entry date (${today.toISOString().slice(0, 10)}) for ${products.length} product(s):`
  );
  for (const p of products) console.log(`  • ${p.name} (qty ${p.stockQty})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
