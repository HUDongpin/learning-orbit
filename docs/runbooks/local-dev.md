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
PostgreSQL 18, Mailpit and MinIO, creates the private media bucket, migrates
both databases, and provisions `teacher@learning-orbit.local`.

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

**The worker prefers `TEST_DATABASE_URL` over `DATABASE_URL`.** `WorkerConfig.from_env`
reads `TEST_DATABASE_URL` first, so a worker started in a shell that sourced
`.env` polls the *test* database and quietly processes nothing while the
development room's jobs pile up as `queued`. Start it with that variable
cleared:

```bash
set -a; . ./.env; set +a
unset TEST_DATABASE_URL
.venv/bin/python -m learning_orbit_worker.main
```

Without a running worker there are no ECHO or TRACE projections, and both
panels correctly say the server has not produced one yet — which reads like a
permission problem but is not.

**Never point `TEST_DATABASE_URL` at data you care about.** The server suite
calls `resetBusinessTables`, which `TRUNCATE`s rooms, members and `auth_session`.
Running `pnpm test:server` in the middle of a browser session silently logs the
browser out and deletes the room you were looking at, which presents as an
authentication bug. The bootstrap points it at a separate `learning_orbit_test`
database for exactly this reason.

**The local retention policy is synthetic.** Room creation refuses with
`RETENTION_POLICY_NOT_CONFIGURED` until a current `pilot_retention_policy` row
exists, so `pnpm bootstrap` installs the checked-in fixture, which guards
itself and refuses to run outside a test environment. A real pilot needs a
signed policy record imported by an operator; the development row is never
that, and its `approval_reference` says so.

**Seat codes are single-use.** A join that fails halfway cannot be retried with
the same seat code. Take the next seat, or create a new room.

**A missing pepper is configuration, not a bug.** Without
`ROOM_CODE_PEPPER_CURRENT_VERSION` and `ROOM_CODE_PEPPER_V1`, `RoomService` is
never constructed and every `/v1/rooms*` route answers
`503 ROOM_SERVICE_UNAVAILABLE`. The same is true of
`LO_SERVICE_ASSERTION_TRUST_FILE`: it must contain a real Ed25519 public key —
an empty `keys` array is refused. `pnpm bootstrap` writes both.

**The object store is private and stays private.** The bucket carries no
anonymous policy, and `pnpm storage:init` refuses to treat a bucket with one as
private rather than silently rewriting it. Every browser read and write goes
through a short-lived presigned URL whose signature covers the object key and
the SHA-256 checksum, so a grant issued for one file cannot upload another.
Promotion to the immutable destination key is a conditional PUT, not a
server-side copy: MinIO honours `If-None-Match: *` on a PUT and ignores it on a
copy, so only the PUT actually delivers a write-once destination.

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

## Load harnesses

There are two, and they measure different things.

`pnpm load:pilot` drives the real protocol: magic-link sign-in, seat-code join,
WebSocket clients, backpressure, and a contract-validated report. It is the
harness the required-test manifest gates on, because it is the one that can say
whether a committed event was lost or duplicated.

`pnpm load:k6 --origin http://localhost:3210` runs the digest-pinned
`grafana/k6:2.2.0` image against the authenticated HTTP read surface. k6 cannot
sign in through a magic link, redeem a single-use seat code, or speak the
WebSocket protocol, so it cannot answer the question above — it answers a
narrower one about latency and error rate under concurrent reads. Its
thresholds are the assertion: a breach exits non-zero.

The k6 run needs a server. Start one on a free port (3000 and 3200 are often
taken by other projects) and point the harness at it:

```bash
DATABASE_URL="$TEST_DATABASE_URL" PORT=3210 \
  LO_PUBLIC_BASE_ORIGIN=http://localhost:3210 \
  LO_ALLOWED_ORIGINS=http://localhost:3210 \
  pnpm --filter @learning-orbit/server exec tsx src/main.ts
```

A loopback origin is rewritten to `host.docker.internal` inside the container;
the host environment is never forwarded, and only `tests/load` (read-only) and
`test-results/load` are mounted.

## Running the browser suite when a port is taken

The pilot harness serves the app on 3000 and the API on 3001. If another
project already holds one of those, nothing needs editing — three environment
variables move the run:

```bash
LO_LOCAL_API_PORT=3401 LO_LOCAL_SAME_ORIGIN_PROXY=1 \
  pnpm --filter @learning-orbit/web exec next dev --port 3400
LO_E2E_BASE_URL=http://127.0.0.1:3400 \
  pnpm exec playwright test --config apps/web/playwright.config.ts
```

The defaults are unchanged, so the pilot harness and the required-test manifest
still describe the same run.

Next 16's dev server runs as a reusable daemon. If `--port` appears to be
ignored, an older daemon for this repository is still alive and the new
invocation attached to it; `pgrep -f next-server` finds it and the port it
actually bound.

### Running the browser suite off the default ports

The suite runs on any pair of ports. `local-public-boundary` passes on
3400/3401.

Two traps are easy to hit and both fail in confusing ways:

- Over plain HTTP the suite must browse `localhost`, not `127.0.0.1`. Next 16
  dev refuses cross-origin dev requests silently: the HTML arrives, hydration
  does not, and every assertion about a heading fails as "element not found".
- `real-classroom-journey` needs HTTPS. The session cookie is `Secure`, so a
  browser will not store it over plain HTTP. Lowering that assertion to make
  the suite run would be testing something weaker than production, so serve
  the app with `--experimental-https` and a local certificate instead.

**Do not use `curl` to test whether the WebSocket upgrade reaches the API.**
curl cannot complete a WebSocket handshake, so it hangs and looks exactly like
a proxy that is dropping the upgrade. Use a real client:

```bash
node -e 'const {WebSocket}=require("ws");const w=new WebSocket(process.argv[1],{rejectUnauthorized:false,origin:"https://127.0.0.1:3400"});w.on("open",()=>{console.log("OPEN");process.exit(0)});w.on("unexpected-response",(_q,r)=>{console.log("HTTP",r.statusCode);process.exit(0)})'   'wss://127.0.0.1:3400/v1/rooms/<roomId>/realtime'
```

Checked that way, the Next dev same-origin proxy does carry the upgrade: both
the direct API socket and the proxied one open.

### `pnpm e2e:local`

`scripts/run-local-e2e.mjs` assembles the whole environment and runs the
browser suite in a working tree, on any ports:

```bash
pnpm e2e:local                      # both specs
pnpm e2e:local --grep "public boundary"
```

It starts a fresh API (no object store), a dev web server over HTTPS with a
generated certificate, and the Python worker; runs Playwright against them;
writes every process's output to `test-results/e2e-processes.log`; and stops
everything it started, including the Next dev daemon, which it finds by port
because that daemon deliberately outlives its own wrapper.

It empties the business tables first, because the harness gets a disposable
database and a working tree does not: a previous run's open rooms, queued
auto-close jobs and sessions make the journey fail in ways that look like
product bugs. `--keep-data` skips that, for inspecting what a failed run left.

`verify:local-pilot` remains the authority: it runs in a disposable checkout on
the pinned ports and produces the receipt. This is the smaller loop for working
on the specs themselves.

**Known, still open — with the mechanism identified and four causes ruled out.**

`local-public-boundary` passes. `real-classroom-journey` drives sign-in, room
creation, four students joining, room open, pause and resume, then loses the
teacher's view of new events.

The close code names the mechanism: **4400, "hello required"**. The server
gives a new socket five seconds to send its `hello` frame
(`apps/server/src/modules/realtime/connection.ts`) and closes it otherwise. The
teacher's diagnostic reads `G2 N2 W1 R1 C1 … K4400`: two sockets, only one of
which ever completed a handshake. All four student sockets report no close.

The server is provably not at fault. After a failing run the message is
committed at its room sequence and every `outbox_event` row is published — it
was written and broadcast; the teacher's socket was not there to hear it.

Ruled out, each by a change that made no difference to the symptom:

- **Dev-mode compilation.** `e2e:local` warms every route first, and the
  process log shows no compilation during a run.
- **Dev bundle hydration cost.** The runner now builds and serves a production
  bundle behind its own ingress.
- **A superseded socket left abandoned.** `RoomSocket.connect` closed the
  socket it replaced (a real fix, kept: an abandoned socket is one the client
  will never speak on, which the server then holds for five seconds).
- **Upgrade data lost in the ingress.** The upgrade socket is paused until the
  upstream connects (also a real fix, also kept).

**It reproduces in a clean checkout.** A detached `git worktree` at the same
commit, a fresh `pnpm install --frozen-lockfile`, its own build, run on the
same free ports, fails byte-identically: `K4400`, `G2 N2 W1 R1`, teacher on
surface `H2`. This working tree is not the variable, and neither is the
environment as far as it can be varied here.

That changes what this is. It is a defect, not an artifact — which also means
the `browser-playwright` gate very likely does not pass today, and its
manifest count of `2` describes an intention rather than an observation. Worth
settling before any receipt is read as covering the browser journey.

**The client did speak.** The diagnostic now counts frames sent per socket, and
the dying one reads `K4400/5`: five frames sent, and the server still answered
"hello required". That contradicts the obvious reading and rules out every
theory built on it — the client is not failing to send `hello`.

`connection.ts` produces 4400 in exactly two places: the five-second timer when
no hello has arrived, and a first frame that is not a hello. Since frames were
sent, the question is now which of those fired and why the server did not see a
hello it was sent. The client's own gating makes the second case hard to reach:
`send` only transmits once `#resumeReady`, and `#sendEphemeral` returns early
before resume with a comment naming this exact hazard.

Two candidates worth taking next, in order:

1. **The frames went to the wrong place.** `scripts/local-e2e-ingress.mjs`
   forwards upgrades by hand; a bug there that crossed two client sockets onto
   one upstream, or lost the first frames of one, would look precisely like
   this. The students' sockets working through the same ingress argues against
   it but does not settle it. Running the suite against the API directly, with
   `LO_ALLOWED_ORIGINS` matching, removes the ingress from the picture.
2. **Two sockets, one server connection.** `G2` with `W1 R1` and `A3 E3` says
   one socket is fully healthy while another dies. Logging the connection
   identity server-side would say whether the server saw one upgrade or two.

Ruled out already: `RoomSocket.connect` leaving a superseded socket open (now
closed), `dispose()` not reaching `socket.destroy()` (it does), and the
student-to-teacher redirect creating a socket (it returns first).

Worth carrying into that: the five-second budget is measured from the server's
accept but can only be answered when the client's main thread is free. On the
old classroom laptop this pilot targets, the heaviest page could plausibly
exceed it, and what a teacher sees is "即時同步已停止" mid-lesson. Raising the
deadline is not obviously right — it exists to stop a socket that connects and
never identifies itself from holding resources — so it wants a measurement on
real hardware before anyone changes it.

