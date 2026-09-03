import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { asyncHandler } from "../../utils/async";
import { validateBody } from "../../middleware/validate";
import { badRequest, notFound } from "../../utils/errors";
import { buildPartyLedger } from "../../lib/ledger";
import { loadInvoiceDetail } from "../invoice/invoice.routes";

// Share links: a signed, read-only view of one bill or one party statement
// that the shop can send on WhatsApp. The token carries what it points at
// and is verified with the app's JWT secret, so nothing is stored and a link
// cannot be edited to reach another shop's data. Links stay valid for a year.
type SharePayload = { s: "share"; kind: "invoice" | "ledger"; id: string; businessId: string };

const SHARE_TTL = "365d";

const businessSelect = {
  name: true,
  gstin: true,
  phone: true,
  email: true,
  address: true,
} as const;

// ---- Authenticated: mint a link -------------------------------------------
export const shareRoutes = Router();

const createSchema = z.object({
  kind: z.enum(["invoice", "ledger"]),
  id: z.string().min(1),
});

// POST /api/share { kind, id } → { token, path }
shareRoutes.post(
  "/",
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const { kind, id } = req.body as z.infer<typeof createSchema>;
    const businessId = req.businessId!;
    const exists =
      kind === "invoice"
        ? await prisma.invoice.findFirst({ where: { id, businessId }, select: { id: true } })
        : await prisma.party.findFirst({ where: { id, businessId }, select: { id: true } });
    if (!exists) throw notFound(kind === "invoice" ? "Bill not found" : "Party not found");

    const payload: SharePayload = { s: "share", kind, id, businessId };
    const token = jwt.sign(payload, env.jwtSecret, { expiresIn: SHARE_TTL });
    res.json({ token, path: `/share/${kind}/${token}` });
  })
);

// ---- Public: open a link ---------------------------------------------------
export const sharePublicRoutes = Router();

function readToken(token: string): SharePayload {
  try {
    const p = jwt.verify(token, env.jwtSecret) as Partial<SharePayload>;
    if (p.s !== "share" || !p.kind || !p.id || !p.businessId) throw new Error("bad");
    return p as SharePayload;
  } catch {
    throw badRequest("This share link is invalid or has expired");
  }
}

// GET /api/public/share/:token → { kind, business, invoice } | { kind, business, ledger… }
sharePublicRoutes.get(
  "/:token",
  asyncHandler(async (req, res) => {
    const p = readToken(req.params.token);
    const business = await prisma.business.findUnique({
      where: { id: p.businessId },
      select: businessSelect,
    });
    if (!business) throw notFound("Shop not found");

    if (p.kind === "invoice") {
      const invoice = await loadInvoiceDetail(p.businessId, p.id);
      if (!invoice) throw notFound("Bill not found");
      return res.json({ kind: "invoice", business, invoice });
    }

    const party = await prisma.party.findFirst({ where: { id: p.id, businessId: p.businessId } });
    if (!party) throw notFound("Party not found");
    const { ledger, totals, bills, closingBalance } = await buildPartyLedger(prisma, party);
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    res.json({
      kind: "ledger",
      business,
      party: {
        id: party.id,
        name: party.name,
        type: party.type,
        phone: party.phone,
        gstin: party.gstin,
        billingAddress: party.billingAddress,
        openingBalance: round2(Number(party.openingBalance)),
      },
      closingBalance,
      totals,
      bills,
      ledger,
    });
  })
);
