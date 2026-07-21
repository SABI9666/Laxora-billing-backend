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

// Reverses (undoes) a sales return recorded as a credit note: removes the stock
// the return had added back, frees the returnedQty on each line so the items
// count as sold again, deletes the cash/bank refund voucher (restoring the cash
// book) if there was one, and finally removes the credit note. Used both when a
// platform admin undoes a return directly and when one is approved from the
// admin panel.
export async function reverseReturn(
  creditNoteId: string,
  businessId: string,
  actorUserId?: string | null
): Promise<boolean> {
  const note = await prisma.creditNote.findFirst({
    where: { id: creditNoteId, businessId },
  });
  if (!note) return false;

  const invoice = note.invoiceId
    ? await prisma.invoice.findFirst({
        where: { id: note.invoiceId, businessId },
        select: { invoiceNumber: true },
      })
    : null;

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
        // Free up the returned quantity so these items can be sold/returned again.
        await tx.invoiceItem.updateMany({
          where: { id: l.invoiceItemId, invoiceId: note.invoiceId ?? undefined },
          data: { returnedQty: { decrement: qty } },
        });
      }
      if (l.itemId && qty > 0) {
        // Remove the stock that the return had added back.
        await recordStockMovement(tx, {
          businessId,
          itemId: l.itemId,
          type: StockMovementType.OUT,
          quantity: -qty,
          reason: "Reversal of wrong sales return",
          reference: invoice?.invoiceNumber ?? note.invoiceNumber,
          invoiceId: note.invoiceId,
          createdById: actorUserId ?? null,
        });
      }
    }

    // Give the refund back: deleting the OUT voucher restores the cash book.
    if (note.refundPaymentId) {
      await tx.payment.deleteMany({
        where: { id: note.refundPaymentId, businessId },
      });
    }

    await tx.creditNote.delete({ where: { id: note.id } });
  });
  return true;
}
