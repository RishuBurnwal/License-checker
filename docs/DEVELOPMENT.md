# Development Guide

## Environment Requirements

- Node.js `>=20.11.0`
- pnpm `>=11.7.0`
- Cloudflare Wrangler, managed by `worker/package.json`

Install dependencies:

```bash
pnpm install
```

## Local Configuration

The local Worker needs secrets from `worker/.dev.vars`. Generating random local secrets automatically is recommended:

```bash
pnpm env:init
```

To configure manually, copy from `worker/.dev.vars.example` and adjust as needed:

```bash
cp worker/.dev.vars.example worker/.dev.vars
```

Common variables:

- `JWT_SECRET`
- `CODE_HMAC_SECRET`
- `APP_SECRET_HMAC_SECRET`
- `DEVICE_HMAC_SECRET`
- `ADMIN_BOOTSTRAP_USERNAME`
- `ADMIN_BOOTSTRAP_PASSWORD`

At runtime the Worker validates that the core cryptographic secrets exist and do not use the example placeholders. `ADMIN_BOOTSTRAP_USERNAME` and `ADMIN_BOOTSTRAP_PASSWORD` must be configured as a pair; besides initial setup, `ADMIN_BOOTSTRAP_PASSWORD` is the recovery key when the local administrator password is forgotten.

`worker/.dev.vars` must not be committed.

The top-level `worker/wrangler.toml` configuration is for local development:

- The top-level `[vars]` provides the local `ADMIN_BOOTSTRAP_USERNAME`.
- The top-level `[[d1_databases]]` is used for the local D1 database, and its `database_id` may keep the placeholder value.
- Production configuration lives in the local private `worker/wrangler.production.toml`, which local development commands do not read.
- `worker/wrangler.production.example.toml` is the commit-able production configuration template; `worker/wrangler.production.toml` contains the real domain and production D1 and must not be committed.

## Local Database

D1 is SQLite. Running migrations locally creates a SQLite database file under `worker/.wrangler/state/`, and no Cloudflare account is required for local development.

Initialize the local D1 database:

```bash
pnpm db:migrate:local
```

Inspect the local SQLite data with Wrangler:

```bash
cd worker
pnpm exec wrangler d1 execute license_manager --local --command "SELECT code, name FROM plans"
```

## Local Startup

Start the Worker and the admin console:

```bash
pnpm dev
```

The root `pnpm dev` starts the Worker and the Vite dev server together. During development open `http://localhost:5173`; the frontend supports Vite hot reload and proxies `/api/*` requests to the local Worker at `http://localhost:8787`.

To verify Worker static asset hosting, first run `pnpm build` to produce `admin/dist`, then start the Worker alone:

```bash
pnpm --filter @license-manager/worker dev
```

To develop only the frontend, start Vite alone:

```bash
pnpm --filter @license-manager/admin dev
```

To develop only the Worker, start Wrangler alone:

```bash
pnpm --filter @license-manager/worker dev
```

## Common Commands

Root:

```bash
pnpm build
pnpm build:production
pnpm type-check
pnpm test
pnpm db:migrate:local
pnpm db:migrate:remote
pnpm env:init
pnpm env:check:production
```

Worker:

```bash
pnpm --filter @license-manager/worker build
pnpm --filter @license-manager/worker build:production
pnpm --filter @license-manager/worker type-check
pnpm --filter @license-manager/worker test
```

`pnpm db:migrate:remote`, `pnpm build:production`, and `pnpm deploy` use the Wrangler `production` environment.

Admin:

```bash
pnpm --filter @license-manager/admin build
pnpm --filter @license-manager/admin type-check
pnpm --filter @license-manager/admin test
```

## Verification Strategy

The goal of verification is not "the command passed" but proof that the contract of this change still holds. Run the smallest relevant set first, and widen to workspace-level verification only when shared types, the build chain, or deployment are involved.

Backend business or database access changes run at least:

```bash
pnpm --filter @license-manager/worker type-check
pnpm --filter @license-manager/worker test
```

Frontend changes run at least:

```bash
pnpm --filter @license-manager/admin type-check
pnpm --filter @license-manager/admin test
```

Cross-project, build, or deployment changes run:

```bash
pnpm type-check
pnpm test
pnpm build
```

Database migration changes should also apply migrations locally:

```bash
pnpm db:migrate:local
```

Documentation-only changes may skip tests but must state the reason in the commit or delivery notes.

### Test Responsibilities

| Test file | Main coverage | What to check when it changes |
| --- | --- | --- |
| `worker/test/config.test.ts` | Environment variable presence, placeholder values, and bootstrap pairing | New bindings, secrets, or environment validation |
| `worker/test/crypto.test.ts` | HMAC, activation code format, password hashing, JWT | Crypto format, secret purpose, or token behavior |
| `worker/test/time.test.ts` | Days, calendar months, calendar years, and expiry boundaries | Plan duration or timezone/expiry semantics |
| `worker/test/service.test.ts` | Business state transitions, error codes, logs, and sensitive fields | Activation, verification, unbind, app, and administrator rules |
| `worker/test/repository.test.ts` | SQL bindings, conditional updates, filtering, and aggregation | Schema, queries, pagination, concurrency preconditions |
| `admin/src/i18n/core.test.ts` | Language resolution and i18n core logic | Language policy or translation loading |
| `admin/src/shared/logMessage.test.ts` | Rendering stored log messages for display | Stored log message templates in `worker/src/service.ts` |
| `admin/src/shared/licenseDocs.test.ts` | Integration doc sample generation | Client API and documentation samples |
| `admin/src/shared/licenseSdks.test.ts` | SDK sample generation | SDK templates, endpoints, or parameters |

The root `pnpm test` runs the Worker Vitest suite and then the Admin `node:test` suite. The Admin `*.test.ts` files use `node:test` with Node's built-in TypeScript stripping and are excluded from the frontend `tsconfig`, so they are executed but not type-checked. When changing those modules, run `pnpm --filter @license-manager/admin test` explicitly and state this type-check gap in the delivery notes rather than treating `pnpm test` as full frontend coverage.

Tests for a behavior change cover at least:

- One success path.
- Directly related rejection paths and their stable error codes.
- State boundaries, such as the expiry instant, the count limit, and an empty binding.
- The concurrency/conditional-update result for any write that can overwrite another party's state.
- That sensitive fields never enter return values or logs.

Do not replace business assertions with broad snapshots, and never relax production rules just to make a test pass.

### Documentation-Only Verification

For a documentation-only change, confirm at least manually or by repository search:

- Every file path referenced by the document exists.
- Every listed script exists in `package.json`.
- API paths match `worker/src/routes.ts`.
- Statuses, actions, and error codes match `worker/src/constants.ts`.
- Tables, fields, and migrations match `migrations/`.

## Development Workflow

Before changing:

- Confirm the impact scope: backend, frontend, database, deployment, or documentation.
- Read the root `AGENTS.md` first, then the topic documents selected by task routing.
- Locate the topic's code source of truth; do not change endpoints or business rules from memory.
- Be careful with existing uncommitted changes and do not overwrite unrelated work.
- When documentation and implementation conflict, decide the intended behavior first and include resolving the conflict in the task scope.

While changing:

- Keep the change focused; do not perform unrelated refactors.
- Reuse existing types, functions, error codes, and response shapes first.
- When adding a business rule, consider logging, tests, and frontend display at the same time.
- When database fields are involved, update types, queries, migrations, and documentation together.
- When the API response shape changes, update frontend types and callers together.
- For state updates that need concurrency protection, put the preconditions into the repository SQL instead of only reading then writing in the service.

After changing:

- Run the verification commands that match the impact scope.
- Check cross-layer contracts and sensitive data against the definition of done in `AGENTS.md`.
- Summarize the change scope and verification results in the final notes.
- Explain why tests were not run when they were skipped.
