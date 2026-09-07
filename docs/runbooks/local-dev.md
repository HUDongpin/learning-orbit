# Local development runbook

How to get Learning Orbit running against a real server and a real PostgreSQL 18
database on a macOS workstation, and the handful of traps that reliably cost an
hour when they are not written down.

This runbook is for development. It is **not** the pilot evidence gate — that is
`pnpm verify:local-pilot`, which owns its own disposable worktree, run-scoped
Compose project and run-scoped secrets, and refuses to reuse anything here.

---

## 1. Prerequisites

| Tool | Required | Install |
|---|---|---|
| Node | exactly `v24.19.0` | [nodejs.org/dist/v24.19.0](https://nodejs.org/dist/v24.19.0/) — unpack it and put its `bin` first on `PATH` |
| pnpm | exactly `11.19.0` | `npm install -g pnpm@11.19.0` |
| Python | `3.12.x` | `brew install python@3.12`, or `uv python install 3.12` |
| Docker | any engine that answers | Docker Desktop |
| OpenSSL | `/opt/homebrew/bin/openssl` | `brew install openssl@3` |

The versions are exact on purpose: `scripts/verify-layout.mjs` and the local-pilot
preflight both refuse anything else, so a "close enough" toolchain fails a gate
much later, with a less obvious message.

Check the whole set at once:

```bash
node --version && pnpm --version && python3.12 --version && docker info --format '{{.ServerVersion}}'
```

---

## 2. Bootstrap

```bash
pnpm bootstrap
```

One idempotent command. It checks the toolchain, generates owner-only secrets
under `secrets/local-dev/` (an Ed25519 worker-assertion pair and a `localhost`
TLS certificate), writes a `.env` of disposable local values, installs the
workspace, builds `.venv` with the locked worker dependencies, starts
PostgreSQL 18 and Mailpit, migrates both databases, and provisions
`teacher@learning-orbit.local`.

Rerunning it never rotates an existing secret and never overwrites `.env`.
Pass `--force` to reissue both.

If it stops with *"the volume was initialised with a different password"*, an
earlier bootstrap left a database volume behind whose password is no longer the
one in `.env`. Discarding it loses every row in your local development database:

```bash
pnpm bootstrap --reset-database
```

---

## 3. Run it

Two processes, two terminals.

```bash
set -a; . ./.env; set +a
PORT=3001 pnpm --filter @learning-orbit/server dev
```

```bash
set -a; . ./.env; set +a
LO_LOCAL_SAME_ORIGIN_PROXY=1 pnpm --filter @learning-orbit/web exec next dev \
  --hostname localhost --port 3000 \
  --experimental-https \
  --experimental-https-key "$LO_DEV_TLS_KEY" \
  --experimental-https-cert "$LO_DEV_TLS_CERT"
```

Then open **<https://localhost:3000/login>** and accept the self-signed
certificate once. `/` permanently redirects there.

Fastify listens on `http://127.0.0.1:3001`, but the browser never talks to it
directly. `LO_LOCAL_SAME_ORIGIN_PROXY=1` belongs on that one command and not in
`.env`: `next.config.ts` refuses the flag outside the dev-server phase, so a
`.env` carrying it breaks `pnpm typecheck` and `pnpm build`. With it set, the Next dev server externally
rewrites `/v1/*` — the WebSocket upgrade included — to port 3001, so the whole
product runs on one origin and the `Secure` `lo_session` cookie works. `/internal`
is deliberately not proxied; a request for it from the browser origin gets a 404.

Sign in as the teacher by requesting a Magic Link on the teacher panel and
opening the mail in Mailpit at <http://localhost:8025>.

To add another teacher:

```bash
set -a; . ./.env; set +a
pnpm teacher:provision -- --email someone@example.test
```

There is no public registration surface, by design.

---

## 4. Traps

**Browse `localhost`, not `127.0.0.1`.** Next 16 blocks cross-origin dev
resources. If the dev server was started with `--hostname localhost` and you
open `https://127.0.0.1:3000`, the client bundle never loads: you get the SSR
shell, no effect ever fires, and it looks exactly like a hung fetch rather than
a blocked asset. (The Playwright suite is self-consistent the other way — its
harness starts Next on `127.0.0.1` and its `baseURL` matches.)

**Never point `TEST_DATABASE_URL` at data you care about.** The server suite
calls `resetBusinessTables`, which `TRUNCATE`s rooms, members and `auth_session`.
Running `pnpm test:server` in the middle of a browser session silently logs the
browser out and deletes the room you were looking at, which presents as an
authentication bug. The bootstrap points it at a separate `learning_orbit_test`
database for exactly this reason.

**Seat codes are single-use.** A join that fails halfway cannot be retried with
the same seat code. Take the next seat, or create a new room.

**A missing pepper is configuration, not a bug.** Without
`ROOM_CODE_PEPPER_CURRENT_VERSION` and `ROOM_CODE_PEPPER_V1`, `RoomService` is
never constructed and every `/v1/rooms*` route answers
`503 ROOM_SERVICE_UNAVAILABLE`. The same is true of
`LO_SERVICE_ASSERTION_TRUST_FILE`: it must contain a real Ed25519 public key —
an empty `keys` array is refused. `pnpm bootstrap` writes both.

**No browser storage, ever.** `localStorage.length !== 0` is a hard end-to-end
failure, so no user preference — theme, density, display mode — may be persisted.
Those are `prefers-color-scheme` plus in-memory React state, and each control's
own copy has to say the choice resets on reload.

**Docker Desktop can hang rather than fail.** If `docker ps` never returns,
quit Docker Desktop, kill any surviving `com.docker.backend` process, then
reopen it — `open -a Docker` alone will not relaunch while the stale process is
still registered.

---

## 5. Tests

```bash
set -a; . ./.env; set +a

pnpm test                                                    # contracts, web, server
.venv/bin/python -m unittest discover -s services/worker/tests -t services/worker
pnpm exec vitest run tests/pilot --project cross-node --allowOnly=false
```

Every database-backed suite requires `TEST_DATABASE_URL` and fails loudly
without it; none of them skip themselves quietly.

The counts these suites must produce are pinned in
`tests/pilot/required-test-manifest.v1.json`. When you legitimately add or
remove tests, update that manifest and the matching assertion in
`tests/pilot/required-test-gates.test.ts` in the same commit — a stale count
fails the gate rather than the suite, which is a confusing place to start
debugging.

---

## 6. Approving a new machine

The local-pilot preflight admits only toolchains whose exact bytes have been
reviewed, listed in `infra/local-pilot/approved-runtimes.v1.json`. On a new
workstation:

```bash
node scripts/local-pilot/record-approved-runtime.mjs --id my-workstation
```

It prints a manifest entry and writes nothing. Review it, then add it to the
manifest in a commit of its own. A new machine is a reviewed data change, never
a gate edit.

---

## 7. Tearing down

```bash
docker compose --env-file .env -f infra/docker-compose.yml down     # keep the data
docker compose --env-file .env -f infra/docker-compose.yml down -v  # discard it
```

`secrets/local-dev/` and `.env` are git-ignored and disposable; delete them and
rerun `pnpm bootstrap` to start over.
