# Architecture — Phase 2 (Signed License + User Management + Dual Deployment)

This document is the Phase-2 structure visualization. It complements the
machine-generated graph in `graphify-out/` (`graph.json`, `graph.html`,
`GRAPH_REPORT.md`), which is regenerated with `graphify update . --force`
(graphify 0.9.67). The diagrams below are hand-maintained Mermaid, so they
survive without the graphify toolchain and highlight the Phase-2 additions:

- the signed-license surface (`worker/src/license/*`, `/api/v1`),
- the database-adapter boundary (`DbAdapter` + `D1Adapter` + `NodeSqliteAdapter`),
- admin/staff user management + JWT session-epoch kick-out,
- the second runtime (Node/Vercel entry point) alongside the Cloudflare Worker,
- the standalone `license-checker/`.

For the baseline Phase-1 layering see [ARCHITECTURE.md](ARCHITECTURE.md); this
file does not restate those rules, it extends them.

## System context — two runtimes, one app

The SAME Hono app (`worker/src/index.ts`) runs on two hosts. Only the host and
the database driver differ; routes, service, repository and crypto are
byte-identical. The Cloudflare Worker + D1 is the primary, durable target; the
Node/Vercel adapter is a functional-parity target backed by `node:sqlite`.

```mermaid
flowchart TB
  subgraph Clients
    Admin["Admin console<br/>(admin/, React + AntD Pro)"]
    Desktop["Desktop app / SDK<br/>(client APIs)"]
    Checker["license-checker/<br/>(public keys only)"]
  end

  subgraph App["Shared Hono app — worker/src/index.ts (UNCHANGED across hosts)"]
    Routes["routes.ts<br/>/api + /api/v1"]
    MW["middleware.ts<br/>requireAdmin / requireSuperAdmin /<br/>requireUserManager / epoch check"]
    Svc["service.ts<br/>business rules + status transitions"]
    Repo["repository.ts<br/>SQL only (prepare/bind)"]
  end

  subgraph DBB["DbAdapter boundary — worker/src/db/"]
    D1A["D1Adapter<br/>(Cloudflare D1)"]
    NSA["NodeSqliteAdapter<br/>(node:sqlite)"]
  end

  CF[("Cloudflare D1<br/>SQLite")]
  SQLITE[("Local SQLite file<br/>SQLITE_PATH")]

  Admin --> Routes
  Desktop --> Routes
  Checker --> Routes
  Routes --> MW --> Svc --> Repo
  Repo --> D1A --> CF
  Repo --> NSA --> SQLITE
```

Host wiring:

```mermaid
flowchart LR
  subgraph CFW["Cloudflare Worker (primary)"]
    direction TB
    IndexA["index.ts (fetch handler)"] --> D1Awrap["new Repository(new D1Adapter(env.DB))"]
  end
  subgraph NODE["Node / Vercel (parity target)"]
    direction TB
    Entry["entry-node.ts (node:http)"] --> BuildEnv["buildEnv(): env.DB = NodeSqliteAdapter"]
    VercelFn["api/[[...route]].ts"] --> BuildEnv
    BuildEnv --> IndexB["same index.ts app.fetch()"]
  end
  IndexA -. same app .-> IndexB
```

## Request flow — route → service → repository (dependency direction fixed)

```mermaid
flowchart LR
  Req["HTTP request"] --> V{"validateEnv<br/>(per request)"}
  V -->|ok| R["routes.ts<br/>parse + validate params"]
  R --> M["middleware<br/>auth / epoch / role gate"]
  M --> S["service.ts<br/>business decision"]
  S --> P["repository.ts<br/>prepared SQL + .bind()"]
  P --> DB["DbAdapter → SQLite/D1"]
  DB --> Resp["ok() / fail() envelope<br/>(http.ts)"]
```

## Signed-license surface (`/api/v1`, `worker/src/license/*`)

```mermaid
flowchart TB
  C["Client: POST /api/v1/license/verify"] --> VS["service.verifySigned()"]
  VS --> DSS["license/status.ts<br/>deriveSignedStatus<br/>(deleted→revoked, hold→hold,<br/>disabled→suspended, expired, active)"]
  VS --> CAN["license/canonical.ts<br/>12-key canonical bytes"]
  CAN --> SIGN["license/signing.ts<br/>Ed25519 sign (key_id stamped)"]
  SIGN --> OUT["{ payload, signature, public_key_id,<br/>verification_interval_seconds }"]

  OUT --> CK["license-checker verify.ts"]
  CK --> LOOK["config/publicKeys.ts<br/>trust only embedded key_id"]
  CK --> RECAN["re-canonicalize + Ed25519 verify"]
  CK --> FRESH["freshness / replay predicate (§8.4)"]
  CK -. tamper detected .-> REP["POST /api/v1/license/report"]
  REP --> AH["service.maybeAutoHold()<br/>≥2 distinct high-severity reports<br/>in window → hold"]
```

A tampered field (status, expiry, server_time, …) breaks the signature, so the
checker shows "license failed to load" and reports the anomaly; corroborated
reports auto-hold the license. The private key never leaves the server; the
checker ships the PUBLIC key only.

## User management + stateless session kick-out (FEAT-002)

```mermaid
flowchart TB
  Login["POST /api/admin/login"] --> JWT["signJwt({ sub, username, epoch })"]
  JWT --> Token["Bearer token (8h)"]
  Token --> RA["requireAdmin"]
  RA --> E{"token.epoch ==<br/>admin.session_epoch?"}
  E -->|no| K401["401 session revoked"]
  E -->|yes| PC{"must_change_password?"}
  PC -->|yes, non-exempt path| P403["403 PASSWORD_CHANGE_REQUIRED"]
  PC -->|no| UM{"user-mgmt route?"}
  UM -->|yes| RUM["requireUserManager<br/>super_admin OR user_role=admin<br/>(staff denied server-side)"]
  UM -->|no| Handler["route handler"]

  Kick["POST /api/admin/users/:id/kick"] --> Bump["incrementSessionEpoch + revoke audit rows"]
  Bump -. old tokens now fail epoch check .-> K401
```

Roles (decision NU-2 Option C): the published login-role CHECK
(`super_admin` / `tenant_admin`) is untouched; the management role lives in an
additive `user_role` column (`admin` / `staff`). `super_admin` is the implicit
master manager.

## Migrations (schema source of truth)

`migrations/0001…0008` applied in filename order. Phase-2 added
`0008_add_admin_users_and_sessions.sql` (additive `session_epoch` + `user_role`
columns, `admin_sessions` table with `ON DELETE CASCADE`). Note: the graphify
SQL extractor (`tree_sitter_sql`) is not installed in this environment, so the
`.sql` files contribute no nodes to `graphify-out/graph.json`; the migration
list is authoritative in `migrations/` and `docs/DATABASE.md`.

## Module map (where things live)

```mermaid
flowchart LR
  subgraph worker["worker/src/"]
    idx["index.ts"]
    rt["routes.ts"]
    mw["middleware.ts"]
    sv["service.ts"]
    rp["repository.ts"]
    cr["crypto.ts (JWT epoch, Ed25519 helpers)"]
    cfg["config.ts (env + signing-key validation)"]
    subgraph lic["license/"]
      can["canonical.ts"]
      sg["signing.ts"]
      st["status.ts"]
      lc["config.ts (auto-hold thresholds)"]
    end
    subgraph db["db/"]
      ad["adapter.ts (DbAdapter + D1Adapter)"]
      ns["node-sqlite.ts (NodeSqliteAdapter)"]
    end
    en["entry-node.ts (Node host)"]
  end
  subgraph admin["admin/src/"]
    ui["pages/ (incl. UsersPage, CodesPage)"]
    rtx["routes.tsx (menu gate)"]
    api["api.ts (Bearer + X-Tenant-Id, 401/PASSWORD_CHANGE handling)"]
  end
  subgraph checker["license-checker/src/"]
    cv["lib/verify.ts"]
    capi["lib/api.ts"]
    cpk["config/publicKeys.ts"]
  end
  vfn["api/[[...route]].ts (Vercel)"] --> en
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for how each runtime is built and shipped.
