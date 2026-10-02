# Security Policy

## Supported Scope

The `main` branch is the primary maintained version of this repository. Security fixes target the latest code first.

## Reporting a Vulnerability

Do not disclose an unfixed vulnerability in a public issue, discussion, or pull request.

Prefer reporting privately through a GitHub Security Advisory. If that feature is not enabled for this repository, use the private contact method the maintainers publish, and include `Security: license-manager` in the subject line.

Where possible, include:

- The affected endpoint, page, or module.
- Reproduction steps or a minimal proof of concept.
- The range of data that may be affected.
- The fix direction you consider viable.

## Sensitive Information

This project should never commit real production configuration. The `worker/wrangler.toml` in the open-source repository is for local development only; production configuration belongs in the uncommitted `worker/wrangler.production.toml`.

If a real secret, production D1 ID, production admin password, or `.dev.vars` was ever committed, immediately:

1. Purge the leaked content from history.
2. Rotate every affected Wrangler secret.
3. Rotate the production admin password.
4. Review access logs for the Cloudflare account, Worker, D1, and logs.

See `docs/SECURITY.md` for the project's internal security design.
