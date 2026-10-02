# Deployment Guide

This project ships a single Hono app (`worker/src/index.ts`) that runs on two
runtimes behind a `DbAdapter` boundary (`worker/src/db/`). Pick the target that
fits your hosting; the application code is identical across all of them.

| Target | Runtime | Database | Durability | When to use |
| --- | --- | --- | --- | --- |
| **Cloudflare Workers** (primary) | workerd (edge) | Cloudflare D1 | Durable, managed, global | Production. Lowest ops; serves the admin assets too. |
| **Vercel** (Node adapter) | Node 22 serverless function | `node:sqlite` file under `/tmp` | Ephemeral per instance | Demos / single-instance; point `SQLITE_PATH` at a volume for real use. |
| **Generic Node / VPS / Docker** | Node 22 (`entry-node.ts`) | `node:sqlite` file (`SQLITE_PATH`) | Durable if the file is on a persistent disk | Self-host on your own server/container. |

Honesty note: Vercel and generic Node are NOT the Cloudflare Workers runtime —
there is no workerd and no real D1. They run the same app on `node:sqlite`,
which is faithful at the SQL-engine level but does not reproduce Cloudflare
platform behaviour (D1 query limits/error codes, edge geography, replication).
See [ARCHITECTURE-phase2.md](ARCHITECTURE-phase2.md) for the adapter wiring.

Sections below:

1. [Cloudflare Workers (native, primary)](#1-cloudflare-workers-native-primary)
2. [Vercel (Node adapter)](#2-vercel-node-adapter)
3. [Generic Node / VPS / Docker](#3-generic-node--vps--docker)
4. [Ed25519 signing keys — generation & rotation](#4-ed25519-signing-keys--generation--rotation)
5. [Local-only verification (honesty constraint)](#5-local-only-verification-honesty-constraint)

---

## 1. Cloudflare Workers (native, primary)

The native target is Cloudflare Workers + D1 + Worker assets.

## About the Database

D1 is Cloudflare's managed SQLite. The schema, SQL dialect, and migration files in `migrations/` are plain SQLite, so the same migrations that run locally also run against the production D1 database. There is no separate production schema and no server to provision.

## Create the D1 Database

```bash
pnpm --filter @license-manager/worker db:create
```

Write the returned `database_id` into `[[env.production.d1_databases]]` in the local private production configuration `worker/wrangler.production.toml`.

The publicly committed `worker/wrangler.toml` is for local development only and may keep a placeholder value for the top-level `[[d1_databases]]`. Online deployment and remote migration read the production D1 binding from `env.production` in `worker/wrangler.production.toml`.

## Create the Private Production Configuration

Production configuration is not committed. Copy it from the example before the first deployment:

```bash
cp worker/wrangler.production.example.toml worker/wrangler.production.toml
```

Then adjust `worker/wrangler.production.toml` for the actual production environment.

## Set Production Variables

Confirm the production environment name, domain, variables, and D1 in `worker/wrangler.production.toml`:

```toml
[env.production]
name = "license-manager"
workers_dev = false
preview_urls = true
routes = [
  { pattern = "license.example.com", zone_name = "example.com", custom_domain = true, enabled = true, previews_enabled = false }
]

[env.production.vars]
ADMIN_BOOTSTRAP_USERNAME = "admin"

[[env.production.d1_databases]]
binding = "DB"
database_name = "license_manager"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = "../migrations"
```

`pnpm deploy` deploys the production environment through `--config wrangler.production.toml --env production`. Setting `[env.production].name` explicitly keeps the online Worker named `license-manager` and avoids Wrangler defaulting to `license-manager-production`.

The production custom domain is also managed by `worker/wrangler.production.toml`. Do not maintain Worker routes only in the Cloudflare dashboard; otherwise the next Wrangler deployment reports that local and remote configuration differ and may overwrite the remote routes with the local configuration.

## Set Production Secrets

```bash
cd worker
pnpm wrangler secret put JWT_SECRET --config wrangler.production.toml --env production
pnpm wrangler secret put CODE_HMAC_SECRET --config wrangler.production.toml --env production
pnpm wrangler secret put APP_SECRET_HMAC_SECRET --config wrangler.production.toml --env production
pnpm wrangler secret put DEVICE_HMAC_SECRET --config wrangler.production.toml --env production
pnpm wrangler secret put ADMIN_BOOTSTRAP_PASSWORD --config wrangler.production.toml --env production
pnpm wrangler secret put LICENSE_SIGNING_PRIVATE_KEY --config wrangler.production.toml --env production
pnpm wrangler secret put LICENSE_SIGNING_KEY_ID --config wrangler.production.toml --env production
```

Production should also confirm:

- `ADMIN_BOOTSTRAP_USERNAME`
- `LICENSE_SIGNING_PUBLIC_KEY` (and any previous-key variables) in `[env.production.vars]` — not secret, so they need not be set with `wrangler secret put`

`ADMIN_BOOTSTRAP_PASSWORD` doubles as the recovery key when the administrator password is forgotten. Production must set it to a high-strength random value managed only through a Wrangler secret.

To check that the production secret names are complete (this command reads secret names only and never prints secret values):

```bash
pnpm env:check:production
```

Ed25519 signing keys for `/api/v1/license/*` are covered in
[section 4](#4-ed25519-signing-keys--generation--rotation). For Cloudflare, the
private key + `key_id` are Wrangler secrets and the public key goes in
`[env.production.vars]`.

## Run Remote Migrations

```bash
pnpm db:migrate:remote
```

This command applies the production D1 migrations through `--config wrangler.production.toml --env production`.

Because D1 is SQLite, a schema change shipped as a new file in `migrations/` is applied the same way here as it is locally. `0004_localize_seed_data.sql` additionally localizes the seeded plan names to English while preserving any values an operator has already customized.

## Build and Deploy

```bash
pnpm deploy
```

The root `pnpm deploy` runs `pnpm build:production` first, then deploys the Worker with `wrangler deploy --config wrangler.production.toml --env production`.

## Pre-Deployment Checklist

- `worker/wrangler.production.toml` exists and will not be committed.
- `[[env.production.d1_databases]]` in `worker/wrangler.production.toml` has the production D1 `database_id`.
- `[env.production].name` in `worker/wrangler.production.toml` is set to the production Worker name `license-manager`.
- `[env.production].routes` in `worker/wrangler.production.toml` includes the production custom domain.
- `[env.production.vars]` in `worker/wrangler.production.toml` has the production bootstrap username.
- Production secrets are set through `wrangler secret put --config wrangler.production.toml --env production`.
- `pnpm env:check:production` confirms the production secret names are complete.
- `ADMIN_BOOTSTRAP_PASSWORD` is stored as a high-strength private recovery key.
- `LICENSE_SIGNING_PRIVATE_KEY` and `LICENSE_SIGNING_KEY_ID` are set as secrets; `LICENSE_SIGNING_PUBLIC_KEY` is configured and distributed to clients.
- Remote migrations have been applied.
- The frontend build output can be hosted by Worker assets.
- Production does not use a weak default bootstrap password.

## Post-Deployment Checklist

- `/api/health` returns normally.
- The admin console loads.
- An administrator can log in.
- Creating an app shows `app_secret` exactly once.
- Generating activation codes shows plaintext `codes` exactly once.
- The client activate, verify, and unbind endpoints respond as expected.

---

## 2. Vercel (Node adapter)

Vercel runs the SAME Hono app on a Node serverless function via the adapter in
`api/[[...route]].ts`, which reuses `worker/src/entry-node.ts` (`buildEnv` +
`applyMigrations`). The committed `vercel.json` wires it up:

- `buildCommand`: `pnpm --filter @license-manager/admin build`
- `outputDirectory`: `admin/dist` (static admin console)
- function `api/[[...route]].ts` on `nodejs22.x`
- rewrite `/api/(.*)` → `/api/[[...route]]`

Honest caveats before you choose this target:

- It is NOT the Cloudflare Workers runtime and NOT D1. It runs `node:sqlite`.
- Vercel's serverless filesystem is read-only except `/tmp`, and `/tmp` is
  per-instance and ephemeral. The default SQLite file (`/tmp/license-manager.sqlite`)
  is therefore NOT durable shared state across instances or cold starts.
- For anything beyond a demo / single warm instance, set `SQLITE_PATH` to a
  persistent volume, or front the app with a networked database. The Cloudflare
  Worker + D1 remains the durable production target.
- `node:sqlite` requires Node 22 (`nodejs22.x`), already pinned in `vercel.json`.

Deploy:

```bash
npm i -g vercel          # if the Vercel CLI is not installed
vercel login
vercel link              # link the repo to a Vercel project (first time)

# Set the same secrets the app validates (config.ts). Values are read from
# process.env by entry-node.ts buildEnv(). Add to Production (and Preview):
vercel env add JWT_SECRET production
vercel env add CODE_HMAC_SECRET production
vercel env add APP_SECRET_HMAC_SECRET production
vercel env add DEVICE_HMAC_SECRET production
vercel env add ADMIN_BOOTSTRAP_USERNAME production
vercel env add ADMIN_BOOTSTRAP_PASSWORD production
vercel env add LICENSE_SIGNING_PRIVATE_KEY production
vercel env add LICENSE_SIGNING_PUBLIC_KEY production
vercel env add LICENSE_SIGNING_KEY_ID production
# Optional: a persistent SQLite path instead of ephemeral /tmp
vercel env add SQLITE_PATH production

vercel deploy --prod
```

Migrations run automatically on cold start: `applyMigrations()` applies every
`migrations/*.sql` in filename order against the opened SQLite file. There is no
separate remote-migration step for this target.

After deploy, run the Post-Deployment Checklist above against the Vercel URL.

## 3. Generic Node / VPS / Docker

For self-hosting on your own server or a container, run the Node entry point
directly. It serves both the API and the admin assets from `admin/dist`.

Prerequisites: Node 22 (`node:sqlite`), the repo installed and built.

```bash
pnpm install
pnpm --filter @license-manager/admin build   # produces admin/dist (served by the Node host)
```

Provide the secrets as environment variables (same names as above), then start
the server. `entry-node.ts` boots when run directly and listens on `PORT`
(default `8787`):

```bash
export JWT_SECRET=... CODE_HMAC_SECRET=... APP_SECRET_HMAC_SECRET=... DEVICE_HMAC_SECRET=...
export ADMIN_BOOTSTRAP_USERNAME=admin ADMIN_BOOTSTRAP_PASSWORD=...
export LICENSE_SIGNING_PRIVATE_KEY=... LICENSE_SIGNING_PUBLIC_KEY=... LICENSE_SIGNING_KEY_ID=...
export SQLITE_PATH=/var/lib/license-manager/license-manager.sqlite   # persistent disk
export PORT=8787

pnpm --filter @license-manager/worker node:serve
```

`node:serve` runs `node --experimental-transform-types --experimental-sqlite
--import ./scripts/ts-resolve-loader.mjs src/entry-node.ts`. For a long-running
service, wrap it in a process manager (systemd, pm2) and keep `SQLITE_PATH` on a
persistent, backed-up disk.

### Docker

A minimal image (Node 22 base, build the admin console, run the Node entry):

```dockerfile
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @license-manager/admin build
ENV PORT=8787
ENV SQLITE_PATH=/data/license-manager.sqlite
VOLUME ["/data"]
EXPOSE 8787
CMD ["pnpm", "--filter", "@license-manager/worker", "node:serve"]
```

```bash
docker build -t license-manager .
docker run -p 8787:8787 \
  -e JWT_SECRET=... -e CODE_HMAC_SECRET=... -e APP_SECRET_HMAC_SECRET=... -e DEVICE_HMAC_SECRET=... \
  -e ADMIN_BOOTSTRAP_USERNAME=admin -e ADMIN_BOOTSTRAP_PASSWORD=... \
  -e LICENSE_SIGNING_PRIVATE_KEY=... -e LICENSE_SIGNING_PUBLIC_KEY=... -e LICENSE_SIGNING_KEY_ID=... \
  -v license-manager-data:/data \
  license-manager
```

Mount `/data` on a persistent volume so the SQLite file survives restarts.
Migrations apply automatically on boot (`applyMigrations`).

## 4. Ed25519 Signing Keys — Generation & Rotation

The `/api/v1/license/*` surface signs responses with an Ed25519 key. The private
key is a 48-byte PKCS8 key (base64url), the public key is 32 bytes raw
(base64url), and the `key_id` is stamped into every signed payload.
`worker/src/config.ts` validates presence, placeholder, base64url decoding, and
the exact 48-byte PKCS8 length on the first `/api/v1/*` request. See
[SECURITY.md](SECURITY.md#signed-license-threat-model) for the trust model.

### Dev

`pnpm env:init` (`scripts/init-dev-env.mjs`) generates a dev Ed25519 keypair and
writes `LICENSE_SIGNING_PRIVATE_KEY`, `LICENSE_SIGNING_PUBLIC_KEY`, and
`LICENSE_SIGNING_KEY_ID` into the uncommitted `worker/.dev.vars`. (The
`worker/.dev.vars.example` template does NOT include signing keys, so use
`pnpm env:init` rather than copying the example for the signed surface.)

### Production

Generate a fresh keypair. The script prints to stdout only and never writes the
private key to a file:

```bash
node scripts/gen-signing-key.mjs
```

Then provision per target:

- **Cloudflare**: `LICENSE_SIGNING_PRIVATE_KEY` + `LICENSE_SIGNING_KEY_ID` via
  `wrangler secret put` (see section 1); `LICENSE_SIGNING_PUBLIC_KEY` in
  `[env.production.vars]`.
- **Vercel / Node / Docker**: all three as environment variables.

Distribute the PUBLIC key and its `key_id` to clients — the license-checker's
`license-checker/src/config/publicKeys.ts` map. Clients never receive the
private key.

### Key Rotation Runbook

1. Generate a new keypair with `node scripts/gen-signing-key.mjs` (new `key_id`).
2. Add the new public key + `key_id` to the client public-key map alongside the current one, and release clients so they accept both.
3. Move the current key to the previous-key variables: set `LICENSE_SIGNING_PREVIOUS_PUBLIC_KEY` and `LICENSE_SIGNING_PREVIOUS_KEY_ID` to the outgoing values (these are validated together by `config.ts`).
4. Set `LICENSE_SIGNING_PRIVATE_KEY`, `LICENSE_SIGNING_KEY_ID`, and `LICENSE_SIGNING_PUBLIC_KEY` to the new key. New responses now sign with the new key; clients still trust the previous `key_id`.
5. Once all clients have the new key and no response still references the old `key_id`, drop the previous-key variables and remove the retired `key_id` from the client map.

If a private key is compromised, rotate immediately (steps 1, 3, 4) and remove the compromised `key_id` from clients as soon as they are updated.

## Build the License Checker

The standalone license-checker package is built separately when a checker build
is needed; it holds public keys only.

```bash
pnpm --filter @license-manager/license-checker build
```

## 5. Local-Only Verification (Honesty Constraint)

Verification for this project runs LOCALLY only. No step here deploys to a real
Cloudflare or Vercel account; `pnpm deploy`, `vercel deploy`, and
`pnpm db:migrate:remote` are operator actions.

Verify locally before an operator deploys:

```bash
pnpm type-check     # worker + admin (run the checker separately if changed)
pnpm test           # worker + admin suites
pnpm build          # admin + worker (regenerates admin/dist)

# Full live HTTP end-to-end: boots a real local Worker (wrangler dev + local D1),
# exercises admin login + forced-password-change, user create + kick, signed
# verify + every tamper case, /report + corroborated auto-hold, and a
# checker-equivalent run, then stops the server.
pnpm e2e            # node scripts/e2e-serve.mjs
# or, against an already-running server:
#   node scripts/e2e-live.mjs   [baseUrl]
#   node scripts/e2e-signed.mjs [baseUrl] [publicKeyB64Url] [keyId]
# (the launcher's `python main.py --build` runs build + type-check + all unit/integration suites)
