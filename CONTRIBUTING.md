# Contributing Guide

Thanks for your interest in this project. Before submitting a change, confirm its impact scope and keep the change focused.

## Development Environment

- Node.js `>=20.11.0`
- pnpm `>=11.7.0`
- Cloudflare Wrangler, managed by `worker/package.json`

Initial setup:

```bash
pnpm install
cp worker/.dev.vars.example worker/.dev.vars
pnpm db:migrate:local
pnpm dev
```

The admin console runs at `http://localhost:5173`, and the Worker listens on `http://localhost:8787` by default.

## Pre-Submit Checks

Run the checks that match your change scope:

```bash
pnpm type-check
pnpm test
pnpm build
```

Documentation-only changes may skip tests, but state the reason in the commit message or pull request description.

## Code Conventions

- Backend business rules live in `worker/src/service.ts`.
- SQL access lives in `worker/src/repository.ts` and must use prepared statements with `.bind(...)`.
- Route all frontend API calls through `admin/src/api.ts`.
- Add new frontend pages under `admin/src/pages/` and register the page, path, and menu entry in `admin/src/routes.tsx`.
- When API response fields change, update backend types, frontend types, callers, and documentation together.
- Database schema changes must add a new `migrations/` file; never modify a published migration to express a production change.
- Visible copy belongs in `admin/src/i18n/`, which is English-only. Do not hardcode text in components.

Coding agents should read [AGENTS.md](AGENTS.md) first. The topic specification index is [docs/README.md](docs/README.md).

## Security Requirements

Do not commit:

- `worker/.dev.vars`
- `worker/wrangler.production.toml`
- Real secrets, production account passwords, JWT or HMAC secrets
- Production D1 `database_id`
- Wrangler local state, build artifacts, or logs

A public repository should contain only the local placeholder configuration in `worker/wrangler.toml` and the production template in `worker/wrangler.production.example.toml`.

## Vulnerability Reports

Do not disclose security vulnerabilities through public issues. See the root `SECURITY.md` for reporting instructions.
