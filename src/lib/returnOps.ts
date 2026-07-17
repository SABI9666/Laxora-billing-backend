import { StockMovementType } from "@prisma/client";
import { prisma } from "./prisma";
import { recordStockMovement } from "./stock";

// Reverses a sales return (credit note): removes the stock the return had added
// back, frees up the returnedQty on each line so those items can be sold/returned
// again, deletes the refund voucher (restoring the cash book) if there was one,
// and finally deletes the credit note. Returns false if the note isn't found.
export async function reverseCreditNote(
  creditNoteId: string,
  businessId: string,
  actorUserId?: string | null
): Promise<boolean> {
  const note = await prisma.creditNote.findFirst({
    where: { id: creditNoteId, businessId },
  });
  if (!note) return false;

  // Per-line detail is stored on returns created after this feature shipped.
  const lines = Array.isArray(note.lines)
    ? (note.lines as Array<{
        invoiceItemId?: string;
        itemId?: string | null;
        quantity?: number;
      }>)
    : [];

  await prisma.$transaction(async (tx) => {
    for (const l of lines) {
      const qty = Number(l.quantity ?? 0);
      if (l.invoiceItemId && qty > 0) {
        await tx.invoiceItem.updateMany({
          where: { id: l.invoiceItemId, invoiceId: note.invoiceId ?? undefined },
          data: { returnedQty: { decrement: qty } },
        });
      }
      if (l.itemId && qty > 0) {
        await recordStockMovement(tx, {
          businessId,
          itemId: l.itemId,
          type: StockMovementType.OUT,
          quantity: -qty,
          reason: "Reversal of wrong sales return",
          reference: note.invoiceNumber,
          invoiceId: note.invoiceId,
          createdById: actorUserId ?? null,
        });
      }
    }

    if (note.refundPaymentId) {
      await tx.payment.deleteMany({ where: { id: note.refundPaymentId, businessId } });
    }

    await tx.creditNote.delete({ where: { id: note.id } });
  });
  return true;
}
