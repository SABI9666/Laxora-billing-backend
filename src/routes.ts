import { Router } from "express";
import { authenticate } from "./middleware/auth";
import { resolveTenant } from "./middleware/tenant";
import { requirePlatformAdmin } from "./middleware/admin";
import authRoutes from "./modules/auth/auth.routes";
import adminRoutes from "./modules/admin/admin.routes";
import businessRoutes from "./modules/business/business.routes";
import partyRoutes from "./modules/party/party.routes";
import itemRoutes from "./modules/item/item.routes";
import categoryRoutes from "./modules/category/category.routes";
import stockRoutes from "./modules/stock/stock.routes";
import invoiceRoutes from "./modules/invoice/invoice.routes";
import paymentRoutes from "./modules/payment/payment.routes";
import expenseRoutes from "./modules/expense/expense.routes";
import dashboardRoutes from "./modules/dashboard/dashboard.routes";
import reportRoutes from "./modules/report/report.routes";
import franchiseRoutes from "./modules/franchise/franchise.routes";
import onlineStoreRoutes from "./modules/integration/onlineStore.routes";
import usageRoutes from "./modules/usage/usage.routes";
import { shareRoutes, sharePublicRoutes } from "./modules/share/share.routes";

const api = Router();

// Public auth routes.
api.use("/auth", authRoutes);

// Online store integration (e-commerce website): authenticated by a per-shop
// API key (x-api-key header) instead of a user JWT.
api.use("/online-store", onlineStoreRoutes);

// Read-only bill / statement views opened from a share link (no login).
api.use("/public/share", sharePublicRoutes);

// Cross-tenant admin routes: require auth + platform-admin (no tenant scoping).
api.use("/admin", authenticate, requirePlatformAdmin, adminRoutes);

// Franchise routes: authenticated but cross-shop (no single-tenant scoping).
api.use("/franchise", authenticate, franchiseRoutes);

// Everything below requires a valid token AND an active business (tenant).
api.use(authenticate, resolveTenant);
api.use("/business", businessRoutes);
api.use("/parties", partyRoutes);
api.use("/items", itemRoutes);
api.use("/categories", categoryRoutes);
api.use("/stock", stockRoutes);
api.use("/invoices", invoiceRoutes);
api.use("/payments", paymentRoutes);
api.use("/expenses", expenseRoutes);
api.use("/dashboard", dashboardRoutes);
api.use("/reports", reportRoutes);
api.use("/usage", usageRoutes);
api.use("/share", shareRoutes);

export default api;
