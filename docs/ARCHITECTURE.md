# Architecture

License Manager is a monolithic application deployed on Cloudflare Workers. The Worker serves both the `/api/*` JSON API and the `admin/dist` admin console static assets; Cloudflare D1 is the only persistent store. D1 is SQLite: the same SQL, schema, and migration files run locally against a SQLite file and in production against D1.

This document defines only system boundaries, layering, and dependency rules. Business conditions are in [Business Rules](BUSINESS_RULES.md), the HTTP contract is in [API Specification](API.md), and data structures are in [Database Specification](DATABASE.md).

## System Boundary

```text
Admin browser                         Client application
      |                                      |
      | Bearer JWT                           | app_id + app_secret
      v                                      v
┌────────────────────────────────────────────────────────┐
│ Cloudflare Worker                                      │
│  /api/* -> Hono routes -> service -> repository -> D1 │
│  other paths ---------------------------> static assets │
└────────────────────────────────────────────────────────┘
```

- The admin console and the API are deployed on the same origin; non-`/api/*` requests fall back to Worker assets.
- The admin side uses admin JWT; clients use an application ID and application secret, and the two authentication paths are not shared.
- Business data is written only to D1. Activation code authentication values, application secrets, and device fingerprints are stored as irreversible HMACs, and activation codes additionally keep a non-authentication suffix.
- The deployment model is single D1, single Worker, one global dataset. Applications own their activation codes, batches, and logs directly.

## Top-Level Structure

```text
.
├── admin/        # React + Vite admin console
├── docs/         # Current specifications and design records
├── migrations/   # Cloudflare D1 migrations
├── scripts/      # Environment initialization and production checks
├── worker/       # Cloudflare Workers + Hono API
└── pnpm-workspace.yaml
```

## Worker Layering

```text
index.ts
  -> routes.ts
       -> service.ts
            -> repository.ts
                 -> D1
```

| Module | Responsibility | Must not carry |
| --- | --- | --- |
| `index.ts` | Mounting `/api`, global error conversion, API 404, static asset fallback | Business rules and SQL |
| `routes.ts` | Routing, JSON/path/query parameter reading, basic type and range validation, response assembly | State transitions and cross-table business logic |
| `service.ts` | Business invariants, state transitions, authenticated domain operations, cross-repository coordination, business logging | Raw HTTP parsing and inline SQL |
| `repository.ts` | Prepared SQL, database reads and writes, atomic conditional updates, query result mapping | Product decisions and HTTP responses |
| `constants.ts` | Runtime statuses, actions, error codes, and derived types | Mutable configuration and display copy |
| `crypto.ts` | Random values, HMAC, password hashing, JWT, constant-time comparison | Business flows |
| `http.ts` | JSON reading, generic parameter validation, success/failure envelopes | Domain validation |
| `middleware.ts` | Admin Bearer Token validation, management-role checks, principal injection | Admin business operations |
| `time.ts` | ISO time, calendar month/year arithmetic, expiry and remaining time | Plan selection logic |
| `types.ts` | Worker bindings, database rows, response and error types | Duplicated runtime enums |

Dependency constraints:

- Normal business calls stay `route -> service -> repository`.
- Read-only aggregate queries with no business decisions may call the repository directly from a route, for example the dashboard and list queries.
- The repository may use database constraints and conditional updates to guarantee atomicity, but must not define product rules itself.
- The service throws `ApiError`, which `index.ts` converts centrally. No layer may return a raw exception or SQL error as an API response.
- Reuse `crypto.ts` for all cryptography and `time.ts` for all time arithmetic; do not copy algorithms into routes or the repository.

## Admin Layering

```text
App.tsx
  -> Shell.tsx + routes.tsx
       -> pages/*
            -> hooks/* / shared/* / api.ts
```

| Module | Responsibility |
| --- | --- |
| `admin/src/App.tsx` | Providers, login state, current admin loading, login/admin entry points |
| `admin/src/routes.tsx` | Page keys, URLs, menu tree, lazy-loaded components |
| `admin/src/components/Shell.tsx` | Admin layout, navigation, user menu, page container |
| `admin/src/components/` | Login and cross-page interaction components |
| `admin/src/pages/` | Page-level tables, forms, modals, and request coordination |
| `admin/src/hooks/` | Data-loading logic reused across pages |
| `admin/src/shared/` | Display helpers, parameters, docs/SDK content, and shared types |
| `admin/src/api.ts` | API requests, Bearer token, query parameters, and 401 cleanup |
| `admin/src/types.ts` | API types consumed by the admin console |
| `admin/src/i18n/` | All visible copy and language state (English only) |

The frontend must not bypass `api.ts` to send requests directly, and must not copy backend status strings on its own. Detailed page and UI conventions are in [Frontend Specification](FRONTEND.md).

## Request Lifecycle

Admin write request:

```text
request
  -> env validation
  -> Bearer middleware
  -> route input validation
  -> service business validation
  -> repository conditional write
  -> audit log when the action is auditable
  -> { ok: true, data }
```

- Admin business endpoints operate on a single global dataset; there is no per-request data-partition context.
- The middleware re-reads the admin principal (including `user_role` and `session_epoch`) on every request, so an existing JWT stops working once the account is removed or kicked.
- Admin login locates the account by its globally unique username, verifies the password, and issues a JWT.

Client licensing request:

```text
request
  -> env validation
  -> validate app_id and app status
  -> HMAC and compare app_secret
  -> HMAC code and device fingerprint
  -> evaluate code business state
  -> conditional state update when needed
  -> success/failure audit log after code lookup
  -> stable JSON response
```

When authentication fails, or the request fails before an activation code is found, the request must not leak or persist sensitive plaintext for the sake of logging.

## Consistency and Concurrency

- D1 is not assumed to be a long-transaction business engine. Critical races are handled with preconditioned updates, such as "activate only when unused" and "bind only when unbound".
- A failed conditional update means another request already changed the state; the service returns a stable `CONFLICT` and must not overwrite the new state.
- Re-activating the same device is an idempotent success. Whether repeated deletion or repeated status updates succeed follows the relevant repository condition and the API contract.
- Bulk operations may partially match and return both the requested and actually updated counts; the log for an individual ID is written only after a real update.
- The ordering between a one-time plaintext response and the database write must be explicit, so the API never reports success when persistence failed.

## Cross-Layer Change Rules

| Change | At minimum involves |
| --- | --- |
| New business action | Constants, service, repository, logging, tests, business docs; add routes/API when exposed over HTTP |
| New response field | Worker return types, frontend types and callers, API docs |
| New persisted field | Migration, Worker row types, repository queries/writes, tests, database docs |
| New admin page | Page, routes, menu/i18n, required API types, frontend docs |
| New error code | Worker constants, throw sites, frontend handling or display, tests, API docs |
| New secret or authentication method | Bindings/config, crypto/middleware, example environment, deployment, security and API docs |

Any cross-layer change should expand outward from the domain rule; it must not patch only the final page or a single SQL query.
