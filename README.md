# Laxora Billing — Backend API

A multi-tenant billing/invoicing SaaS backend (Vyapar-style) built with
**Node.js + Express + TypeScript + Prisma**, backed by **Neon (serverless
PostgreSQL)** and deployed to **Google Cloud Run**.

This API powers:
- 🔐 Auth & multi-tenant businesses (one user can own multiple businesses)
- 👥 Parties (customers & suppliers)
- 📦 Items / inventory (with stock tracking)
- 🧾 Invoices (sales & purchases, auto-numbered, GST/tax, auto stock adjustment)
- 💰 Payments (with automatic invoice paid/partial/unpaid status)
- 📊 Dashboard summary (sales, receivables, low-stock, counts)

---

## 1. Architecture at a glance

```
[ Vercel ]                         [ Google Cloud Run ]        [ Neon ]
 Frontend (Next.js)  --HTTPS-->     This API (Docker)   --SSL-->  PostgreSQL
 Admin panel (Next.js)
```

- **Why Cloud Run?** Scales to zero (you pay nothing when idle), one-command
  deploys, free HTTPS URL — perfect for an early-stage SaaS.
- **Why Neon?** Serverless Postgres that also scales to zero, connects over a
  plain connection string (no Cloud SQL proxy needed), generous free tier.

---

## 2. Tech stack

| Concern        | Choice                          |
| -------------- | ------------------------------- |
| Language       | TypeScript (Node 20+)           |
| Web framework  | Express 4                       |
| ORM            | Prisma 5                        |
| Database       | Neon (PostgreSQL)               |
| Auth           | JWT (Bearer tokens)             |
| Validation     | Zod                             |
| Security       | helmet, CORS                    |
| Container      | Docker (multi-stage)            |
| Hosting        | Google Cloud Run                |

---

## 3. Run it locally (5 steps)

> Prerequisites: Node.js 20+ and a free Neon account (https://neon.tech).

### Step 1 — Install dependencies
```bash
npm install
```

### Step 2 — Create your Neon database
1. Go to https://neon.tech and create a project (pick a region close to you).
2. In the Neon dashboard open **Connection Details**.
3. Copy **two** connection strings:
   - The **pooled** one (host contains `-pooler`) → use as `DATABASE_URL`.
   - The **direct** one (no `-pooler`) → use as `DIRECT_URL` (for migrations).

### Step 3 — Configure environment
```bash
cp .env.example .env
```
Edit `.env` and paste your Neon strings. Generate a JWT secret with:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Step 4 — Create the database tables
```bash
npx prisma migrate dev --name init
npm run seed   # optional: creates demo@laxora.app / demo1234 with sample data
```

### Step 5 — Start the dev server
```bash
npm run dev
```
API is now at `http://localhost:8080`. Health check: `GET /health`.

Quick smoke test:
```bash
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@laxora.app","password":"demo1234"}'
```

---

## 4. Deploy to Google Cloud Run (step by step)

> Prerequisites: a Google Cloud account with billing enabled, and the
> `gcloud` CLI installed (https://cloud.google.com/sdk/docs/install).

### Step 1 — One-time gcloud setup
```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Enable the services we need
gcloud services enable run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com
```

### Step 2 — Run database migrations against Neon
Cloud Run is stateless, so run migrations from your machine (or CI) pointing at
your **production** Neon branch:
```bash
# Use your production Neon connection strings here
DATABASE_URL="<neon-pooled-url>" DIRECT_URL="<neon-direct-url>" \
  npx prisma migrate deploy
```

### Step 3 — Deploy the container (one command)
Cloud Run builds the Dockerfile for you with `--source .`:
```bash
gcloud run deploy laxora-billing-api \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-env-vars "NODE_ENV=production,JWT_SECRET=YOUR_SECRET,CORS_ORIGINS=https://your-frontend.vercel.app" \
  --set-env-vars "^@@^DATABASE_URL=<neon-pooled-url>@@DIRECT_URL=<neon-direct-url>"
```
Notes:
- `asia-south1` is Mumbai — pick the region nearest your users.
- The `^@@^` syntax lets the connection strings contain commas safely.
- For real apps, store secrets in **Secret Manager** instead of `--set-env-vars`
  (see Step 5).

When it finishes, gcloud prints a **Service URL** like
`https://laxora-billing-api-xxxx.a.run.app`. That's your API base URL — give it
to the frontend and admin apps.

### Step 4 — Verify
```bash
curl https://laxora-billing-api-xxxx.a.run.app/health
# -> {"status":"ok"}
```

### Step 5 (recommended) — Use Secret Manager for secrets
```bash
echo -n "<neon-pooled-url>" | gcloud secrets create DATABASE_URL --data-file=-
echo -n "<neon-direct-url>" | gcloud secrets create DIRECT_URL --data-file=-
echo -n "YOUR_SECRET"       | gcloud secrets create JWT_SECRET  --data-file=-

gcloud run deploy laxora-billing-api \
  --source . --region asia-south1 --allow-unauthenticated \
  --set-env-vars "NODE_ENV=production,CORS_ORIGINS=https://your-frontend.vercel.app" \
  --set-secrets "DATABASE_URL=DATABASE_URL:latest,DIRECT_URL=DIRECT_URL:latest,JWT_SECRET=JWT_SECRET:latest"
```

---

## 5. Environment variables

| Variable        | Required | Description                                              |
| --------------- | -------- | -------------------------------------------------------- |
| `PORT`          | no       | Defaults to 8080 (Cloud Run sets this automatically).    |
| `NODE_ENV`      | no       | `development` or `production`.                           |
| `DATABASE_URL`  | **yes**  | Neon **pooled** connection string (runtime).             |
| `DIRECT_URL`    | **yes**  | Neon **direct** connection string (migrations).          |
| `JWT_SECRET`    | **yes**  | Long random string for signing tokens.                   |
| `JWT_EXPIRES_IN`| no       | Token lifetime, e.g. `7d`.                               |
| `CORS_ORIGINS`  | no       | Comma-separated allowed frontend origins.                |

---

## 6. API reference

All responses are JSON. Authenticated routes require:
- Header `Authorization: Bearer <token>`
- Header `x-business-id: <businessId>` (optional — defaults to your first business)

### Auth (public)
| Method | Path                | Body                                            |
| ------ | ------------------- | ----------------------------------------------- |
| POST   | `/api/auth/register`| `{ name, email, password, businessName }`       |
| POST   | `/api/auth/login`   | `{ email, password }`                           |
| GET    | `/api/auth/me`      | — (returns user + their businesses)             |

### Business
| Method | Path            | Description                |
| ------ | --------------- | -------------------------- |
| GET    | `/api/business` | Active business profile    |
| PUT    | `/api/business` | Update profile (name, gstin, address, logoUrl…) |

### Parties (customers/suppliers)
| Method | Path                | Notes                                     |
| ------ | ------------------- | ----------------------------------------- |
| GET    | `/api/parties`      | `?type=CUSTOMER|SUPPLIER&search=`         |
| GET    | `/api/parties/:id`  |                                           |
| POST   | `/api/parties`      | `{ name, type, phone, email, gstin, ... }`|
| PUT    | `/api/parties/:id`  |                                           |
| DELETE | `/api/parties/:id`  |                                           |

### Items (inventory)
| Method | Path             | Notes                                                  |
| ------ | ---------------- | ------------------------------------------------------ |
| GET    | `/api/items`     | `?search=`                                             |
| GET    | `/api/items/:id` |                                                        |
| POST   | `/api/items`     | `{ name, salePrice, purchasePrice, taxRate, stockQty }`|
| PUT    | `/api/items/:id` |                                                        |
| DELETE | `/api/items/:id` |                                                        |

### Invoices
| Method | Path                | Notes                                              |
| ------ | ------------------- | -------------------------------------------------- |
| GET    | `/api/invoices`     | `?type=SALE|PURCHASE&partyId=&status=`             |
| GET    | `/api/invoices/:id` | Full invoice w/ line items + payments              |
| POST   | `/api/invoices`     | `{ partyId, type, items:[{description,quantity,rate,taxRate,itemId?}], discount, dueDate }` |
| DELETE | `/api/invoices/:id` | Restores stock                                     |

Totals (subtotal, tax, total) and the invoice number are computed server-side.
Creating a SALE reduces stock; a PURCHASE increases it.

### Payments
| Method | Path                | Notes                                                   |
| ------ | ------------------- | ------------------------------------------------------- |
| GET    | `/api/payments`     | `?partyId=&invoiceId=`                                  |
| POST   | `/api/payments`     | `{ partyId, amount, method, invoiceId? }` — updates invoice status |
| DELETE | `/api/payments/:id` |                                                         |

### Dashboard
| Method | Path                          | Description                       |
| ------ | ----------------------------- | --------------------------------- |
| GET    | `/api/dashboard/summary`      | Sales, purchases, receivables, counts, low-stock |
| GET    | `/api/dashboard/recent-invoices` | Last 10 invoices               |

---

## 7. Connecting the frontend (Vercel)

In your Next.js app on Vercel, set an env var:
```
NEXT_PUBLIC_API_URL=https://laxora-billing-api-xxxx.a.run.app
```
And make sure your Cloud Run service's `CORS_ORIGINS` includes your Vercel
domain(s).

---

## 8. Project structure

```
src/
├── config/env.ts          # env loading & validation
├── lib/prisma.ts          # shared Prisma client
├── middleware/            # auth, tenant, validation, errors
├── utils/                 # jwt, password, errors, asyncHandler
├── modules/
│   ├── auth/              # register, login, me
│   ├── business/          # business profile
│   ├── party/             # customers & suppliers
│   ├── item/              # products/services + stock
│   ├── invoice/           # sales & purchase invoices
│   ├── payment/           # payments + invoice status
│   └── dashboard/         # summary metrics
├── routes.ts              # API route aggregator
├── app.ts                 # Express app factory
└── index.ts               # server entry
prisma/
├── schema.prisma          # data model
└── seed.ts                # demo data
```

---

## 9. Roadmap (next phases)

- [ ] PDF invoice generation + email/WhatsApp share
- [ ] GST reports (GSTR-1/3B), profit & loss
- [ ] File uploads to GCS (logos, attachments)
- [ ] Role-based permissions (ADMIN/STAFF restrictions)
- [ ] Frontend (Next.js on Vercel) — Phase 3
- [ ] Admin panel — Phase 4
