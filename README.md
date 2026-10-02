# License Manager

A lightweight, self-hostable software licensing system for independent software, desktop tools, plugins, scripts, and internal systems. It covers the full workflow from application onboarding and batch issuance to device activation, verification, controlled transfer, and audit trails.

The backend and database run on Cloudflare Workers and D1. APIs are built with Hono, and the admin console is built with React, Vite, and Ant Design Pro. The Worker serves both the backend API and the admin static assets, so the system can be deployed to the Cloudflare edge with low operational overhead.

The same Hono app also runs on a second runtime through a database-adapter boundary: a Node entry point (`worker/src/entry-node.ts`) backed by `node:sqlite` powers the Vercel and generic Node/VPS/Docker targets, with Cloudflare Workers + D1 remaining the primary, durable deployment. See the [deployment guide](docs/DEPLOYMENT.md) for all targets and [docs/ARCHITECTURE-phase2.md](docs/ARCHITECTURE-phase2.md) for the structure.

## Business Highlights

- **License time starts when the customer starts using it:** Weekly, monthly, quarterly, and yearly licenses begin at first activation, so generating or distributing keys early does not consume the customer's license period.
- **One key per device without making device changes painful:** Activation is device-bound and idempotent on the same device. Users can self-unbind within transfer and cooldown limits, while administrators can handle eligible exceptions.
- **Simple administration from one deployment:** A single global dataset keeps operations straightforward; access is gated by the `admin`/`staff` management role.
- **Minimize stored credential exposure:** Full license keys and application secrets are shown only once, device fingerprints are never persisted, and long-term storage contains only HMAC values or key suffixes.
- **Observe and audit the licensing lifecycle:** The dashboard surfaces license inventory, activation trends, and client failures. Searchable logs cover important admin actions and client authorization outcomes, while soft deletion preserves history.
- **Move from API exploration to integration in one console:** Built-in API docs, workflow guidance, copyable examples, multi-framework SDK/component samples, and a live API Playground shorten the path from application creation to client integration.

## Use Cases

- Issue license keys for one or more applications.
- Separate licenses by platform, such as Windows, macOS, Linux, iOS, Android, or Web.
- Let clients activate and verify licenses with `app_id`, `app_secret`, a license key, and a device fingerprint.
- Enforce one license per device while allowing controlled self-service device transfers.
- Manage license states, filters, disable/enable/delete actions, and audit logs from an admin console.
- Use dashboard metrics, audit logs, and stable failure codes to understand license usage and troubleshoot client issues.
- Self-host the licensing service without retaining full plaintext license keys, application secrets, or device fingerprints.

## Feature Overview

### Administration

- Applications, generation batches, license keys, and logs form a single global dataset; every account sees the same data.
- Administrators have login, 8-hour JWT sessions, password changes, and bootstrap-key password recovery.

### Admin and Staff User Management

- The sole role axis is `user_role` (`admin` or `staff`). Any `admin` can create users, reset passwords, change a user's role (`admin`/`staff`), and review a user's sessions. `staff` users are blocked from the Users area server-side, not merely hidden in the UI.
- New users and administrative password resets require a forced password change on next login: a protected request returns `PASSWORD_CHANGE_REQUIRED` until the user changes their password.
- Session kick-out is stateless and immediate. Each JWT carries a `session_epoch`; kicking a user (or resetting their password) increments the epoch, so every token issued before the kick is rejected with `401` on the next request. No server-side token store is needed.

### Application Licensing

- Multi-application and multi-platform license management.
- Applications support descriptions and purchase links, and can be enabled, disabled, conditionally deleted, or have their secrets rotated.
- Disabling an application immediately blocks its client authorization operations while preserving the original state of its license keys.
- Application secrets are shown only once on creation or rotation; the database stores only HMAC hashes.

### License Keys

- Batch license key generation with server-side generation limits.
- Built-in weekly, monthly, quarterly, and yearly plans.
- Plaintext license keys are shown only once in the generation response; full plaintext keys are never stored.
- Filter by status, application, platform, plan, keyword, and other conditions.
- Disable, enable, or soft delete individual keys or batches; bulk operations report both requested and updated counts.
- Deleted state takes precedence over disabled, expired, and active display states, keeping the lifecycle explicit and irreversible.

### Activation, Verification, and Device Transfer

- Expiration time is calculated from first activation, not from generation time.
- Weekly plans use 7 days; monthly, quarterly, and yearly plans use calendar months or years.
- One license key is bound to one device by default, and verification requires a matching device fingerprint.
- Re-activating the same license key on the same device returns the current license information.
- Supports up to 3 self-service unbind transfers, with at least 24 hours between valid unbinds.
- Unbinding releases only the device relationship and never recalculates activation or expiration; the new device rebinds through the activation endpoint.
- Admins can manually unbind eligible activated licenses without consuming the user's self-service transfer allowance.

### Operations, Audit, and Developer Support

- The dashboard shows application and license totals, activation rate, status and plan distributions, 7-day license trends, application ranking, and client failure counts.
- Operation logs can be searched by application, action, result, and keyword, covering important admin actions plus activation, verification, and unbind outcomes once a license key is identified.
- Integration docs include client API references, workflow diagrams, TypeScript/JavaScript SDKs, cURL examples, and an HTML demo.
- The SDK page provides React, Vue, React Native, Angular, Svelte, Electron, Flutter/Dart, and TypeScript Core samples.
- The Playground previews requests and calls the real client APIs for activation, verification, and unbind testing.

### Signed License Verification

- `POST /api/v1/license/verify` returns an Ed25519-signed payload so an untrusted client can validate the license offline and detect any tampering of fields like status, expiry, or server time.
- `POST /api/v1/license/report` lets a client report an anomaly; corroborated reports can auto-hold a license.
- Admins can hold/approve a license, change its validity or activation limit, and review activation slots and security events.
- The standalone `license-checker/` package exercises this surface end to end (add multiple licenses, verify with the embedded public key, tamper demo, and report), holding public keys only.
- See [docs/CLIENT_INTEGRATION.md](docs/CLIENT_INTEGRATION.md) for the full client contract.

### Security and Audit

- `/api/admin/*` endpoints require Bearer Token authentication except login.
- Client APIs validate both `app_id` and `app_secret`.
- License keys, application secrets, and device fingerprints are stored using separate HMAC secrets.
- APIs use a unified response shape and do not expose SQL errors, raw exceptions, or secret-related details.
- License key deletion is soft deletion, preserving auditability and historical records.

## Logging In

The admin console has no tenant field and no customer login — only operators (admin/staff) sign in. The login form has a **Log in as** dropdown:

| Login as | Fields required | Who it is for |
| --- | --- | --- |
| **Admin** | Username + Password + **Master Password** | `admin` accounts (`user_role = admin`) |
| **User** | Username + Password | `staff` accounts (`user_role = staff`) |

How it works:

- The **global master password** is a second factor for admin accounts only. The server decides whether the master password is required purely from the stored account role — the dropdown is a UI hint, never trusted as an auth signal. A wrong/missing master password, a staff account picking "Admin", or an admin picking "User" all return the same generic `401 Invalid username or password` (no account enumeration), and admin login is fail-closed if no master password is configured.
- There is **one** master password for the whole system, stored only as a PBKDF2 hash + salt in the `settings` table. Its initial value comes from the `ADMIN_MASTER_PASSWORD` secret; change it later from **Settings** in the console.
- **Forced password change:** a newly created user, or any user whose password an admin reset, must set a new password on first login before any other action is allowed. The change screen states clearly which account's login password is being changed — it is the account password, not the master password.
- **Local dev defaults:** username `admin`, password `admin`, master password `master` (forced change on first login). These are dev-only conveniences, not production credentials. Reset them any time with `python main.py --reset-admin`.

## Console Guide (Every Sidebar Item)

The admin console sidebar is grouped as it is defined in `admin/src/routes.tsx`. The **System** group (Users, Settings) is visible only to `admin` accounts; `staff` never see it and the server denies them regardless.

### Dashboard

- **What:** the landing page with license and application metrics.
- **Why:** a single at-a-glance view of real usage and client health.
- **Shows (all computed live from the database, never mocked):** application and license totals, activation rate, status and plan distributions, a 7-day license trend, application ranking, and client failure counts. A fresh install shows zeros until you create apps and keys.

### License group

**Apps** — manage the applications you issue licenses for.

- **Why:** every license key belongs to one application; the client authenticates with that application's `app_id` + `app_secret`.
- **What you can do:** create an app (its `app_secret` is shown **once** — copy it then), set an optional description and `purchase_url` (must be http/https), enable or disable it (disabling immediately blocks that app's client calls with `APP_DISABLED` while leaving its keys intact), rotate the secret (old one stops working, new one shown once), and delete it (blocked while it still has batches, codes, or logs).

**Activation Codes** — the list of issued license keys and the main management surface.

- **Why:** this is where you see and control the lifecycle of every key.
- **Statuses:** `unused` (generated, never activated), `active` (bound to a device, within expiry), `disabled` (admin-blocked, re-enablable), `hold` (flagged, blocks authorization until approved), `deleted` (soft-deleted, terminal); plus a display-only `expired` state derived from the expiry date.
- **Filters:** by status, application, platform, plan, and keyword.
- **Per-key actions:** disable / enable, **hold / approve**, **extend or reduce validity** (change `expires_at`), **change the activation limit** (`max_activations`), open the **license detail drawer** (shows the installations/activation slots in use and the key's security-event history), and **soft delete**. Bulk actions report both the requested and the updated count. Full plaintext keys are never stored, so they are never shown again here — only a suffix.

**Generate Codes** — batch-create new license keys.

- **Why:** issue keys in bulk for an application.
- **What you set:** the application, the plan (`weekly` / `monthly` / `quarterly` / `yearly`), and the quantity (server-side batch limit applies). The response lists the **plaintext keys once** — copy or export them immediately, because only an HMAC + suffix is stored afterward. Expiry is **not** consumed yet; it starts at first activation.

### Audit group

**Operation Logs** — searchable audit trail.

- **Why:** understand what happened and troubleshoot client issues.
- **Covers:** important admin actions, plus client activation / verification / unbind outcomes once a key is identified. Searchable by application, action, result, and keyword. Stored log messages map to readable, translated text in the console.

**Live Sessions** — active client sessions.

- **Why:** see who is currently using a license and cut off a session if needed.
- **What you can do:** view active sessions (application, code suffix, device state, lease expiry) and **kick** one — the next client call for that session fails with `403 SESSION_REVOKED`.

### Developer Support group

**Integration Docs** — client API reference, workflow diagrams, and ready-to-use code templates (TypeScript/JavaScript SDK, cURL, and an HTML page). The example `app_id` and URLs shown here are generic developer placeholders, not real records.

**SDK** — framework samples (React, Vue, React Native, Angular, Svelte, Electron, Flutter/Dart, TypeScript Core) you can copy into a client project.

**Playground** — fills a request form and calls the **real** client APIs (activate / verify / unbind / heartbeat / renew) against your running server, so you can exercise a key interactively. Fields start empty; you supply the `app_id`, `app_secret`, key, and device fingerprint.

### System group (admin only)

**Users** — manage operator accounts.

- **Why:** control who can run the console and at what level.
- **What you can do:** create users as `admin` or `staff`; **set a user's password directly** (with a "require change on next login" toggle, on by default); **generate a cryptographically random password** (shown **once** with a copy button, then applied); change a user's role; review and **kick** a user's sessions (which also invalidates all their existing tokens). `staff` cannot open this page and the server rejects the Users API for them.

**Settings** — change the **global master password** (enter the current master password and the new one). This is separate from any account password.

## License Lifecycle: Create → Generate → Manage

A complete walkthrough from zero to a managed, verifiable license.

### 1. Create an application

Go to **Apps → Create**. Give it a name (and optional description / purchase URL). On creation the **`app_secret` is shown once** — copy it and store it securely. You now have an `app_id` (public) and an `app_secret` (secret, stored only as an HMAC).

### 2. Generate license keys

Go to **Generate Codes**, pick the application, the **plan** (`weekly` 7 days / `monthly` ~1 month / `quarterly` ~3 months / `yearly` ~1 year), and a quantity. The response shows the **plaintext keys once** — export them now. The keys are `unused` and have **no expiry yet**: the clock starts at first activation, so issuing keys early never wastes a customer's time.

### 3. Distribute a key

Give one key to a customer along with your server's base URL. A customer never logs in — they only need the key (and the client needs the app's `app_id` + `app_secret`, embedded in your client build).

### 4. Activate and verify (signed)

The client calls `POST /api/v1/license/verify` with:

```json
{
  "app_id": "<your app_id>",
  "app_secret": "<your app_secret>",
  "license_key": "<the customer's key>",
  "product_id": "<your app_id>",
  "installation_id": "<stable per-install id>",
  "protocol_version": 1
}
```

- The **first successful verify activates an unused key** on that installation and starts its expiry — no separate activation step is needed.
- The server returns an **Ed25519-signed payload** (status, plan, `expires_at`, `server_time`, `installation_id`, `key_id`, etc.) plus a signature. The client verifies the signature with the **embedded public key**, so any tampering with status, expiry, or time is detected and rejected offline.
- **Hands-on tool:** the standalone **License Checker** (`license-checker/`, dev port `5176`). Add a license by entering the **server URL** (e.g. `http://localhost:8787`), the **`app_id`**, the **`app_secret`**, and the **key**; click **Check** to see the live signed status and details, and use its tamper demo to confirm a modified payload is rejected. It holds only the public key and can never forge a signature.

### 5. Manage the license over its life

From **Activation Codes** (per key):

| You do | Client sees on next verify |
| --- | --- |
| Disable | `suspended` — not authorized |
| Enable | back to `active` |
| **Hold** | `hold` — not authorized, until an admin approves |
| **Approve** (release hold) | back to `active` |
| **Extend / reduce validity** | the new `expires_at` in the signed payload |
| **Change activation limit** | additional installations allowed up to the new limit; over-limit installs are refused |
| Soft delete | `revoked` — terminal |

- **Activation limit:** `max_activations` controls how many installations one key may run on; a key beyond its limit is refused for the new installation without consuming a slot, and an installation that already holds a slot always re-verifies.
- **Auto-hold / reporting:** a client can call `POST /api/v1/license/report` to flag an anomaly (e.g. a failed signature check). Corroborated reports can automatically put a key on **hold** for an admin to review.
- The **license detail drawer** shows the installations currently using a key and its security-event history; **Operation Logs** and **Live Sessions** give the broader audit and real-time view.

## Tech Stack

| Area | Technology |
| --- | --- |
| Backend | Cloudflare Workers, Hono, TypeScript |
| Database | Cloudflare D1, SQL migrations |
| Admin console | React, Vite, Ant Design Pro |
| Package management | pnpm workspace |
| Deployment | Cloudflare Workers + D1 (primary); Vercel / Node / Docker via the Node adapter |
| Database adapter | `node:sqlite` (`NodeSqliteAdapter`) for the Node/Vercel runtime |
| Testing | Vitest, node:test |

## Project Structure

```text
.
├── admin/           # React + Vite + Ant Design Pro admin console
├── license-checker/ # Standalone React + Vite license-checker (public keys only)
├── api/             # Vercel Node-adapter entry (reuses worker/src/entry-node.ts)
├── docs/            # Architecture, API, business rules, security, deployment docs
├── migrations/      # SQLite migrations (D1 locally/remotely; node:sqlite on Node)
├── scripts/         # Node tooling (keygen, env init, live E2E orchestrator)
├── worker/          # Hono app: Cloudflare Worker (index.ts) + Node entry (entry-node.ts)
│   └── src/db/      # DbAdapter boundary: D1Adapter + NodeSqliteAdapter
├── vercel.json      # Vercel build + function config
├── AGENTS.md        # Coding agent development rules
└── pnpm-workspace.yaml
```

Request flow:

```text
Browser/Admin
  -> Cloudflare Worker
  -> Hono routes
  -> service business rules
  -> repository D1 queries
  -> unified JSON response
```

Non-`/api/*` requests fall back to admin static assets served by Worker assets.

## Local Development

Requirements:

- Node.js `>=20.11.0`
- pnpm `>=11.7.0`
- Cloudflare Wrangler, managed by `worker/package.json`

Install dependencies and prepare local secrets:

```bash
pnpm install
pnpm env:init
```

Initialize local D1 and start the development environment:

```bash
pnpm db:migrate:local
pnpm dev
```

Open the admin console at `http://localhost:5173`. Vite provides hot reload, and API requests are proxied to the local Worker.

The local Worker listens on `http://localhost:8787` by default. To verify Worker static asset hosting, run `pnpm build` first, then start the Worker separately.

The default bootstrap admin is controlled by `worker/.dev.vars` and `worker/wrangler.toml`:

- `ADMIN_BOOTSTRAP_USERNAME`
- `ADMIN_BOOTSTRAP_PASSWORD`

If the admin account does not exist on first login, the Worker creates it automatically.

Local development reads the public top-level configuration in `worker/wrangler.toml`. Production deployment reads the uncommitted `worker/wrangler.production.toml` and manages secrets with `wrangler secret put --config wrangler.production.toml --env production`.

## One-Click Launcher

`main.py` manages the whole project. It needs only Python 3 and Node/pnpm on the machine. Run it with no argument for a numbered menu, or pass a flag:

```bash
python main.py                # Menu: 1) Run  2) Build  3) Update  4) Exit
python main.py --run          # 1) Start Worker API + admin console + license checker, open the browser
python main.py --build        # 2) Install, build, type-check and test every package once
python main.py --update       # 3) Pull the latest code from YOUR Git URL, then reinstall + rebuild
python main.py --reset-admin  # Reset the local login to admin / admin (forced change on login)
```

| Option | Steps | Result |
|---|---|---|
| Run | free stale ports → install if needed → `.dev.vars` → migrate → first-run admin login → start all three dev servers → wait until each URL answers | Admin console `:5175`, license checker `:5176`, API `:8787`, printed with both `localhost` and this machine's LAN IP |
| Build | force install → migrate → build admin + worker + checker → type-check all → run all test suites | Exits non-zero on the first failure |
| Update | add a dedicated `launcher-update` remote for your URL → fetch → fast-forward only → reinstall + rebuild | Refuses (and changes nothing) if you have local edits or diverged history |

First login on a fresh setup: username `admin`, password `admin`; you must set a new password before anything else. The launcher sets this up once (recorded in the uncommitted `launcher.config.json`) and never touches your password again unless you run `--reset-admin`.

The update URL is never hardcoded: set `update_url` in `launcher.config.json` or the `LICENSE_MANAGER_UPDATE_URL` environment variable, or enter it when option 3 asks (it is then saved).

Every child process runs with `WRANGLER_HIDE_BANNER=true` and `WRANGLER_SEND_METRICS=false`. Without that, wrangler's npm update check can hold a socket open on networks where `registry.npmjs.org` is slow or unreachable, so `db:migrate:local` and `build` print their result but never exit. Finite steps also have timeouts, so a stuck command fails with a clear message instead of hanging.

For the full live HTTP end-to-end suite (boots its own Worker, runs 46 checks, stops it) use `pnpm e2e`.

## Common Commands

```bash
pnpm dev               # Start Worker and admin console together
pnpm env:init          # Generate local Worker secrets
pnpm env:check:production # Check production secret names
pnpm build             # Build admin console and Worker
pnpm type-check        # Run backend and frontend type checks
pnpm test              # Run Worker and admin tests
pnpm e2e               # Boot a local Worker, run the full live E2E, then stop it
pnpm db:migrate:local  # Apply local D1 migrations
pnpm db:migrate:remote # Apply production D1 migrations
pnpm deploy            # Build and deploy the production Worker
```

## Verification

```bash
pnpm build
pnpm type-check
pnpm test
```

Documentation-only changes usually do not require tests. Code, API, database, or deployment changes should run the relevant verification commands for their impact area.

## Deployment

The primary deployment target is Cloudflare Workers + D1 + Worker assets. The same app also runs on Vercel and on a generic Node/VPS/Docker host through the Node adapter (`node:sqlite`); the [deployment guide](docs/DEPLOYMENT.md) has copy-pasteable commands for every target plus Ed25519 key generation and rotation.

The Cloudflare flow, before the first deployment:

1. Create the production D1 database.
2. Copy `worker/wrangler.production.example.toml` to the local private `worker/wrangler.production.toml`.
3. Fill in the Worker name, custom domain, production D1 `database_id`, and bootstrap username in the production config.
4. Use Wrangler secrets to set `JWT_SECRET`, `CODE_HMAC_SECRET`, `APP_SECRET_HMAC_SECRET`, `DEVICE_HMAC_SECRET`, `ADMIN_BOOTSTRAP_PASSWORD`, and the signing key (`LICENSE_SIGNING_PRIVATE_KEY`, `LICENSE_SIGNING_KEY_ID`); see the [deployment guide](docs/DEPLOYMENT.md#signing-keys-for-the-signed-license-surface).
5. Check production secret names.
6. Apply remote D1 migrations.
7. Build and deploy.

```bash
pnpm env:check:production
pnpm db:migrate:remote
pnpm deploy
```

Production D1, production domain, and bootstrap username are configured in `env.production` inside the local private `worker/wrangler.production.toml`. See the [deployment guide](docs/DEPLOYMENT.md) for details.

After deployment, check:

- `/api/health` returns successfully.
- The admin console loads and login works.
- `app_secret` is shown only once after application creation.
- Plaintext `codes` are shown only once after license key generation.
- Client activation, verification, and unbind APIs return as expected.

## Open Source and Security

- This project is released into the public domain under [The Unlicense](LICENSE) — free for anyone to use, modify, and distribute for any purpose, with no conditions.
- See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.
- See [SECURITY.md](SECURITY.md) for vulnerability reporting.
- Do not commit `worker/.dev.vars`, `worker/wrangler.production.toml`, real secrets, production D1 IDs, or build artifacts.
- Copy `worker/wrangler.production.example.toml` to the uncommitted `worker/wrangler.production.toml` before filling in real production values.

## Verification Status

All features are verified against real SQLite and the real `app.fetch()` HTTP surface, and a real local server (booted with `wrangler dev`) is additionally exercised over real HTTP by `scripts/e2e-serve.mjs`. **345 automated tests** cover the system (278 backend + 33 admin + 34 license-checker); all pass:

| Suite | Tests | What It Verifies |
|---|---|---|
| Database | 30 | Schema, migrations, CAS guarantees, global mutations/listing, dashboard aggregation |
| API | 45 | Routing, auth, validation, CRUD, conflicts, password management |
| Security | 27 | Crypto primitives, secret storage, injection resistance, token handling |
| Concurrency | 13 | Compare-and-set activation/bind/unbind, idempotent disable, batch uniqueness |
| License Matrix | 30 | All 14 Prompt.md §47 scenarios (implemented, mapped, or honestly absent) |
| Failure | 25 | DB unavailable, malformed requests, invalid tokens, type coercion, rate limits |
| E2E | 1 | Full lifecycle: login → app → codes → activate → heartbeat → kick → renew → revoke |
| Session/Renewal | 3 | Session lease, heartbeat refresh, renewal extension |
| Signed license (service + integration) | 37 | Canonical determinism, Ed25519 sign/verify, per-field tamper, activation slots, auto-hold, admin powers |
| License signing (unit) | 32 | Canonical byte order, fail-closed guard, sign/verify round-trip, derived status, env validation |
| Service, crypto, time, config, repository | 24 | Unit-level guarantees for each module |
| User management | 7 | Create user, forced-password reset, role gate (staff denied), epoch kick-out |
| Node adapter (parity) | 3 | Signed verify + tamper, activation-limit atomicity, create→kick→401 on `NodeSqliteAdapter` |
| Frontend (admin) | 33 | i18n, documentation demos, SDK templates, log message mapping, signed status/label helpers, Users menu gate |
| License-checker | 34 | Cross-impl canonical bytes, base64url round-trip, signature + tamper + unknown-key rejection, freshness predicate, no private key |

### Live end-to-end verification

`pnpm e2e` (`node scripts/e2e-serve.mjs`) boots a real local Worker (`wrangler dev` + local D1), exercises the whole system over real HTTP, then stops the server. It currently reports **46/46 checks passing** across three stages:

- **Live stage (20):** health, admin login, super-admin creates a user with a forced password change, the new user's login reports the forced change, a protected route is blocked with `403 PASSWORD_CHANGE_REQUIRED` until the password is changed, the user is kicked and the pre-kick token is rejected `401`, then app/code creation, activation returning a session token, heartbeat, admin session listing + kick (`403 SESSION_REVOKED`), reactivation, renewal extending the expiry, grace-period reporting, and second-device refusal.
- **Signed stage (14):** Ed25519 smoke test, signed verify happy path, local signature verification, per-field tamper rejection (all 12 canonical fields), garbage-signature rejection, unknown-protocol rejection, embedded `key_id` lookup, `/report` with corroborated auto-hold (first report records without holding, a second distinct installation triggers the hold), and the signed status reflecting the hold.
- **Checker-equivalent stage (12):** reproduces the standalone checker's path — verify request, trust only the embedded `key_id`, verify the signature with the embedded public key, field checks, local tamper detection, and reporting the anomaly.

The individual scripts also run against an already-running server: `node scripts/e2e-live.mjs` and `node scripts/e2e-signed.mjs [baseUrl] [publicKeyB64Url] [keyId]`.

### Session, heartbeat, kick, renewal, and grace period

These five capabilities are fully implemented, not placeholders:

| Capability | Endpoint | Behaviour |
|---|---|---|
| Session | issued by `POST /api/client/activate` and `renew` | Opaque session token bound to code + device; repeated activates reuse one session row |
| Heartbeat | `POST /api/client/heartbeat` | Extends the lease by the plan's grace window; records a log entry |
| Session list | `GET /api/admin/sessions` | Active sessions with app, code suffix, device state, and lease expiry |
| Kick | `POST /api/admin/sessions/:id/kick` | Marks the session `kicked`; the next client call fails with `403 SESSION_REVOKED` |
| Renewal | `POST /api/client/renew` | Extends from the later of the current expiry and now, using the plan duration |
| Grace period | `plans.grace_period_seconds` | Lease/offline window returned to the client on activate, heartbeat, and renew |

Concurrent-session limits come from `plans.session_limit` and are enforced atomically in SQL. Offline enforcement is client-side after the server supplies the authoritative lease and grace window; the server cannot authorise a client it cannot reach.

**Not implemented by design:** IP-based restrictions. There is no IP column and IP is never used as device identity.

See `worker/test/license-matrix.test.ts`, `worker/test/session-renewal.test.ts`, and `worker/test/failure.test.ts` for evidence.

## Complete Settings Guide

### Environment Variables (`worker/.dev.vars` or Wrangler Secrets)

| Variable | Purpose | Required | Notes |
|---|---|---|---|
| `JWT_SECRET` | Signs admin JWT tokens | Yes | Min 32 chars; reject placeholder values |
| `CODE_HMAC_SECRET` | HMAC key for activation code hashes | Yes | Separate from other secrets to prevent cross-domain replay |
| `APP_SECRET_HMAC_SECRET` | HMAC key for app secret hashes | Yes | App secrets stored as HMAC only |
| `DEVICE_HMAC_SECRET` | HMAC key for device fingerprints | Yes | Device fingerprints never stored in plaintext |
| `ADMIN_BOOTSTRAP_USERNAME` | Initial admin username | Yes | Created on first login if missing |
| `ADMIN_BOOTSTRAP_PASSWORD` | Initial admin password | Yes | Rejects `change-me-before-use` placeholder |
| `ADMIN_MASTER_PASSWORD` | Seeds the global master password required for admin login | Yes (for admin login) | Hashed into the `settings` table on first use; rejects the `replace-with-a-master-password` placeholder; change later from the Settings page |
| `LICENSE_SIGNING_PRIVATE_KEY` | Ed25519 private key that signs `/api/v1/license/verify` responses | Yes | Base64url PKCS8; never returned by any API or logged |
| `LICENSE_SIGNING_KEY_ID` | Identifier (`key_id`) stamped into signed payloads | Yes | Lets clients support key rotation |

### Application Settings

| Setting | Effect |
|---|---|
| `platform` | Informational label (desktop/web/mobile/cli); no enforcement logic |
| `purchase_url` | Optional; must be http/https; shown in admin UI |
| `status: active` | Client activation/verification works |
| `status: disabled` | Client APIs return `APP_DISABLED`; existing licenses preserved |
| `app_secret` | Shown **once** at creation/rotation; only HMAC hash stored |
| Delete | Blocked if app has activation batches, codes, or logs |

### License Plan Settings

| Plan Code | Duration | Behavior |
|---|---|---|
| `weekly` | 7 days | Expiry = activation + 7 days |
| `monthly` | 30 days | Expiry = activation + 30 days |
| `quarterly` | 90 days | Expiry = activation + 90 days |
| `yearly` | 365 days | Expiry = activation + 365 days |

Duration starts at **first activation**, not generation. Unused codes never expire.

### Activation Code Lifecycle

| State | Meaning | Transitions To |
|---|---|---|
| `unused` | Generated but never activated | `active` (on first activation) |
| `active` | Bound to a device, within expiry | `disabled`, `deleted`, or expired |
| `disabled` | Admin-disabled; soft state | `active` (re-enable), `deleted` |
| `deleted` | Soft-deleted; irreversible | Terminal state |
| Expired | Derived: `active` + past `expires_at` | Display-only; no state change |

### Device Binding & Transfer

| Parameter | Value | Effect |
|---|---|---|
| Max rebinds | 3 | Self-service unbind limit per code |
| Cooldown | 24 hours | Minimum time between valid unbinds |
| Admin unbind | Unlimited | Does not consume user's rebind budget |
| Same-device reactivation | Idempotent | Returns current license; no state change |

### Batch Generation Limits

| Parameter | Value |
|---|---|
| Max quantity per batch | 300 |
| Collision retry limit | `quantity * 4 + 20` attempts |
| Bulk action ID limit | 100 IDs per request |

### Pagination Defaults

| Parameter | Default | Max |
|---|---|---|
| `page` | 1 | — |
| `page_size` | 20 | 100 |

## Documentation

More detailed design, API, and maintenance rules are split into topic documents:

- [Documentation index](docs/README.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Architecture — Phase 2 (signed license, user management, dual deployment)](docs/ARCHITECTURE-phase2.md)
- [Business rules](docs/BUSINESS_RULES.md)
- [Frontend rules](docs/FRONTEND.md)
- [API reference](docs/API.md)
- [Client integration (signed license)](docs/CLIENT_INTEGRATION.md)
- [Security rules](docs/SECURITY.md)
- [Database rules](docs/DATABASE.md)
- [Deployment guide](docs/DEPLOYMENT.md)
