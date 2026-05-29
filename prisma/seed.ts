import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// Creates a demo account so you can log in immediately after deploy.
// Login: demo@laxora.app / demo1234
async function main() {
  const email = "demo@laxora.app";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log("Demo user already exists, skipping seed.");
    return;
  }

  const passwordHash = await bcrypt.hash("demo1234", 10);
  const user = await prisma.user.create({
    data: { name: "Demo User", email, passwordHash },
  });
  const business = await prisma.business.create({
    data: {
      name: "Demo Traders",
      ownerId: user.id,
      gstin: "29ABCDE1234F1Z5",
      phone: "9999999999",
    },
  });
  await prisma.membership.create({
    data: { userId: user.id, businessId: business.id, role: "OWNER" },
  });

  const customer = await prisma.party.create({
    data: { businessId: business.id, name: "Acme Corp", type: "CUSTOMER", phone: "8888888888" },
  });
  await prisma.item.createMany({
    data: [
      { businessId: business.id, name: "Widget A", unit: "PCS", salePrice: 100, purchasePrice: 60, taxRate: 18, stockQty: 50, lowStockAlert: 10 },
      { businessId: business.id, name: "Service B", unit: "HRS", salePrice: 500, taxRate: 18, isService: true },
    ],
  });

  console.log("Seeded demo account:");
  console.log("  email: demo@laxora.app");
  console.log("  password: demo1234");
  console.log(`  business: ${business.name} (${business.id})`);
  console.log(`  customer: ${customer.name}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
