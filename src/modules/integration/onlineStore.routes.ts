import { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { PartyType, Prisma, StockMovementType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, unauthorized } from "../../utils/errors";
import { recordStockMovement } from "../../lib/stock";

// Online store integration API — used by the Laxorashopping website.
// Authenticated with a per-shop API key (generated in Settings → Online Store)
// sent in the `x-api-key` header, instead of a user JWT. All data is scoped to
// the shop (Business) the key belongs to, e.g. the Peravoor shop.
const router = Router();

async function resolveOnlineStore(req: Request, _res: Response, next: NextFunction) {
  try {
    const key = req.header("x-api-key");
    if (!key) return next(unauthorized("Missing x-api-key header"));
    const business = await prisma.business.findUnique({
      where: { onlineStoreApiKey: key },
      select: { id: true, isActive: true },
    });
    if (!business || !business.isActive) return next(unauthorized("Invalid API key"));
    req.businessId = business.id;
    next();
  } catch (err) {
    next(err);
  }
}

router.use(resolveOnlineStore);

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// GET /api/online-store/stock — live stock for the shop, so the website can
// show the same counts as the billing software.
router.get(
  "/stock",
  asyncHandler(async (req, res) => {
    const items = await prisma.item.findMany({
      where: { businessId: req.businessId!, isService: false },
      select: {
        id: true,
        name: true,
        sku: true,
        barcode: true,
        stockQty: true,
        salePrice: true,
        unit: true,
      },
      orderBy: { name: "asc" },
    });
    res.json({
      items: items.map((i) => ({
        ...i,
        stockQty: Number(i.stockQty),
        salePrice: Number(i.salePrice),
      })),
    });
  })
);

const orderSchema = z.object({
  // Website order id (or payment id) — makes order syncing idempotent.
  orderRef: z.string().min(1),
  customer: z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
    email: z.string().optional(),
    address: z.string().optional(),
  }),
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        sku: z.string().optional(),
        barcode: z.string().optional(),
        quantity: z.number().positive(),
        price: z.number().nonnegative(),
      })
    )
    .min(1),
  shipping: z.number().nonnegative().default(0),
  discount: z.number().nonnegative().default(0),
  paid: z.boolean().default(true),
  paymentMethod: z.enum(["CASH", "BANK", "UPI", "CARD", "CHEQUE", "OTHER"]).default("OTHER"),
  paymentRef: z.string().optional(),
  notes: z.string().optional(),
});

// POST /api/online-store/orders — create an ONLINE sale bill for a website
// order: matches website products to shop items (by SKU / barcode / name),
// reduces stock atomically, records the customer and the gateway payment.
router.post(
  "/orders",
  validateBody(orderSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof orderSchema>;
    const businessId = req.businessId!;

    // Idempotency: if this website order was already billed, return that bill.
    const existing = await prisma.invoice.findFirst({
      where: { businessId, externalRef: body.orderRef },
      include: { items: true, party: true },
    });
    if (existing) {
      return res.json({ invoice: existing, duplicate: true, unmatchedItems: [] });
    }

    // Match each website line to a shop item: SKU first, then barcode, then
    // product name (case-insensitive). Unmatched lines are still billed as
    // description-only lines, but cannot reduce stock.
    const unmatched: string[] = [];
    const lines: {
      itemId: string | null;
      description: string;
      quantity: number;
      rate: number;
      amount: number;
    }[] = [];
    for (const l of body.items) {
      let item = null;
      if (l.sku) {
        item = await prisma.item.findFirst({
          where: { businessId, sku: { equals: l.sku.trim(), mode: "insensitive" } },
        });
      }
      if (!item && l.barcode) {
        item = await prisma.item.findFirst({
          where: { businessId, barcode: l.barcode.trim() },
        });
      }
      if (!item) {
        item = await prisma.item.findFirst({
          where: { businessId, name: { equals: l.name.trim(), mode: "insensitive" } },
        });
      }
      if (!item) unmatched.push(l.name);
      lines.push({
        itemId: item?.id ?? null,
        description: item?.name ?? l.name,
        quantity: l.quantity,
        rate: l.price,
        amount: round2(l.quantity * l.price),
      });
    }
    if (body.shipping > 0) {
      lines.push({
        itemId: null,
        description: "Shipping charges",
        quantity: 1,
        rate: body.shipping,
        amount: round2(body.shipping),
      });
    }

    const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
    const total = round2(subtotal - body.discount);
    if (total < 0) throw badRequest("Discount cannot exceed the order amount");

    const noteParts = [
      `Online order ${body.orderRef}`,
      body.customer.address ? `Deliver to: ${body.customer.address}` : null,
      body.paymentRef ? `Payment ref: ${body.paymentRef}` : null,
      body.notes ?? null,
    ].filter(Boolean);

    let invoice;
    try {
      invoice = await prisma.$transaction(async (tx) => {
      // Find the customer by phone/email, or create them on first order.
      let party = body.customer.phone
        ? await tx.party.findFirst({
            where: { businessId, type: PartyType.CUSTOMER, phone: body.customer.phone },
          })
        : null;
      if (!party && body.customer.email) {
        party = await tx.party.findFirst({
          where: {
            businessId,
            type: PartyType.CUSTOMER,
            email: { equals: body.customer.email, mode: "insensitive" },
          },
        });
      }
      if (!party) {
        party = await tx.party.create({
          data: {
            businessId,
            type: PartyType.CUSTOMER,
            name: body.customer.name.trim(),
            phone: body.customer.phone ?? null,
            email: body.customer.email ?? null,
            billingAddress: body.customer.address ?? null,
          },
        });
      }

      // Reserve a number in the dedicated online series (ONL-0001, …).
      const biz = await tx.business.update({
        where: { id: businessId },
        data: { nextOnlineSaleNo: { increment: 1 } },
      });
      const invoiceNumber = `ONL-${String(biz.nextOnlineSaleNo - 1).padStart(4, "0")}`;

      const created = await tx.invoice.create({
        data: {
          businessId,
          partyId: party.id,
          invoiceNumber,
          type: "SALE",
          channel: "ONLINE",
          externalRef: body.orderRef,
          status: body.paid ? "PAID" : "UNPAID",
          subtotal,
          discount: body.discount,
          taxAmount: 0,
          total,
          amountPaid: body.paid ? total : 0,
          notes: noteParts.join("\n"),
          items: {
            create: lines.map((l) => ({
              itemId: l.itemId,
              description: l.description,
              quantity: l.quantity,
              rate: l.rate,
              taxRate: 0,
              amount: l.amount,
            })),
          },
        },
        include: { items: true, party: true },
      });

      for (const l of lines) {
        if (!l.itemId) continue;
        await recordStockMovement(tx, {
          businessId,
          itemId: l.itemId,
          type: StockMovementType.OUT,
          quantity: -l.quantity,
          reason: "Online sale",
          reference: invoiceNumber,
          invoiceId: created.id,
        });
      }

      if (body.paid) {
        await tx.payment.create({
          data: {
            businessId,
            partyId: party.id,
            invoiceId: created.id,
            direction: "IN",
            purpose: "Online Order",
            amount: total,
            method: body.paymentMethod,
            notes: body.paymentRef ? `Gateway payment ref: ${body.paymentRef}` : null,
          },
        });
      }

      return created;
      });
    } catch (err) {
      // Unique (businessId, externalRef) hit — a concurrent request already
      // billed this order. Return that bill instead of failing.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const dup = await prisma.invoice.findFirst({
          where: { businessId, externalRef: body.orderRef },
          include: { items: true, party: true },
        });
        if (dup) return res.json({ invoice: dup, duplicate: true, unmatchedItems: [] });
      }
      throw err;
    }

    res.status(201).json({ invoice, duplicate: false, unmatchedItems: unmatched });
  })
);

export default router;
