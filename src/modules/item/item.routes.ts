import { Router } from "express";
import multer from "multer";
import { Storage } from "@google-cloud/storage";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, notFound } from "../../utils/errors";
import { requireRole, SHOP_MANAGERS, BILLING_ROLES } from "../../middleware/roles";
import type { Request, Response, NextFunction } from "express";

const router = Router();

// Product image upload: stores the file in a Google Cloud Storage bucket
// (in this project) and returns its public URL. The bucket name comes from the
// GCS_BUCKET env var; on Cloud Run the ambient service account is used.
const gcsBucket = process.env.GCS_BUCKET || "";
const gcs = new Storage();
const MAX_UPLOAD_MB = 15;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }, // phone photos are often 8-12 MB
});

// Runs multer for a single file and converts its errors (e.g. file-too-large)
// into clear 400s. Without this a too-large upload falls through to the generic
// 500 "Internal server error", which reads as "upload just failed".
function uploadSingle(field: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    upload.single(field)(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE")
          return next(
            badRequest(
              `This file is too large. Please upload a file under ${MAX_UPLOAD_MB} MB (try a smaller photo or a PDF).`
            )
          );
        return next(badRequest(err.message));
      }
      if (err) return next(err);
      next();
    });
  };
}

const itemSchema = z.object({
  name: z.string().min(1),
  categoryId: z.string().optional().nullable(),
  supplierId: z.string().optional().nullable(),
  // Nullable as well as optional: a product saved without one of these has
  // null in the database, and edit forms echo that null back.
  sku: z.string().optional().nullable(),
  barcode: z.string().optional().nullable(),
  brand: z.string().optional().nullable(),
  wattage: z.string().optional().nullable(),
  hsn: z.string().optional().nullable(),
  unit: z.string().default("PCS"),
  salePrice: z.number().nonnegative().default(0),
  mrp: z.number().nonnegative().default(0),
  purchasePrice: z.number().nonnegative().default(0),
  taxRate: z.number().min(0).max(100).default(0),
  stockQty: z.number().default(0),
  lowStockAlert: z.number().default(0),
  isService: z.boolean().default(false),
  // Online store / website listing fields.
  description: z.string().optional().nullable(),
  imageUrl: z.string().optional().nullable(),
  imageUrl2: z.string().optional().nullable(),
  imageUrl3: z.string().optional().nullable(),
  publishOnline: z.boolean().default(false),
  purchaseBillUrl: z.string().optional().nullable(),
});

// Ensures a categoryId (if provided) belongs to the active shop.
async function assertCategory(businessId: string, categoryId?: string | null) {
  if (!categoryId) return;
  const category = await prisma.category.findFirst({
    where: { id: categoryId, businessId },
  });
  if (!category) throw badRequest("Invalid categoryId for this shop");
}

// POST /api/items/upload-image — multipart upload of one product image.
router.post(
  "/upload-image",
  // Billing staff attach purchase-bill photos while creating invoices, so this
  // is open to all billing roles, not just managers.
  requireRole(...BILLING_ROLES),
  uploadSingle("file"),
  asyncHandler(async (req, res) => {
    if (!gcsBucket)
      throw badRequest(
        "Image storage is not configured on the server (GCS_BUCKET is not set). Please contact support."
      );
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) throw badRequest("No file received");
    if (!file.mimetype.startsWith("image/") && file.mimetype !== "application/pdf")
      throw badRequest("Only image or PDF files can be uploaded");

    const ext = (file.originalname.split(".").pop() || "jpg")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 5);
    const objectName = `product-images/${req.businessId}/${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.${ext}`;

    const blob = gcs.bucket(gcsBucket).file(objectName);
    await blob.save(file.buffer, {
      contentType: file.mimetype,
      resumable: false,
      metadata: { cacheControl: "public, max-age=31536000" },
    });

    res.json({ url: `https://storage.googleapis.com/${gcsBucket}/${objectName}` });
  })
);

// GET /api/items?search=&categoryId=&lowStock=true&barcode=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { search, categoryId, barcode, lowStock } = req.query;
    const items = await prisma.item.findMany({
      where: {
        businessId: req.businessId!,
        ...(search
          ? {
              OR: [
                { name: { contains: String(search), mode: "insensitive" } },
                { sku: { contains: String(search), mode: "insensitive" } },
                { barcode: { contains: String(search), mode: "insensitive" } },
                { brand: { contains: String(search), mode: "insensitive" } },
              ],
            }
          : {}),
        ...(categoryId ? { categoryId: String(categoryId) } : {}),
        ...(barcode ? { barcode: String(barcode) } : {}),
      },
      include: { category: { select: { id: true, name: true, parentId: true } }, supplier: { select: { id: true, name: true } } },
      orderBy: { name: "asc" },
    });

    // Low-stock filter is applied in memory (Decimal comparison).
    const filtered =
      lowStock === "true"
        ? items.filter(
            (i) => !i.isService && Number(i.stockQty) <= Number(i.lowStockAlert)
          )
        : items;

    res.json({ items: filtered });
  })
);

// GET /api/items/lookup?barcode= — fast single-item lookup for POS scanning.
router.get(
  "/lookup",
  asyncHandler(async (req, res) => {
    const { barcode, sku } = req.query;
    if (!barcode && !sku) throw badRequest("barcode or sku is required");
    const code = String(barcode ?? sku ?? "").trim();
    // A bare product number ("9" or "009") matches codes like "BULB-009".
    const num = /^\d+$/.test(code) ? code.padStart(3, "0") : null;
    const item = await prisma.item.findFirst({
      where: {
        businessId: req.businessId!,
        OR: [
          { barcode: code },
          { sku: { equals: code, mode: "insensitive" } },
          ...(num
            ? [{ sku: { endsWith: `-${num}` } }, { sku: num }]
            : []),
        ],
      },
      include: { category: { select: { id: true, name: true, parentId: true } }, supplier: { select: { id: true, name: true } } },
    });
    if (!item) throw notFound("No item matches that code");
    res.json({ item });
  })
);

// GET /api/items/edit-history — every product edit in this shop, newest
// first: what changed (old → new per field), who edited, when, the reason,
// and whether the admin has approved it yet. Powers the Edit History page.
// Filtered and paginated on the server so thousands of edits stay fast:
//   ?search=<product name> &status=PENDING|APPROVED|REJECTED
//   &priceOnly=1 (only edits touching sale/purchase/MRP/tax)
//   &from=YYYY-MM-DD &to=YYYY-MM-DD &page=N (50 per page)
// (Must be registered before "/:id" so "edit-history" isn't read as an id.)
router.get(
  "/edit-history",
  asyncHandler(async (req, res) => {
    const businessId = req.businessId!;
    const PAGE_SIZE = 50;
    const page = Math.max(1, Number(req.query.page) || 1);
    const term = String(req.query.search ?? "").trim();
    const status = String(req.query.status ?? "").toUpperCase();
    const priceOnly = String(req.query.priceOnly ?? "") === "1";
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(`${String(req.query.to)}T23:59:59`) : null;

    const conds = [Prisma.sql`"businessId" = ${businessId}`];
    if (["PENDING", "APPROVED", "REJECTED"].includes(status)) {
      conds.push(Prisma.sql`status = ${status}`);
    }
    if (term) conds.push(Prisma.sql`"itemName" ILIKE ${"%" + term + "%"}`);
    // JSONB ?| — true when the edit touched any of the price/tax fields.
    if (priceOnly) {
      conds.push(
        Prisma.sql`changes ?| array['salePrice','purchasePrice','mrp','taxRate']`
      );
    }
    if (from && !isNaN(from.getTime())) conds.push(Prisma.sql`"createdAt" >= ${from}`);
    if (to && !isNaN(to.getTime())) conds.push(Prisma.sql`"createdAt" <= ${to}`);
    const where = Prisma.join(conds, " AND ");

    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
        SELECT id, "itemId", "itemName", changes, previous, reason, status,
               "requestedByName", "createdAt", "reviewedAt"
        FROM "ItemChangeRequest"
        WHERE ${where}
        ORDER BY "createdAt" DESC
        LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}
      `),
      prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS n FROM "ItemChangeRequest" WHERE ${where}
      `),
    ]);
    res.json({
      requests: rows,
      total: Number(countRows[0]?.n ?? 0),
      page,
      pageSize: PAGE_SIZE,
    });
  })
);

// GET /api/items/:id
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const item = await prisma.item.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
      include: { category: { select: { id: true, name: true, parentId: true } }, supplier: { select: { id: true, name: true } } },
    });
    if (!item) throw notFound("Item not found");
    res.json({ item });
  })
);

// GET /api/items/:id/price-history — the last sale rate given to each customer
// for this product, so the biller can see "what did we charge Raju vs Manu".
router.get(
  "/:id/price-history",
  asyncHandler(async (req, res) => {
    const businessId = req.businessId!;
    const rows = await prisma.invoiceItem.findMany({
      where: { itemId: req.params.id, invoice: { businessId, type: "SALE" } },
      select: {
        rate: true,
        taxRate: true,
        quantity: true,
        invoice: {
          select: {
            invoiceNumber: true,
            invoiceDate: true,
            party: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { invoice: { invoiceDate: "desc" } },
      take: 60,
    });

    // Keep the most recent rate per customer, up to 10 distinct customers.
    const seen = new Set<string>();
    const history: {
      party: string;
      rate: number;
      taxRate: number;
      quantity: number;
      invoiceNumber: string;
      date: Date;
    }[] = [];
    for (const r of rows) {
      const name = r.invoice.party?.name ?? "—";
      const key = r.invoice.party?.id ?? name;
      if (seen.has(key)) continue;
      seen.add(key);
      history.push({
        party: name,
        rate: Number(r.rate),
        taxRate: Number(r.taxRate),
        quantity: Number(r.quantity),
        invoiceNumber: r.invoice.invoiceNumber,
        date: r.invoice.invoiceDate,
      });
      if (history.length >= 10) break;
    }
    res.json({ history });
  })
);

// GET /api/items/:id/history — the product's full life: every time it was
// sold and purchased (date, bill number, customer/supplier, qty, rate,
// amount) plus other stock changes (returns, adjustments, transfers,
// opening stock) and summary totals.
router.get(
  "/:id/history",
  asyncHandler(async (req, res) => {
    const businessId = req.businessId!;
    const item = await prisma.item.findFirst({
      where: { id: req.params.id, businessId },
      select: {
        id: true,
        name: true,
        sku: true,
        unit: true,
        stockQty: true,
        isService: true,
        supplier: { select: { name: true } },
      },
    });
    if (!item) throw notFound("Item not found");

    const [lines, moves] = await Promise.all([
      prisma.invoiceItem.findMany({
        where: { itemId: item.id, invoice: { businessId } },
        select: {
          quantity: true,
          rate: true,
          taxRate: true,
          amount: true,
          invoice: {
            select: {
              id: true,
              invoiceNumber: true,
              invoiceDate: true,
              type: true,
              channel: true,
              status: true,
              party: { select: { name: true } },
            },
          },
        },
        orderBy: { invoice: { invoiceDate: "desc" } },
        take: 500,
      }),
      prisma.stockMovement.findMany({
        where: { itemId: item.id, businessId },
        orderBy: { createdAt: "desc" },
        take: 300,
      }),
    ]);

    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const mapLine = (l: (typeof lines)[number]) => ({
      date: l.invoice.invoiceDate,
      invoiceId: l.invoice.id,
      invoiceNumber: l.invoice.invoiceNumber,
      party: l.invoice.party?.name ?? "—",
      quantity: Number(l.quantity),
      rate: round2(Number(l.rate)),
      taxRate: Number(l.taxRate),
      amount: round2(Number(l.amount)),
      channel: l.invoice.channel,
      status: l.invoice.status,
    });
    const sales = lines.filter((l) => l.invoice.type === "SALE").map(mapLine);
    const purchases = lines.filter((l) => l.invoice.type === "PURCHASE").map(mapLine);

    // Other stock changes: returns, adjustments, transfers, opening stock.
    // Bill lines ("Sale"/"Purchase") are already listed above, and the
    // reverse-and-reapply churn of bill edits is noise, so both are skipped.
    const other = moves
      .filter(
        (m) =>
          m.reason !== "Sale" &&
          m.reason !== "Purchase" &&
          !(m.reason ?? "").startsWith("Edit ") &&
          !(m.reason ?? "").startsWith("Edit reversal ")
      )
      .slice(0, 100)
      .map((m) => ({
        date: m.createdAt,
        type: m.type,
        quantity: Number(m.quantity),
        balanceAfter: Number(m.balanceAfter),
        reason: m.reason,
        reference: m.reference,
      }));

    const sum = (rows: { quantity: number }[]) =>
      round2(rows.reduce((s, r) => s + r.quantity, 0));
    const sumAmt = (rows: { amount: number }[]) =>
      round2(rows.reduce((s, r) => s + r.amount, 0));

    res.json({
      item: {
        id: item.id,
        name: item.name,
        sku: item.sku,
        unit: item.unit,
        stockQty: Number(item.stockQty),
        isService: item.isService,
        supplier: item.supplier?.name ?? null,
      },
      summary: {
        soldQty: sum(sales),
        soldAmount: sumAmt(sales),
        soldBills: sales.length,
        lastSoldAt: sales[0]?.date ?? null,
        purchasedQty: sum(purchases),
        purchasedAmount: sumAmt(purchases),
        purchasedBills: purchases.length,
        lastPurchasedAt: purchases[0]?.date ?? null,
      },
      sales,
      purchases,
      other,
    });
  })
);

// POST /api/items
router.post(
  "/",
  requireRole(...SHOP_MANAGERS),
  validateBody(itemSchema),
  asyncHandler(async (req, res) => {
    await assertCategory(req.businessId!, req.body.categoryId);
    const openingQty = req.body.isService ? 0 : Number(req.body.stockQty) || 0;
    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.item.create({
        data: { ...req.body, businessId: req.businessId! },
      });
      // Record the opening stock as the product's first entry, so its entry
      // date is captured automatically in the stock ledger (the item is
      // created with the opening quantity already set, so we log the movement
      // directly rather than incrementing it again).
      if (openingQty > 0) {
        await tx.stockMovement.create({
          data: {
            businessId: req.businessId!,
            itemId: created.id,
            type: "IN",
            quantity: created.stockQty,
            balanceAfter: created.stockQty,
            reason: "Opening stock",
            createdById: req.auth!.userId,
          },
        });
      }
      return created;
    });
    res.status(201).json({ item });
  })
);

// PUT /api/items/:id — shop edits go to the admin as a pending approval
// request (platform admins edit directly). Every edit records what changed
// (old → new per field) and the editor's reason, feeding the shop's
// "Edit History" page.
router.put(
  "/:id",
  requireRole(...SHOP_MANAGERS),
  validateBody(itemSchema.partial().extend({ reason: z.string().max(500).optional() })),
  asyncHandler(async (req, res) => {
    const existing = await prisma.item.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!existing) throw notFound("Item not found");
    await assertCategory(req.businessId!, req.body.categoryId);

    const { reason, ...proposed } = req.body as Record<string, unknown> & {
      reason?: string;
    };

    // Keep only the fields that actually changed, and snapshot their old
    // values — that's what makes "₹68 → ₹75" possible in the history.
    const differs = (cur: unknown, next: unknown) => {
      if (typeof next === "number") return Number(cur ?? 0) !== next;
      if (typeof next === "boolean") return Boolean(cur) !== next;
      return String(cur ?? "") !== String(next ?? "");
    };
    const snapshot = (cur: unknown, next: unknown) => {
      if (typeof next === "number") return Number(cur ?? 0);
      if (typeof next === "boolean") return Boolean(cur);
      return cur == null ? null : String(cur);
    };
    // `any` so the collected values satisfy Prisma's JSON input type.
    const changes: Record<string, any> = {};
    const previous: Record<string, any> = {};
    for (const [k, v] of Object.entries(proposed)) {
      const cur = (existing as Record<string, unknown>)[k];
      if (differs(cur, v)) {
        changes[k] = v;
        previous[k] = snapshot(cur, v);
      }
    }

    // Nothing actually changed — don't log an empty edit.
    if (Object.keys(changes).length === 0) {
      return res.json({ item: existing, unchanged: true });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { name: true, username: true, email: true, isPlatformAdmin: true },
    });
    const editorName = user?.name ?? user?.username ?? user?.email ?? null;

    // Count this edit in the dashboard's per-day activity.
    await prisma.activityLog.create({
      data: {
        businessId: req.businessId!,
        type: "ITEM_EDIT",
        refId: existing.id,
        userId: req.auth!.userId,
      },
    });

    // Only the platform admin applies changes immediately. Every shop user's
    // edit — including the OWNER's — is held for admin approval, so no catalog
    // change takes effect until the admin approves it.
    if (user?.isPlatformAdmin) {
      const item = await prisma.item.update({
        where: { id: req.params.id },
        data: changes,
      });
      // Log the applied edit so the history is complete for admin edits too.
      await prisma.itemChangeRequest.create({
        data: {
          businessId: req.businessId!,
          itemId: existing.id,
          itemName: existing.name,
          changes,
          previous,
          reason: reason || null,
          status: "APPROVED",
          reviewedAt: new Date(),
          requestedById: req.auth!.userId,
          requestedByName: editorName,
        },
      });
      return res.json({ item });
    }

    // Everyone else: hold as a pending change request for admin approval.
    const request = await prisma.itemChangeRequest.create({
      data: {
        businessId: req.businessId!,
        itemId: existing.id,
        itemName: existing.name,
        changes,
        previous,
        reason: reason || null,
        requestedById: req.auth!.userId,
        requestedByName: editorName,
      },
    });
    res.status(202).json({
      pending: true,
      request,
      message: "Your change was sent to the admin for approval.",
    });
  })
);

// DELETE /api/items/:id
router.delete(
  "/:id",
  requireRole(...SHOP_MANAGERS),
  asyncHandler(async (req, res) => {
    const existing = await prisma.item.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!existing) throw notFound("Item not found");
    await prisma.item.delete({ where: { id: req.params.id } });
    res.status(204).send();
  })
);

export default router;
