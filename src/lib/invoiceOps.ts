import { StockMovementType } from "@prisma/client";
import { prisma } from "./prisma";
import { recordStockMovement } from "./stock";

// Deletes an invoice and reverses its stock effect (sale items go back into
// stock, purchase items come out), logging the reversal in the stock ledger.
export async function deleteInvoiceWithReversal(
  invoiceId: string,
  businessId: string,
  actorUserId?: string | null
): Promise<boolean> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, businessId },
    include: { items: true },
  });
  if (!invoice) return false;

  await prisma.$transaction(async (tx) => {
    for (const l of invoice.items) {
      if (!l.itemId) continue;
      const wasSale = invoice.type === "SALE";
      await recordStockMovement(tx, {
        businessId,
        itemId: l.itemId,
        type: wasSale ? StockMovementType.IN : StockMovementType.OUT,
        quantity: wasSale ? Number(l.quantity) : -Number(l.quantity),
        reason: `Reversal: deleted ${invoice.invoiceNumber}`,
        reference: invoice.invoiceNumber,
        createdById: actorUserId ?? null,
      });
    }
    await tx.payment.deleteMany({ where: { invoiceId: invoice.id } });
    await tx.invoice.delete({ where: { id: invoice.id } });
  });
  return true;
}
