# CRM Service Requirements (for Platform Console Integration)

**Target repo:** https://github.com/SalehAlobaylan/CRM-Service

**Goal:** Refactor and scale the CRM service into a production-ready, API-first CRM backend that can be cleanly integrated into the existing **Platform Console** (admin dashboard) as a module, using HTTPS APIs and admin authentication.

---

## Implementation Status

| Module                     | Status         | Notes                                          |
| -------------------------- | -------------- | ---------------------------------------------- |
| Gin Framework              | ✅ Complete    | Replaced Gorilla Mux with Gin                  |
| PostgreSQL + GORM          | ✅ Complete    | Full persistence layer                         |
| JWT Auth (HS256 Verifier)  | ✅ Complete    | Middleware validates CMS-issued tokens         |
| RBAC (admin/manager/agent) | ✅ Complete    | Role-based access control                      |
| CORS Middleware            | ✅ Complete    | Configured for Vercel origins                  |
| Customers CRUD             | ✅ Complete    | With pagination, filtering, soft delete        |
| Contacts CRUD              | ✅ Complete    | Nested under customers, primary designation    |
| Deals CRUD                 | ✅ Complete    | Pipeline stages, transitions                   |
| Activities CRUD            | ✅ Complete    | Including `/admin/me/activities`               |
| Tags CRUD                  | ✅ Complete    | With customer assignment                       |
| Reports Overview           | ✅ Complete    | `/admin/reports/overview`                      |
| Health/Ready/Metrics       | ✅ Complete    | Prometheus metrics                             |
| Structured Logging         | ✅ Complete    | Zap JSON logs with request IDs                 |
| Docker + Compose           | ✅ Complete    | Multi-stage build, PostgreSQL                  |
| SQL Migrations             | ✅ Complete    | golang-migrate compatible                      |
| **Notes CRUD**             | ⚠️ Partial     | Model exists, **endpoints not implemented**    |
| **Audit Read Endpoint**    | ⚠️ Partial     | Logs written, **GET endpoint not implemented** |
| Attachments/File Upload    | ❌ Not Started | Optional for v1                                |

---

## Platform Console Context (must match)

### Console identity

- **Name:** Platform Console
- **Type:** Internal / Admin-only Web App (Control surface for platform + CRM operations).
- **Deployment:** Standalone Next.js app (Vercel) calling backend services over HTTPS.

### Services Console talks to

- **CMS (Platform):** Admin actions + observability via CMS APIs.
- **CRM Service:** CRM workflows and data via CRM APIs.

### Auth decision (MVP)

- **One shared login (SSO-like) with one JWT issuer**: Console authenticates once via **CMS** and uses the same token to call both CMS and CRM.
- **JWT transport:** `Authorization: Bearer <token>` header on every request.
- **JWT signing/verification:** **HS256** with a shared `JWT_SECRET` configured identically in CMS and CRM.
  - **CMS is the issuer** (creates tokens).
  - **CRM is verifier only** (validates token, enforces RBAC on `/admin/*`).

### Token storage (Console, MVP)

- Console stores token client-side (e.g., localStorage) and attaches Bearer token on every CMS/CRM request.
- Console must handle `401` by clearing token and redirecting to `/login`.

---

## Mandatory Implementation Stack (v1)

# CRM Service Requirements (Platform Console + Turfa Platform Alignment)

**Target repo:** https://github.com/SalehAlobaylan/CRM-Service

**Goal:** Refactor and scale the CRM Service into a production‑ready, API‑first backend that integrates cleanly with the **Platform Console** (admin dashboard) while honoring the wider Turfa system boundaries and auth model.

This document expands the CRM requirements using the broader platform context (CMS/Feed Service, Aggregation Service, Platform Console). The CRM Service is independent from the content pipeline and remains the canonical system of record for CRM data.

---

## 1) System context & boundaries (aligned with platform)

Turfa has three major runtime domains:

1. **CMS / Feed Service (Go)**
   - Serves public feeds and platform content APIs.
   - Issues admin JWTs for Platform Console (MVP).
2. **Aggregation Service (Node.js worker fleet)**
   - Ingests external sources, converts media, generates transcripts/embeddings.
3. **Platform Console (Next.js)**
   - Internal admin UI that calls CMS and CRM over HTTPS.

**CRM Service boundaries:**

- **Owns CRM data**: customers, contacts, deals, activities, notes, tags, and optional attachments/audit logs.
- **No content ingestion**: CRM does not scrape, process media, or assemble feeds.
- **Admin‑only API surface**: all CRM endpoints are under `/admin/*` with JWT auth + RBAC.

---

## 2) Implementation status

| Module                     | Status         | Notes                                          |
| -------------------------- | -------------- | ---------------------------------------------- |
| Gin Framework              | ✅ Complete    | Replaced Gorilla Mux with Gin                  |
| PostgreSQL + GORM          | ✅ Complete    | Full persistence layer                         |
| JWT Auth (HS256 Verifier)  | ✅ Complete    | Middleware validates CMS-issued tokens         |
| RBAC (admin/manager/agent) | ✅ Complete    | Role-based access control                      |
| CORS Middleware            | ✅ Complete    | Configured for Vercel origins                  |
| Customers CRUD             | ✅ Complete    | With pagination, filtering, soft delete        |
| Contacts CRUD              | ✅ Complete    | Nested under customers, primary designation    |
| Deals CRUD                 | ✅ Complete    | Pipeline stages, transitions                   |
| Activities CRUD            | ✅ Complete    | Including `/admin/me/activities`               |
| Tags CRUD                  | ✅ Complete    | With customer assignment                       |
| Reports Overview           | ✅ Complete    | `/admin/reports/overview`                      |
| Health/Ready/Metrics       | ✅ Complete    | Prometheus metrics                             |
| Structured Logging         | ✅ Complete    | Zap JSON logs with request IDs                 |
| Docker + Compose           | ✅ Complete    | Multi-stage build, PostgreSQL                  |
| SQL Migrations             | ✅ Complete    | golang-migrate compatible                      |
| **Notes CRUD**             | ⚠️ Partial     | Model exists, **endpoints not implemented**    |
| **Audit Read Endpoint**    | ⚠️ Partial     | Logs written, **GET endpoint not implemented** |
| Attachments/File Upload    | ❌ Not Started | Optional for v1                                |

---

## 3) Platform Console integration (must match)

### Console identity

- **Name:** Platform Console
- **Type:** Internal / Admin-only Web App (control surface for platform + CRM operations)
- **Deployment:** Standalone Next.js app (Vercel) calling backend services over HTTPS

### Services Console talks to

- **CMS (Platform):** Admin actions + observability via CMS APIs.
- **CRM Service:** CRM workflows and data via CRM APIs.

### Auth decision (MVP)

- **One shared login (SSO-like) with one JWT issuer**: Console authenticates once via **CMS** and uses the same token to call both CMS and CRM.
- **JWT transport:** `Authorization: Bearer <token>` header on every request.
- **JWT signing/verification:** **HS256** with a shared `JWT_SECRET` configured identically in CMS and CRM.
  - **CMS is the issuer** (creates tokens).
  - **CRM is verifier only** (validates token, enforces RBAC on `/admin/*`).

### Token storage (Console, MVP)

- Console stores token client-side (e.g., localStorage) and attaches Bearer token on every CMS/CRM request.
- Console must handle `401` by clearing token and redirecting to `/login`.

### Optional BFF (future)

An optional BFF can proxy CMS + CRM requests to reduce CORS complexity and keep tokens off the browser, but is not required for v1.

---

## 4) Goals, scope, and non-goals

### In scope for v1

1. **Admin auth verification** compatible with Platform Console auth model, with a dedicated `/admin` route group and RBAC.
2. **Core CRM modules**: Customers, Contacts, Deals, Activities/Tasks, Notes, Tags.
3. **Operational visibility** endpoints (list/detail with filtering + pagination).
4. **Minimum workflows**: assignment, stage transitions, follow-ups.
5. **Production readiness**: Postgres persistence, migrations, observability, CI checks.

### Out of scope for v1

- End-user/customer portal UI.
- Advanced marketing automation (drip campaigns), unless required by the main product.
- Multi-tenant SaaS billing and tenant provisioning (future).

---

## 5) Technology & packaging requirements

### Web framework

- **Gin** must be the HTTP framework.
- Use Gin route groups and middleware for:
  - `request_id`
  - structured logging
  - panic recovery
  - CORS
  - JWT auth verification on `/admin/*`

### ORM + database

- **PostgreSQL** is the system of record.
- **GORM** is used for persistence.
- Migrations must be included (choose one):
  - `golang-migrate/migrate` (recommended), or
  - GORM AutoMigrate only for local/dev (not for production).

### Packaging & deployment

- The service must be runnable via:
  - `docker build` + `docker run`
  - `docker compose up` (with Postgres)

---

## 6) Data model (high-level)

### Core entities

- **Customer**: identity fields, status, owner/assigned_to, soft delete, contact preferences, follow-up scheduling.
- **Contact**: belongs to a customer; supports primary designation.
- **Deal**: pipeline stage, amount, probability, expected close date, owner.
- **Activity**: tasks/meetings/calls/emails; scheduled vs completed; due dates.
- **Note**: attached to customers and/or deals; tracks author and timestamps.
- **Tag**: category labels; many-to-many assignment to customers.

### Supporting entities

- **AuditLog** (recommended): immutable record of changes, actor, resource, field diffs, timestamps.
- **Attachment** (optional v1): file metadata linked to customer/deal/activity, stored in S3-compatible storage.

---

## 7) Users, roles, and permissions (RBAC)

### Roles (initial)

- **Admin**: Full access; can manage configuration and pipelines.
- **Manager**: Can view team performance, reassign work, manage deals.
- **Agent/SalesRep**: Can manage assigned customers/deals/activities.

### Authorization requirements

- Every `/admin/*` request must include `Authorization: Bearer <token>`.
- CRM verifies JWT with HS256 using `JWT_SECRET` and rejects:
  - Missing/invalid token → `401`
  - Valid token but role not allowed → `403`
- RBAC must be consistent across all endpoints.
- Include explicit permission model for:
  - Read vs write
  - “Own records” vs “all records” (future-friendly)

---

## 8) API behavior & contracts

### Admin Auth (Verifier mode)

> **Important:** For MVP, CRM does NOT issue tokens; CMS issues tokens and CRM verifies them.

- **GET `/admin/me`** must return the current user identity + role/permissions derived from JWT claims.
- JWT must include at minimum:
  - `sub` (user id) OR `user_id`
  - `role` (admin/manager/agent)
  - `exp` (expiry)

### Error shape

- Stable error response shape across the API:
  - `{ code, message, data }`

### Pagination & filtering

- Default page size: 20 (configurable).
- Server-side filtering + sorting on list endpoints.
- Prefer cursor pagination for large lists (future).

---

## 9) Functional requirements by module

### Customers (Core)

- **Create**: validate email format and uniqueness.
- **List**: pagination + filters (status, assigned_to, tags, created range, search by name/email/company).
- **Detail**: return profile plus related entities summary (contacts, open deals, upcoming activities, recent timeline).
- **Update**: support PUT/PATCH; PATCH allows `status`, `assigned_to`, `contacted`, `next_follow_up_at`.
- **Soft delete**: recoverable deletion for data integrity.

### Contacts

- CRUD under a customer.
- Primary contact designation.

### Deals / Opportunities

- CRUD deals with pipeline stage, amount, probability, expected close date.
- Stages configurable by admins; stage transitions validated.
- List & filter by stage, owner, customer, date range, amount range.

### Activities / Tasks

- Track calls/emails/meetings/notes/tasks.
- Support scheduled vs completed.
- Provide “my tasks” endpoint for the current user.

### Notes & Comments

- Notes attached to customers and/or deals.
- Track author and timestamps.

### Tags & Categorization

- CRUD tags.
- Assign/unassign tags to customers.

### Attachments (optional v1, recommended)

- Upload attachments for customer/deal/activity.
- S3-compatible storage (MinIO/S3) + metadata in Postgres.

### Audit Logging (recommended)

- Record who changed what (resource, field diffs, timestamp).
- Expose read-only audit endpoints for admins.

### Reporting / Analytics (minimal v1)

- Count customers by status.
- Count deals by stage.
- Revenue totals for won deals (if tracked).

---

## 10) Required backend endpoints (Platform Console contract)

### Admin Auth (CRM = verifier)

- `GET /admin/me`

### Customers

- `GET /admin/customers` (filters + pagination)
- `POST /admin/customers`
- `GET /admin/customers/:id`
- `PUT /admin/customers/:id`
- `PATCH /admin/customers/:id`
- `DELETE /admin/customers/:id`

### Contacts

- `GET /admin/customers/:id/contacts`
- `POST /admin/customers/:id/contacts`
- `PUT /admin/contacts/:id`
- `DELETE /admin/contacts/:id`

### Deals

- `GET /admin/deals`
- `POST /admin/deals`
- `GET /admin/deals/:id`
- `PUT /admin/deals/:id`
- `PATCH /admin/deals/:id` (stage transitions)
- `DELETE /admin/deals/:id`

### Activities

- `GET /admin/activities` (filters + pagination)
- `POST /admin/activities`
- `GET /admin/activities/:id`
- `PUT /admin/activities/:id`
- `PATCH /admin/activities/:id` (status complete/cancel)
- `DELETE /admin/activities/:id`
- `GET /admin/me/activities` (my tasks)

### Tags

- `GET /admin/tags`
- `POST /admin/tags`
- `PUT /admin/tags/:id`
- `DELETE /admin/tags/:id`

### Reporting (minimal)

- `GET /admin/reports/overview`

### Health/metrics

- `GET /health`
- `GET /metrics`

---

## 11) Security & CORS (Vercel cross-origin)

### CORS requirements

Because Platform Console runs on Vercel (different origin), CRM must:

- Allow cross-origin requests from Console origin (production + staging + localhost).
- Allow the `Authorization` header.
- Allow methods: `GET, POST, PUT, PATCH, DELETE, OPTIONS`.
- Apply CORS primarily to `/admin/*` (and optionally all routes).

### 401/403 contract

- Missing/invalid token → `401` with stable error shape.
- Not allowed role → `403` with stable error shape.

---

## 12) Environment variables

### CRM (must match CMS)

- `JWT_SECRET` (HS256 shared secret used to verify tokens).
- `JWT_ISSUER` (optional, if you want to check issuer claim).
- `CORS_ALLOWED_ORIGINS` (comma-separated list; include Console’s Vercel domains).

### CRM (database)

- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `DB_SSLMODE` (e.g., `disable` for local compose)

### Platform Console

- `NEXT_PUBLIC_CMS_BASE_URL`
- `NEXT_PUBLIC_CRM_BASE_URL`

---

## 13) Docker requirements

### Deliverables

- A production-ready `Dockerfile` (multi-stage build recommended).
- A `docker-compose.yml` that runs:
  - `postgres` (required)
  - `crm-service` (this repo)
  - optional `migrate` job/container to apply DB migrations

### Dockerfile requirements

- Expose the CRM HTTP port (e.g., `3000`).
- Read all config via environment variables.
- Container should be stateless (no local JSON file DB).

### docker-compose requirements (local dev)

- Must include Postgres volume.
- Must set CRM env vars (`DB_*`, `JWT_SECRET`, `CORS_ALLOWED_ORIGINS`).
- Must support `docker compose up` bringing the full stack up.

---

## 14) Non-functional requirements

### Performance

- Default page size ~20.
- Server-side filtering/sorting.
- Prefer cursor pagination for large lists (future).

### Reliability

- Postgres as system of record (no JSON file DB).
- Background jobs for reminders (Redis queue) if needed.

### Observability

- Structured logs (JSON) with request IDs.
- Metrics endpoint for Prometheus.
- Tracing-ready middleware (optional).

---

## 15) Acceptance criteria (v1)

- Admin logs in once via CMS and Console can call both CMS and CRM using the same Bearer token.
- CRM rejects missing/invalid tokens with `401` and disallowed roles with `403` for `/admin/*`.
- Console handles `401` by clearing stored token and redirecting to `/login`.
- Admin can manage customers/deals/activities via Console against CRM APIs (pagination + filtering supported).
- CRM runs on Gin, persists to Postgres via GORM, and is runnable with Docker and docker-compose.
