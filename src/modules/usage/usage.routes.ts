import { Router } from "express";
import { prisma } from "../../lib/prisma";
import { asyncHandler } from "../../utils/async";

const router = Router();

// Days are bucketed in Indian time (IST, UTC+5:30), same as the dashboard.
const IST_MS = 5.5 * 60 * 60 * 1000;
const dayKey = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);

// The frontend pings every minute while its tab is visible.
const HEARTBEAT_SEC = 60;
// Gaps up to this long are credited in full (covers timer jitter and slow
// networks). A longer gap means the app was closed or in the background, so
// only one heartbeat interval is credited for the ping that just arrived.
const MAX_GAP_SEC = 3 * 60;

// POST /api/usage/heartbeat — "the app is open right now". Accumulates worked
// seconds for the current user + shop on today's row.
router.post(
  "/heartbeat",
  asyncHandler(async (req, res) => {
    const businessId = req.businessId!;
    const userId = req.auth!.userId;
    const now = new Date();
    const day = dayKey(now);

    const where = { businessId_userId_day: { businessId, userId, day } };
    const existing = await prisma.appUsage.findUnique({ where });

    let seconds: number;
    if (!existing) {
      try {
        const created = await prisma.appUsage.create({
          data: { businessId, userId, day, seconds: HEARTBEAT_SEC, lastPingAt: now },
        });
        seconds = created.seconds;
      } catch {
        // Two tabs raced to create today's row — fall through to an update.
        const updated = await prisma.appUsage.update({
          where,
          data: { seconds: { increment: HEARTBEAT_SEC }, lastPingAt: now },
        });
        seconds = updated.seconds;
      }
    } else {
      const elapsed = Math.round((now.getTime() - existing.lastPingAt.getTime()) / 1000);
      const credit = elapsed <= 0 ? 0 : elapsed <= MAX_GAP_SEC ? elapsed : HEARTBEAT_SEC;
      const updated = await prisma.appUsage.update({
        where,
        data: { seconds: existing.seconds + credit, lastPingAt: now },
      });
      seconds = updated.seconds;
    }

    res.json({ day, seconds });
  })
);

// GET /api/usage/summary?days=7 — per-day time worked in the app (all users of
// this shop combined) plus how many entries were made each day, edits included.
router.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const businessId = req.businessId!;
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 31);

    const now = new Date();
    const ist = new Date(now.getTime() + IST_MS);
    const todayStart = new Date(
      Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_MS
    );
    const start = new Date(todayStart.getTime() - (days - 1) * 24 * 3600 * 1000);

    // Oldest → today.
    const keys: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      keys.push(dayKey(new Date(todayStart.getTime() - i * 24 * 3600 * 1000 + 12 * 3600 * 1000)));
    }

    const [usage, items, edits, invoices, payments, expenses] = await Promise.all([
      prisma.appUsage.groupBy({
        by: ["day"],
        where: { businessId, day: { gte: keys[0] } },
        _sum: { seconds: true },
      }),
      prisma.item.findMany({
        where: { businessId, createdAt: { gte: start } },
        select: { createdAt: true },
      }),
      // Edits: product edits and bill edits, from the activity log.
      prisma.activityLog.findMany({
        where: {
          businessId,
          type: { in: ["ITEM_EDIT", "INVOICE_EDIT"] },
          createdAt: { gte: start },
        },
        select: { createdAt: true, type: true },
      }),
      prisma.invoice.findMany({
        where: { businessId, createdAt: { gte: start } },
        select: { createdAt: true, type: true, channel: true },
      }),
      prisma.payment.findMany({
        where: { businessId, createdAt: { gte: start } },
        select: { createdAt: true },
      }),
      prisma.expense.findMany({
        where: { businessId, createdAt: { gte: start } },
        select: { createdAt: true },
      }),
    ]);

    const secondsByDay = new Map(usage.map((u) => [u.day, u._sum.seconds ?? 0]));

    type Entries = {
      productsAdded: number;
      productsEdited: number;
      bills: number;
      billEdits: number;
      purchases: number;
      onlineOrders: number;
      payments: number;
      expenses: number;
      total: number;
    };
    const blank = (): Entries => ({
      productsAdded: 0,
      productsEdited: 0,
      bills: 0,
      billEdits: 0,
      purchases: 0,
      onlineOrders: 0,
      payments: 0,
      expenses: 0,
      total: 0,
    });
    const entriesByDay = new Map<string, Entries>();
    const bump = (d: Date, field: Exclude<keyof Entries, "total">) => {
      const k = dayKey(d);
      const cur = entriesByDay.get(k) ?? blank();
      cur[field] += 1;
      cur.total += 1;
      entriesByDay.set(k, cur);
    };
    items.forEach((r) => bump(r.createdAt, "productsAdded"));
    edits.forEach((r) =>
      bump(r.createdAt, r.type === "INVOICE_EDIT" ? "billEdits" : "productsEdited")
    );
    invoices.forEach((r) => {
      if (r.type === "PURCHASE") bump(r.createdAt, "purchases");
      else if (r.channel === "ONLINE") bump(r.createdAt, "onlineOrders");
      else bump(r.createdAt, "bills");
    });
    payments.forEach((r) => bump(r.createdAt, "payments"));
    expenses.forEach((r) => bump(r.createdAt, "expenses"));

    const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const rows = keys.map((k) => ({
      day: k,
      label: WEEKDAY[new Date(`${k}T00:00:00Z`).getUTCDay()],
      seconds: secondsByDay.get(k) ?? 0,
      entries: entriesByDay.get(k) ?? blank(),
    }));

    const today = rows[rows.length - 1];
    res.json({
      days: rows,
      todaySeconds: today?.seconds ?? 0,
      todayEntries: today?.entries.total ?? 0,
      totalSeconds: rows.reduce((s, r) => s + r.seconds, 0),
      totalEntries: rows.reduce((s, r) => s + r.entries.total, 0),
    });
  })
);

export default router;
