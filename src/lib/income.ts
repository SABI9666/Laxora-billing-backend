// Credit-voucher purposes that represent direct business income — money earned
// for a service or other misc income (e.g. LED service) that is NOT a receipt
// against a sales bill. Unlike a "Customer Receipt" (which only settles an
// existing sale and is already counted as revenue on that bill), these vouchers
// are standalone income: they are added to revenue/profit in the dashboard and
// the P&L, and — like every credit voucher — they also show in the cash book.
export const INCOME_PURPOSES = ["Service Income", "Other Income"] as const;

export type IncomePurpose = (typeof INCOME_PURPOSES)[number];

// Mutable string[] copy for Prisma `{ in: [...] }` filters (which reject the
// readonly tuple type above).
export const INCOME_PURPOSE_LIST: string[] = [...INCOME_PURPOSES];
