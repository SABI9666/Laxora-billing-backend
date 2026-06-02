import { Prisma, StockMovementType } from "@prisma/client";

// A signed stock change plus the metadata needed for the audit trail.
export interface StockChange {
  businessId: string;
  itemId: string;
  type: StockMovementType;
  // Signed quantity applied to on-hand stock: positive adds, negative removes.
  quantity: Prisma.Decimal | number;
  reason?: string | null;
  reference?: string | null;
  invoiceId?: string | null;
  createdById?: string | null;
}

// Applies a stock change inside a transaction: updates the running balance on
// the Item and appends a StockMovement row. Returns the new on-hand quantity.
// Must be called with a transaction client so the balance and ledger stay
// consistent.
export async function recordStockMovement(
  tx: Prisma.TransactionClient,
  change: StockChange
): Promise<Prisma.Decimal> {
  const item = await tx.item.update({
    where: { id: change.itemId },
    data: { stockQty: { increment: change.quantity } },
    select: { stockQty: true },
  });

  await tx.stockMovement.create({
    data: {
      businessId: change.businessId,
      itemId: change.itemId,
      type: change.type,
      quantity: change.quantity,
      balanceAfter: item.stockQty,
      reason: change.reason ?? null,
      reference: change.reference ?? null,
      invoiceId: change.invoiceId ?? null,
      createdById: change.createdById ?? null,
    },
  });

  return item.stockQty;
}
