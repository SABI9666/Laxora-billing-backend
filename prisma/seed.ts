import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// Seeds a demo LED-retail franchise so you can log in immediately after deploy.
//   Franchise owner / admin : demo@laxora.app    / demo1234    (FRANCHISE_ADMIN)
//   Shop cashier            : cashier@laxora.app / cashier1234 (CASHIER, Shop 1)
//   Platform admin          : admin@laxora.app   / admin1234
async function main() {
  const email = "demo@laxora.app";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log("Demo user already exists, skipping seed.");
    return;
  }

  const passwordHash = await bcrypt.hash("demo1234", 10);
  const owner = await prisma.user.create({
    data: { name: "Laxora Owner", email, passwordHash },
  });

  // Top-level brand.
  const franchise = await prisma.franchise.create({
    data: {
      name: "Laxora LED Lights",
      ownerId: owner.id,
      gstin: "29ABCDE1234F1Z5",
      phone: "9999999999",
    },
  });

  // Two shops under the franchise.
  const shop1 = await prisma.business.create({
    data: {
      name: "Laxora LED — MG Road",
      code: "MG-ROAD",
      ownerId: owner.id,
      franchiseId: franchise.id,
      gstin: "29ABCDE1234F1Z5",
      phone: "9999999999",
    },
  });
  const shop2 = await prisma.business.create({
    data: {
      name: "Laxora LED — Whitefield",
      code: "WHITEFIELD",
      ownerId: owner.id,
      franchiseId: franchise.id,
      gstin: "29ABCDE1234F2Z4",
      phone: "8888888888",
    },
  });

  // Owner is FRANCHISE_ADMIN at both shops.
  await prisma.membership.createMany({
    data: [
      { userId: owner.id, businessId: shop1.id, role: "FRANCHISE_ADMIN" },
      { userId: owner.id, businessId: shop2.id, role: "FRANCHISE_ADMIN" },
    ],
  });

  // A cashier limited to shop 1.
  const cashier = await prisma.user.create({
    data: {
      name: "Shop Cashier",
      email: "cashier@laxora.app",
      passwordHash: await bcrypt.hash("cashier1234", 10),
    },
  });
  await prisma.membership.create({
    data: { userId: cashier.id, businessId: shop1.id, role: "CASHIER" },
  });

  // LED product categories + items for shop 1.
  const categoryNames = ["Bulb", "Panel", "Strip", "Driver"];
  const categories: Record<string, string> = {};
  for (const name of categoryNames) {
    const c = await prisma.category.create({
      data: { businessId: shop1.id, name },
    });
    categories[name] = c.id;
  }

  await prisma.item.createMany({
    data: [
      {
        businessId: shop1.id,
        categoryId: categories["Bulb"],
        name: "LED Bulb 9W Cool White",
        sku: "BULB-9W-CW",
        barcode: "8901234500011",
        brand: "Laxora",
        wattage: "9W",
        unit: "PCS",
        salePrice: 120,
        purchasePrice: 70,
        taxRate: 18,
        stockQty: 200,
        lowStockAlert: 25,
      },
      {
        businessId: shop1.id,
        categoryId: categories["Panel"],
        name: "LED Panel 18W Square",
        sku: "PNL-18W-SQ",
        barcode: "8901234500028",
        brand: "Laxora",
        wattage: "18W",
        unit: "PCS",
        salePrice: 450,
        purchasePrice: 280,
        taxRate: 18,
        stockQty: 60,
        lowStockAlert: 10,
      },
      {
        businessId: shop1.id,
        categoryId: categories["Strip"],
        name: "LED Strip 5m Warm White",
        sku: "STR-5M-WW",
        barcode: "8901234500035",
        brand: "Laxora",
        wattage: "24W",
        unit: "ROLL",
        salePrice: 650,
        purchasePrice: 400,
        taxRate: 18,
        stockQty: 8,
        lowStockAlert: 10, // intentionally low to demo reorder alerts
      },
      {
        businessId: shop1.id,
        categoryId: categories["Driver"],
        name: "LED Driver 12V 60W",
        sku: "DRV-12V-60W",
        barcode: "8901234500042",
        brand: "Laxora",
        wattage: "60W",
        unit: "PCS",
        salePrice: 320,
        purchasePrice: 190,
        taxRate: 18,
        stockQty: 40,
        lowStockAlert: 8,
      },
    ],
  });

  // A walk-in customer for POS sales.
  await prisma.party.create({
    data: { businessId: shop1.id, name: "Walk-in Customer", type: "CUSTOMER" },
  });

  // Platform admin (for the admin panel).
  await prisma.user.create({
    data: {
      name: "Platform Admin",
      email: "admin@laxora.app",
      passwordHash: await bcrypt.hash("admin1234", 10),
      isPlatformAdmin: true,
    },
  });

  console.log("Seeded Laxora LED franchise:");
  console.log(`  franchise: ${franchise.name} (${franchise.id})`);
  console.log(`  shops: ${shop1.name} / ${shop2.name}`);
  console.log("  owner login   : demo@laxora.app / demo1234");
  console.log("  cashier login : cashier@laxora.app / cashier1234");
  console.log("  platform admin: admin@laxora.app / admin1234");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
