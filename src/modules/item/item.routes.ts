import { Router } from "express";
import multer from "multer";
import { Storage } from "@google-cloud/storage";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, notFound } from "../../utils/errors";
import { requireRole, SHOP_MANAGERS } from "../../middleware/roles";

const router = Router();

// Product image upload: stores the file in a Google Cloud Storage bucket
// (in this project) and returns its public URL. The bucket name comes from the
// GCS_BUCKET env var; on Cloud Run the ambient service account is used.
const gcsBucket = process.env.GCS_BUCKET || "";
const gcs = new Storage();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 }, // 6 MB
});

const itemSchema = z.object({
  name: z.string().min(1),
  categoryId: z.string().optional().nullable(),
  supplierId: z.string().optional().nullable(),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  brand: z.string().optional(),
  wattage: z.string().optional(),
  hsn: z.string().optional(),
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
  requireRole(...SHOP_MANAGERS),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!gcsBucket)
      throw badRequest(
        "Image storage is not configured. Set the GCS_BUCKET env var on the backend."
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
    const item = await prisma.item.findFirst({
      where: {
        businessId: req.businessId!,
        ...(barcode ? { barcode: String(barcode) } : {}),
        ...(sku ? { sku: String(sku) } : {}),
      },
      include: { category: { select: { id: true, name: true, parentId: true } }, supplier: { select: { id: true, name: true } } },
    });
    if (!item) throw notFound("No item matches that code");
    res.json({ item });
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
// request (platform admins edit directly).
router.put(
  "/:id",
  requireRole(...SHOP_MANAGERS),
  validateBody(itemSchema.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.item.findFirst({
      where: { id: req.params.id, businessId: req.businessId! },
    });
    if (!existing) throw notFound("Item not found");
    await assertCategory(req.businessId!, req.body.categoryId);

    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { name: true, username: true, email: true, isPlatformAdmin: true },
    });

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
        data: req.body,
      });
      return res.json({ item });
    }

    // Everyone else: hold as a pending change request for admin approval.
    const request = await prisma.itemChangeRequest.create({
      data: {
        businessId: req.businessId!,
        itemId: existing.id,
        itemName: existing.name,
        changes: req.body,
        requestedById: req.auth!.userId,
        requestedByName: user?.name ?? user?.username ?? user?.email ?? null,
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
