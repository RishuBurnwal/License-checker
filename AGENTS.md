# Agent Development Rules

This file is the single entry point for coding agents. The goal is to let an agent make reliable changes with minimal context: classify the task first, then read only the necessary documents and implementation facts, and finally verify and synchronize documentation according to the impact scope.

## Execution Flow

Run every task in this order:

1. Check the workspace state and preserve uncommitted user changes.
2. Read the relevant topic documents from "Task Routing"; do not read everything by default.
3. Locate the code source of truth for that topic and confirm whether documentation and implementation agree.
4. List the impact surface: business, API, database, frontend, security, tests, deployment, and documentation.
5. Make the smallest complete change within the existing layering; do not refactor unrelated code along the way.
6. Run the commands in "Verification Matrix" and check that code, types, tests, and documentation are consistent.

If documentation and implementation conflict, do not silently pick one side. Decide from the user's goal whether to fix the documentation, fix the implementation, or adjust both, and state the conflict and its resolution in the delivery notes.

## Task Routing

| Change type | Required reading | Primary code source of truth |
| --- | --- | --- |
| Project structure, module responsibilities, cross-layer calls | `docs/ARCHITECTURE.md` | Actual directories and import relationships |
| Worker business rules, activation, verification, device transfer, deletion | `docs/BUSINESS_RULES.md` | `worker/src/service.ts`, related tests |
| API paths, parameters, responses, pagination, error codes | `docs/API.md` | `worker/src/routes.ts`, `worker/src/http.ts`, `worker/src/constants.ts` |
| Database fields, indexes, migrations, query results | `docs/DATABASE.md` | `migrations/`, `worker/src/repository.ts`, `worker/src/types.ts` |
| Authentication, secrets, HMAC, JWT, logging, sensitive data | `docs/SECURITY.md` | `worker/src/config.ts`, `crypto.ts`, `middleware.ts` |
| Frontend pages, interactions, styles, admin structure | `docs/FRONTEND.md` | `admin/src/routes.tsx`, `components/`, `pages/`, `api.ts` |
| Local commands, tests, development environment | `docs/DEVELOPMENT.md` | Root and sub-project `package.json` |
| Build, deploy, remote D1 migrations, Worker assets | `docs/DEPLOYMENT.md` | Wrangler configuration and deployment scripts |
| Documentation structure, open-source entry points, rule archival | `docs/README.md` | Root-level documents |

When a task spans multiple types, read only the relevant documents in combination. For example, adding an API field usually requires reading `API.md`; if the field is persisted, also read `DATABASE.md`; if it is displayed in the admin console, also read `FRONTEND.md`.

## Source-of-Truth Rules

- Product scope, status semantics, and business invariants are specified by `docs/BUSINESS_RULES.md`.
- HTTP routes and parameter reading are implemented in `worker/src/routes.ts` and must stay consistent with `docs/API.md`.
- The current database shape is the `migrations/` directory applied in order; do not infer schema from TypeScript types.
- Runtime enums and error codes are implemented in `worker/src/constants.ts`; equivalent frontend constants must be synchronized.
- Local and deployment commands are implemented in the `scripts` blocks of each `package.json`.
- Admin pages and menus are implemented in `admin/src/routes.tsx`.
- Security invariants outrank ordinary implementation convenience; when a conflict appears, stop widening the change and remove the risk first.

## Code Boundaries

- `worker/src/routes.ts`: HTTP routing, parameter reading, basic validation, and response assembly.
- `worker/src/service.ts`: business rules, status transitions, and cross-repository operations.
- `worker/src/repository.ts`: D1 SQL access; carries no business decisions.
- `worker/src/constants.ts`: runtime constants and derived types for worker statuses, actions, and error codes.
- `worker/src/crypto.ts`: hashing, HMAC, JWT, and random code generation.
- `worker/src/http.ts`: JSON reading, parameter validation, and success/failure response shapes.
- `worker/src/middleware.ts`: admin Bearer Token authentication.
- `worker/src/time.ts`: expiry checks and license duration arithmetic.
- `admin/src/App.tsx`: top-level providers, login state, and current admin loading.
- `admin/src/routes.tsx`: page registration, paths, and menu structure.
- `admin/src/components/`: admin shell, login page, and cross-page components.
- `admin/src/pages/`: business pages, one file per page.
- `admin/src/hooks/`: data-loading logic reused across pages.
- `admin/src/shared/`: display helpers, parameter handling, docs/SDK data, and shared types.
- `admin/src/shared/logMessage.ts`: renders stored log messages for display; must stay in sync with the messages the Worker writes.
- `admin/src/api.ts`: API request wrapper, token read/write, and query parameter handling.
- `admin/src/types.ts`: admin console API types.

The backend dependency direction stays `route -> service -> repository`. Routes must not implement business state transitions directly, and the repository must not make decisions based on business semantics.

## Change Impact Checklist

| What changed | What must be checked and synchronized |
| --- | --- |
| API request or response fields | Worker types, routes/service, `admin/src/types.ts`, callers, `docs/API.md` |
| Status, action, or error code enums | Worker constants and types, service/repository, frontend constants and display, tests, API/business docs |
| Database field or index | New migration, repository SQL, Worker types, tests, `docs/DATABASE.md` |
| Business state transition | service, repository atomic update conditions, logs, tests, `docs/BUSINESS_RULES.md` |
| New admin page | `admin/src/pages/`, `admin/src/routes.tsx`, i18n messages, required API types, `docs/FRONTEND.md` |
| Secret or authentication behavior | Config validation, crypto/middleware, log redaction, example environment, `docs/SECURITY.md` and deployment docs |
| Command or production configuration | `package.json`/Wrangler configuration, `docs/DEVELOPMENT.md`, `docs/DEPLOYMENT.md` |
| Stored log message format | `worker/src/service.ts` messages, `admin/src/shared/logMessage.ts` parsing, `admin/src/shared/logMessage.test.ts` |

## Modification Principles

- Keep changes focused; do not perform unrelated refactors.
- Do not overwrite uncommitted user changes; read and understand related changes before continuing.
- Reuse existing constants, types, response shapes, and component patterns.
- Keep SQL in `repository.ts` only, using prepared statements and `.bind(...)`.
- Route frontend API calls through `admin/src/api.ts` only.
- Put visible copy in `admin/src/i18n/`; do not scatter untranslatable text across new pages.
- Database schema changes must add a new `migrations/` file; never modify a published migration to express a production change.
- Behavior changes must add or update tests that prove the rule; do not test implementation details only.
- Do not copy the same specification into multiple documents; detailed rules belong to their topic document, and other files only link or summarize.

## Non-Negotiable Constraints

- Never store or log a full plaintext activation code.
- Never store or log plaintext app secrets or device fingerprints.
- Activation code expiry is calculated from the first activation time.
- Re-binding an unbound activation code must not recalculate the license start or end time.
- Activation code deletion uses soft deletion.
- Every `/api/admin/*` route except login must remain protected by Bearer Token authentication.
- Client-facing endpoints must validate `app_id` and `app_secret`.
- SQL must never concatenate user input.
- APIs must never return raw exceptions, SQL errors, or secret-related information.
- Never commit real secrets, `.dev.vars`, `wrangler.production.toml`, Wrangler local state, or build artifacts.

## Verification Matrix

Frontend logic or type changes:

```bash
pnpm --filter @license-manager/admin type-check
```

Frontend logic, shared helper, or test changes also run:

```bash
pnpm --filter @license-manager/admin test
```

Frontend build, routing, or static asset changes additionally run:

```bash
pnpm --filter @license-manager/admin build
```

Worker business, API, or database access changes:

```bash
pnpm --filter @license-manager/worker type-check
pnpm --filter @license-manager/worker test
```

Cross-project, build, or deployment changes:

```bash
pnpm type-check
pnpm test
pnpm build
```

Database migration changes additionally run:

```bash
pnpm db:migrate:local
```

Documentation-only changes may skip code tests, but must verify paths, commands, enums, and field names, and must state in the delivery notes why tests were not run.

## Definition of Done

- The behavior and boundaries requested by the user are implemented with no half-finished paths left behind.
- Code layering, types, API, database, and frontend calls do not contradict each other.
- Key success paths, rejection paths, and edge conditions have corresponding tests or explicit verification.
- Sensitive data has not entered logs, URLs, committed files, or long-term storage.
- The relevant topic documents are synchronized, and no second conflicting set of rules was created.
- The final summary includes the change scope, verification results, and any remaining risks.
