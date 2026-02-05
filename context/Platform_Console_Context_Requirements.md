# Wahb — Platform Console Context & Requirements (Admin Dashboard + CRM Frontend)

This document defines the Platform Console: the internal admin UI that operates the Wahb platform and integrates with the CRM Service. It consolidates requirements from the platform, CMS, Aggregation, and CRM contexts.

## 1) Purpose & positioning

The Platform Console is the single internal admin interface for:

- Platform operations: content sources, ingestion monitoring, content status.
- CRM workflows: customers, contacts, deals, activities, notes, tags, and reports.

It is a standalone Next.js app (Vercel) that calls backend services over HTTPS. It is not user-facing and is admin-only.

## 2) System context & service boundaries

Wahb’s runtime domains:

- CMS / Feed Service (Go): serves public feeds and provides admin endpoints for platform operations.
- Aggregation Service (Node.js workers): ingests external sources and writes content back via CMS internal APIs.
- CRM Service (Go): canonical system of record for CRM data.

Console responsibilities:

- Operate content_sources and monitor content_items.status.
- Trigger ingestion via CMS admin APIs (not directly via worker queues in v1).
- Provide CRM workflows via CRM admin APIs.

## 3) Goals (v1)

- Single admin login (SSO-like) for platform + CRM.
- Source management (create/edit/enable/disable) and ingestion triggers.
- Content visibility with status, type, and artifact detail views.
- CRM operations across customers, contacts, deals, activities, notes, tags, and reports.

## 4) Non-goals (v1)

- End-user/customer portal.
- Advanced marketing automation and SaaS tenant billing/provisioning.
- Queue internals UI (BullMQ/Redis) and audit logging UI.

## 5) Architecture & integrations

### 5.1 Services Console talks to

CMS (Platform):

- Admin APIs under /admin/\* for content_sources CRUD.
- Trigger ingestion jobs (Run now).
- Browse and inspect content_items with filters.

CRM Service:

- Admin APIs under /admin/\* for customers, contacts, deals, activities, notes, tags, and reports.

### 5.2 Auth model (Console-wide)

- CMS issues JWTs (HS256) for admin login.
- Console uses the same token to call both CMS and CRM.
- CRM is verifier only and enforces RBAC based on token claims.
- Every request includes Authorization: Bearer <token>.

### 5.3 Token storage & session behavior

- Token stored client-side (localStorage recommended).
- On 401, clear token and redirect to /login.
- Console must handle 403 responses as permission denials.

### 5.4 Optional BFF

An optional BFF (Fastify) may proxy CMS + CRM requests to reduce CORS complexity and keep tokens off the browser. This is not required for v1.

## 6) Roles & permissions (RBAC)

Roles (initial):

- Admin: full access.
- Manager: manage teams and deal pipelines.
- Agent/SalesRep: manage assigned customers, deals, and activities.

Rules:

- Every /admin/\* request must include Authorization.
- Missing/invalid token → 401.
- Valid token but insufficient role → 403.

## 7) Platform module (CMS-backed)

### 7.1 Entities

content_sources

- Name, type, feed_url, api_config.
- is_active, fetch_interval_minutes, last_fetched_at.

content_items

- type: ARTICLE, VIDEO, TWEET, COMMENT, PODCAST.
- status: PENDING, PROCESSING, READY, FAILED, ARCHIVED.
- artifact URLs (media_url, thumbnail_url, original_url).
- transcript linkage and metadata JSONB.

### 7.2 Required UI workflows

- Sources list: filter by active/disabled, create/edit, enable/disable.
- Source detail: view config + last fetched time; run ingestion now.
- Content list: filter by status/type/source/date/search.
- Content detail: show artifacts, transcript snippet, metadata, and counts.

## 8) CRM module (CRM Service integration)

### 8.1 CRM scope (v1)

- Customers CRUD (pagination, filtering, soft delete).
- Contacts CRUD (nested under customers, primary designation).
- Deals CRUD (pipeline stages, transitions).
- Activities CRUD (including /admin/me/activities).
- Notes CRUD (model exists; endpoints partially implemented).
- Tags CRUD with assignment to customers.
- Reports overview (/admin/reports/overview).

### 8.2 CRM data expectations

- All CRM endpoints live under /admin/\*.
- CRM verifies CMS-issued JWT with JWT_SECRET.
- Stable error shape: { code, message, data }.

## 9) Console UI requirements (routes & modules)

Navigation modules:

- Platform: Sources, Content Items.
- CRM: Customers, Deals, Activities/Tasks, Tags, Reports.

Platform pages:

- /login
- /platform/sources
- /platform/sources/:id
- /platform/content
- /platform/content/:id

CRM pages:

- /crm/customers
- /crm/customers/new
- /crm/customers/:id (tabs: overview, contacts, deals, activities, notes, attachments if enabled)
- /crm/deals
- /crm/deals/:id
- /crm/activities
- /crm/my-tasks
- /crm/tags
- /crm/reports/overview

## 10) Security & CORS

Because Console is cross-origin (Vercel), CMS and CRM must:

- Allow Console origins (production + staging + localhost).
- Allow Authorization header.
- Allow methods: GET, POST, PUT, PATCH, DELETE, OPTIONS.

## 11) Environment variables

Console frontend:

- NEXT_PUBLIC_CMS_BASE_URL
- NEXT_PUBLIC_CRM_BASE_URL
- NEXT_PUBLIC_APP_ENV

Shared:

- JWT_SECRET must match across CMS and CRM for HS256 verification.

## 12) Acceptance criteria (v1)

- Admin can authenticate once and use the same token across CMS and CRM.
- Platform sources CRUD works, and Run now triggers ingestion.
- Platform content list and detail are filterable by status/type and show artifacts.
- CRM customers/deals/activities/tags/reporting are accessible with pagination and filtering.
- CRM denies missing/invalid tokens with 401 and disallowed roles with 403.
