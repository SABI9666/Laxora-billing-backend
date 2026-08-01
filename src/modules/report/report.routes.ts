import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";
import { badRequest } from "../../utils/errors";

const router = Router();
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// GET /api/reports/gst?month=YYYY-MM — month-wise GST filing summary for the
// active shop: outward (sales) and inward (purchases) taxable value + tax,
// broken down per invoice and per tax rate, plus credit notes (sales returns)
// that reduce output tax. Tax is split CGST/SGST (intra-state).
router.get(
  "/gst",
  asyncHandler(async (req, res) => {
    const month = String(req.query.month || "");
    if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest("month must be YYYY-MM");
    const start = new Date(`${month}-01T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const businessId = req.businessId!;

    const [invoices, creditNotes, business] = await Promise.all([
      prisma.invoice.findMany({
        where: { businessId, invoiceDate: { gte: start, lt: end } },
        include: {
          items: { select: { amount: true, taxRate: true } },
          party: { select: { name: true, gstin: true } },
        },
        orderBy: { invoiceDate: "asc" },
      }),
      prisma.creditNote.findMany({
        where: { businessId, date: { gte: start, lt: end } },
        orderBy: { date: "asc" },
      }),
      prisma.business.findUnique({
        where: { id: businessId },
        select: { name: true, gstin: true },
      }),
    ]);

    type RateAgg = Record<string, { taxable: number; tax: number }>;

    const build = (type: "SALE" | "PURCHASE") => {
      const list = invoices.filter((i) => i.type === type);
      const rates: RateAgg = {};
      let totalTaxable = 0;
      let totalTax = 0;
      const rows = list.map((inv) => {
        let taxable = 0;
        let tax = 0;
        for (const l of inv.items) {
          const amt = Number(l.amount);
          const r = Number(l.taxRate);
          const t = (amt * r) / 100;
          taxable += amt;
          tax += t;
          const k = String(r);
          rates[k] = {
            taxable: (rates[k]?.taxable ?? 0) + amt,
            tax: (rates[k]?.tax ?? 0) + t,
          };
        }
        totalTaxable += taxable;
        totalTax += tax;
        return {
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          date: inv.invoiceDate,
          party: inv.party?.name ?? "",
          gstin: inv.party?.gstin ?? null,
          taxable: round2(taxable),
          cgst: round2(tax / 2),
          sgst: round2(tax / 2),
          tax: round2(tax),
          total: Number(inv.total),
        };
      });
      const rateSummary = Object.entries(rates)
        .map(([rate, v]) => ({
          rate: Number(rate),
          taxable: round2(v.taxable),
          cgst: round2(v.tax / 2),
          sgst: round2(v.tax / 2),
          tax: round2(v.tax),
        }))
        .sort((a, b) => a.rate - b.rate);
      return {
        rows,
        rateSummary,
        totalTaxable: round2(totalTaxable),
        totalTax: round2(totalTax),
      };
    };

    const sales = build("SALE");
    const purchases = build("PURCHASE");

    const cnRows = creditNotes.map((c) => ({
      id: c.id,
      invoiceNumber: c.invoiceNumber ?? "",
      date: c.date,
      taxable: round2(Number(c.netAmount)),
      tax: round2(Number(c.taxAmount)),
      total: round2(Number(c.totalAmount)),
    }));
    const cnTax = round2(cnRows.reduce((s, c) => s + c.tax, 0));
    const cnTaxable = round2(cnRows.reduce((s, c) => s + c.taxable, 0));

    res.json({
      month,
      business,
      sales,
      purchases,
      creditNotes: { rows: cnRows, totalTaxable: cnTaxable, totalTax: cnTax },
      // Output tax (minus returns) less input tax credit = net GST payable.
      netPayable: round2(sales.totalTax - cnTax - purchases.totalTax),
    });
  })
);

export default router;
