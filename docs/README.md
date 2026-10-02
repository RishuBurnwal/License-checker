# Documentation Index

This directory holds the current specifications for the project. The root `AGENTS.md` is the entry point and execution checklist for coding agents; this directory answers the concrete rules for architecture, business, API, data, security, frontend, development, and deployment.

## Reading Principles

1. Read the root `AGENTS.md` first and pick documents according to task routing.
2. Read only the topic documents relevant to the change, then compare them against that topic's code source of truth.
3. Topic documents describe the intended contract; code and migrations describe the current implementation. When the two conflict, the difference must be resolved explicitly.
4. When behavior changes, update the matching topic document. Do not create a second set of rules inside commit messages, historical proposals, or code comments.

## Document Responsibilities

| Document | Question it answers | What it does not cover |
| --- | --- | --- |
| `ARCHITECTURE.md` | How the system is layered, how modules depend on each other, how a request flows | Concrete business conditions and complete API fields |
| `BUSINESS_RULES.md` | Product scope, domain terms, status semantics, activation/verification/unbind rules | HTTP parameters and SQL implementation |
| `API.md` | Paths, authentication, request/response, pagination, error codes | Page layout and database indexes |
| `DATABASE.md` | Table relationships, field invariants, derived status, migrations, and SQL rules | Product interactions and deployment steps |
| `SECURITY.md` | Sensitive data, secrets, authentication, logging, and production security boundaries | General business flows |
| `FRONTEND.md` | Page structure, routing, components, UI, i18n, and frontend security | Worker business implementation |
| `DEVELOPMENT.md` | Environment, commands, test strategy, and the development loop | Production release operations |
| `DEPLOYMENT.md` | Cloudflare, D1, Wrangler secrets, and release checks | Day-to-day coding standards |

Root-level general documents:

- `README.md`: project introduction, quick start, and deployment entry point.
- `CONTRIBUTING.md`: collaboration process for outside contributors.
- `SECURITY.md`: how to report vulnerabilities privately and what to do after a leak.
- `LICENSE`: open-source license.

## Recommended Reading Combinations

| Task | Document combination |
| --- | --- |
| Change activation, verification, or device transfer behavior | `BUSINESS_RULES.md` + `API.md`; add `DATABASE.md` when persisted, add `SECURITY.md` when secrets are involved |
| Add an admin console feature | `FRONTEND.md` + `API.md`; add `BUSINESS_RULES.md` when new business rules appear |
| Add a field | `DATABASE.md` + `API.md`; add `FRONTEND.md` when displayed in the admin console |
| Change login, JWT, HMAC, or password recovery | `SECURITY.md` + `API.md` + `BUSINESS_RULES.md` |
| Adjust build or release | `DEVELOPMENT.md` + `DEPLOYMENT.md` + `ARCHITECTURE.md` |
| Change documentation structure only | This file + `AGENTS.md`; also read the root README/CONTRIBUTING when open-source entry points are affected |

## Source-of-Truth Mapping

| Fact | Specification source | Implementation source |
| --- | --- | --- |
| Product and business semantics | `BUSINESS_RULES.md` | `worker/src/service.ts`, `worker/test/service.test.ts` |
| HTTP contract | `API.md` | `worker/src/routes.ts`, `http.ts`, `constants.ts` |
| Data structures | `DATABASE.md` | `migrations/`, `repository.ts`, `types.ts` |
| Admin pages and routing | `FRONTEND.md` | `admin/src/routes.tsx`, `pages/`, `components/` |
| Security boundaries | `SECURITY.md` | `config.ts`, `crypto.ts`, `middleware.ts`, related tests |
| Commands and environment | `DEVELOPMENT.md` / `DEPLOYMENT.md` | `package.json`, Wrangler configuration, `scripts/` |

## Writing Rules

- Use verifiable statements: state conditions, actions, results, and exceptions. Avoid vague phrasing such as "handle reasonably" or "support as needed".
- Prefer invariants, state tables, and decision tables for business rules; field and error contracts for APIs; field constraints and migration rules for the database.
- `must` marks a constraint that cannot be violated, `should` marks the default approach, and `may` marks something allowed but optional.
- Examples must never contain real secrets, production domains, production database IDs, or usable activation codes.
- Write paths, commands, enums, and field names in code format, matching the repository's current names exactly.
- Do not duplicate a rule. When a cross-document reference is needed, keep a one-line summary and link to the authoritative topic document.

## Change and Review

At minimum, a documentation change checks:

- Does the new rule have exactly one archival location?
- Do the paths, scripts, endpoints, enums, and fields referenced in the document still exist?
- Are business rules, API, database, frontend types, and tests consistent?
- Has a historical proposal been mistaken for current behavior?
- Do the README or contribution entry points need synchronizing?

When you find outdated documentation, fix it directly within the current task's scope. If the conflict would change product behavior, agree the intended behavior first, then update implementation, tests, and specification together.
