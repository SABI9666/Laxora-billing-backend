import { StockMovementType } from "@prisma/client";
import { prisma } from "./prisma";
import { recordStockMovement } from "./stock";
import { recomputeInvoiceSettlement } from "./settlement";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Deletes an invoice and reverses its stock effect (sale items go back into
// stock, purchase items come out), logging the reversal in the stock ledger.
// Any returns recorded against the bill go with it: their stock is already back
// on the shelf, so only the quantity still counted as sold is reversed here —
// putting the full quantity back would double the returned goods. The credit
// notes are then removed so they cannot keep reducing the receivable for a bill
// that no longer exists, and every voucher on the bill (receipts as well as
// return/exchange refunds) is deleted so the cash book unwinds cleanly.
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
    const wasSale = invoice.type === "SALE";
    for (const l of invoice.items) {
      if (!l.itemId) continue;
      // On a sale, goods already returned are back in stock — only what is
      // still outstanding as sold needs reversing.
      const qty = wasSale
        ? Number(l.quantity) - Number(l.returnedQty ?? 0)
        : Number(l.quantity);
      if (Math.abs(qty) < 0.0000001) continue;
      await recordStockMovement(tx, {
        businessId,
        itemId: l.itemId,
        type: wasSale ? StockMovementType.IN : StockMovementType.OUT,
        quantity: wasSale ? qty : -qty,
        reason: `Reversal: deleted ${invoice.invoiceNumber}`,
        reference: invoice.invoiceNumber,
        createdById: actorUserId ?? null,
      });
    }
    await tx.creditNote.deleteMany({ where: { invoiceId: invoice.id, businessId } });
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
//
// When the return was an EXCHANGE, the swap is unwound too: the replacement
// lines come off the bill (totals and GST shrink back), their stock goes back
// on the shelf, and the receipt taken for the extra amount is deleted so the
// cash book returns to where it was.
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
        select: { id: true, invoiceNumber: true, subtotal: true, taxAmount: true, discount: true },
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

  // Replacement goods billed by an exchange (empty for a plain return).
  const exchangeLines = Array.isArray(note.exchangeLines)
    ? (note.exchangeLines as Array<{
        invoiceItemId?: string;
        itemId?: string | null;
        quantity?: number;
        taxRate?: number;
        amount?: number;
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

    // Unwind the exchange half: take the replacement lines off the bill, shrink
    // its subtotal/GST/total back, and put those goods back into stock.
    if (exchangeLines.length && invoice) {
      let subDrop = 0;
      let taxDrop = 0;
      for (const l of exchangeLines) {
        const qty = Number(l.quantity ?? 0);
        const amount = Number(l.amount ?? 0);
        subDrop += amount;
        taxDrop += (amount * Number(l.taxRate ?? 0)) / 100;
        if (l.invoiceItemId) {
          await tx.invoiceItem.deleteMany({
            where: { id: l.invoiceItemId, invoiceId: invoice.id },
          });
        }
        if (l.itemId && qty > 0) {
          await recordStockMovement(tx, {
            businessId,
            itemId: l.itemId,
            type: StockMovementType.IN,
            quantity: qty,
            reason: "Reversal of wrong exchange",
            reference: invoice.invoiceNumber,
            invoiceId: invoice.id,
            createdById: actorUserId ?? null,
          });
        }
      }
      const subtotal = round2(Number(invoice.subtotal) - subDrop);
      const taxAmount = round2(Number(invoice.taxAmount) - taxDrop);
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          subtotal,
          taxAmount,
          total: round2(subtotal - Number(invoice.discount) + taxAmount),
        },
      });
    }

    // Give the refund back: deleting the OUT voucher restores the cash book.
    // The receipt taken for an exchange difference goes the same way, so the
    // shop's cash/bank balance ends up exactly where it started.
    const voucherIds = [note.refundPaymentId, note.collectPaymentId].filter(
      Boolean
    ) as string[];
    if (voucherIds.length) {
      await tx.payment.deleteMany({
        where: { id: { in: voucherIds }, businessId },
      });
    }

    await tx.creditNote.delete({ where: { id: note.id } });

    // The bill's total and its receipts both moved — re-derive amountPaid and
    // PAID/PARTIAL/UNPAID so pending lists and reports stay in step.
    if (invoice) await recomputeInvoiceSettlement(tx, invoice.id);
  });
  return true;
}
