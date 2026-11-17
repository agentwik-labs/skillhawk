# Self-hosting

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `--port` | `7420` | Listen port |
| `HOST` / `--host` | `127.0.0.1` | Bind address (`0.0.0.0` in containers) |
| `SKILLYARD_DATA` / `--data` | `./data` | Where `db.json` and skill files live |
| `SKILLYARD_ADMIN_TOKEN` | unset | Bearer token with admin rights (create orgs over the API) |
| `SKILLYARD_ALLOWED_ORIGINS` | localhost only | Comma-separated browser origins allowed to call `/mcp` |
| `SKILLYARD_PUBLIC_URL` | `http://<Host header>` | Public https URL; used for Stripe return links and per-copy links. Set it in production |
| `SKILLYARD_TRUST_PROXY` / `--trust-proxy` | off | `1` behind Caddy or nginx: use the client address the proxy appends to `X-Forwarded-For` |
| `SKILLYARD_RATE_LIMIT` / `--rate-limit` | `300` with `serve` | API requests per client IP per minute (publishes: a fifth of that); `0` turns it off |
| `SKILLYARD_PLANS` / `--plans` | `off` | `enforce` turns on seats and plan gates (docs/plans-and-seats.md) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM`, `STRIPE_PRICE_SEAT` | unset | Stripe billing; without them checkout returns 501 |

The Docker image runs `serve --log` only. For a local trial with demo data, run `seed` once first:
`docker run -v skillyard-data:/data skillyard node bin/skillyard.js seed`.

## Storage

`<data>/db.json` holds orgs, hashed tokens, skill metadata, scan results and the last 1,000 audit events. It is
written atomically (temp file + rename). Skill files live under `<data>/blobs/<scope>/<name>/<version>/`. Back up
the whole directory. A single process owns the data directory; run one replica, and scale reads with a CDN in
front of `GET /api/skills/*` for public skills if needed.

## Access model

- **Scopes**: every skill belongs to an org. `@skillyard` is the community scope that `seed` creates.
- **Tokens**: `read` sees the org's private skills; `publish` also publishes, changes visibility, deletes, manages
  the org's tokens and reads its activity log. Admin tokens (`skillyard token create --admin` or
  `SKILLYARD_ADMIN_TOKEN`) can do anything. Tokens are shown once and stored as SHA-256 hashes.
- **Private by default**: an org skill is private unless its `skill.json` or the publish request says `public`.
  Callers without access get `404`, so private skill names do not leak.

## Publishing pipeline

1. Validate: frontmatter, name rules, semver, path safety, 200 files / 1 MB per file / 5 MB per skill.
2. Scan: see `src/scan.js`. Critical findings block the publish with `422`; warnings are stored with the version.
3. Store: the version is immutable; republishing the same version returns `409`.
4. Audit: the event goes to the org's activity log.

## Hardening checklist

- Terminate TLS in front (Caddy, nginx, a cloud load balancer).
- Set `SKILLYARD_ADMIN_TOKEN` only when you need API org creation; prefer the local CLI on the server.
- Give CI and people separate read tokens; give publish tokens to maintainers only; revoke from the org page.
- Mount the data directory on persistent storage and back it up. `db.json` holds every org's signing key and mark
  secret, so backups go to a private, encrypted bucket; test a restore before you rely on it.
- Publish the container port on `127.0.0.1` only, so the API is reachable through the proxy alone, and keep
  `SKILLYARD_ADMIN_TOKEN` in a 0600 env file.
- Cap Docker logs (`--log-opt max-size=10m --log-opt max-file=5`).
- An org admin can export everything the org owns (`GET /api/orgs/<org>/export`) and delete skills on any plan or
  billing status.
