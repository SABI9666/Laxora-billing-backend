import { Router } from "express";
import { authenticate } from "./middleware/auth";
import { resolveTenant } from "./middleware/tenant";
import { requirePlatformAdmin } from "./middleware/admin";
import authRoutes from "./modules/auth/auth.routes";
import adminRoutes from "./modules/admin/admin.routes";
import businessRoutes from "./modules/business/business.routes";
import partyRoutes from "./modules/party/party.routes";
import itemRoutes from "./modules/item/item.routes";
import invoiceRoutes from "./modules/invoice/invoice.routes";
import paymentRoutes from "./modules/payment/payment.routes";
import dashboardRoutes from "./modules/dashboard/dashboard.routes";

const api = Router();

// Public auth routes.
api.use("/auth", authRoutes);

// Cross-tenant admin routes: require auth + platform-admin (no tenant scoping).
api.use("/admin", authenticate, requirePlatformAdmin, adminRoutes);

// Everything below requires a valid token AND an active business (tenant).
api.use(authenticate, resolveTenant);
api.use("/business", businessRoutes);
api.use("/parties", partyRoutes);
api.use("/items", itemRoutes);
api.use("/invoices", invoiceRoutes);
api.use("/payments", paymentRoutes);
api.use("/dashboard", dashboardRoutes);

export default api;
