# Learning Orbit Login and Local Verification Addendum

**Status:** Approved decision addendum to [Plan 05: Student and Teacher UI](learning-orbit-plan-05-student-teacher-ui.md).

**Baseline:** `66b23909ca230728766cd54754634ae224ea2ed7` on `codex/learning-orbit-real-login`.

**Purpose:** Close the remaining entry, teacher-room recovery, controlled provisioning, local same-origin HTTPS, and local integrated-verification decisions without weakening the authentication, generated-contract, realtime, provider, privacy, export, or deletion boundaries already frozen in Plans 01–06.

This addendum is authoritative wherever it explicitly changes Plan 05. Every Plan 05 decision not changed here remains in force. Implementation must use tests first and must not modify or fall back to the frozen standalone HTML demonstration or `packages/test-fixtures/prototype/`.

---

## 1. Final route and authentication decisions

### 1.1 One canonical public entry

- `/` permanently redirects to `/login`. The implementation uses a permanent framework redirect and tests its canonical destination.
- `/login` is the only unauthenticated product entry for both roles. Its student panel accepts exactly `roomCode` and `seatCode`; its teacher panel accepts an email address and requests the existing passwordless Magic Link.
- `?role=student` and `?role=teacher` may select the initially visible panel and update accessible focus. The query value is presentation state only. It is never sent as authorization input, copied into `AuthSession`, trusted by a route guard, persisted as identity, or used to expose teacher controls. Missing or invalid values select the student panel.
- After a successful student join, the browser performs the fixed sequence `join → GET /v1/auth/session → GET /v1/rooms/{roomId} → navigation → WebSocket`. It navigates only to the server-returned student session's `/session/{roomId}`, and only after generated `RoomDetails` has produced the authorized roster. The join response itself remains exactly the Plan 05 generated shape and does not gain a room ID or realtime credential.
- The teacher request always shows the existing non-enumerating accepted copy. Normal browser navigation consumes the emailed link; the server sets the opaque cookie and returns `303 /teacher`. No client code reads, fetches, stores, or renders the token.
- If `/login` hydrates a valid student session, it redirects to that session's `/session/{roomId}`. If it hydrates a valid teacher session, it redirects to `/teacher`. A session-service or generated-response failure renders a bounded unavailable state and no classroom or fixture content.

This supersedes Plan 05's root join page and its unauthenticated Magic Link panel on `/teacher`; the two forms now live together on `/login`. It does not change the two existing authentication mechanisms.

### 1.2 Fail-closed product-route guards

Every protected page obtains `GET /v1/auth/session` with the opaque `lo_session` cookie, parses the generated `AuthSession`, narrows its discriminated role, and completes any room-ownership check before constructing or rendering a product workspace. The browser never infers authorization from a pathname, query, cached room, local storage, or component prop.

| Route | Required server authority | Missing or expired session | Wrong role or room | Authorized result |
|---|---|---|---|---|
| `/teacher` | Generated teacher `AuthSession` | Redirect to `/login?role=teacher` | Privacy-preserving 404 | Render the teacher room index, room creation, and logout controls |
| `/session/{roomId}` | Generated student `AuthSession` with `session.roomId === route roomId` | Redirect to `/login?role=student` | Privacy-preserving 404 | Hydrate `RoomDetails`, then construct the student workspace |
| `/session/{roomId}/teacher` | Generated teacher `AuthSession` plus server-proven ownership of the route room | Redirect to `/login?role=teacher` | Privacy-preserving 404 | Recover deletion state first; otherwise hydrate `RoomDetails` and construct `TeacherRoomContext` |

Malformed room IDs fail before data access. A non-auth transport failure, generated-parser failure, or unavailable dependency renders a closed error boundary with no partial console, room data, teacher action, or synthetic fallback. For the teacher room route, Plan 05's deletion-recovery ordering remains mandatory: query the content-free owner-only deletion locator before ordinary `RoomDetails`, and never read room content when deletion recovery is active.

There is no `/demo` product route. The legacy standalone HTML demonstration remains an independent, synthetic reference artifact only; it is not linked as an authenticated recovery path and is never rendered when session, API, WebSocket, analytics, media, or provider work fails.

---

## 2. Teacher room recovery contract

### 2.1 New generated response and route

Add `GET /v1/teacher/rooms` in `packages/contracts/schemas/teacher-room-list.v1.json`, generate `packages/contracts/src/generated/teacher-room-list.v1.ts` through the existing deterministic contract pipeline, export its `TeacherRoomListResponse` from the canonical contract index, and add the exact canonical builder `routes.teacher.rooms()`. The Web layer may consume that generated type through `SessionGateway`; it must not redeclare, cast, widen, or partially parse the wire response.

The response has exactly two top-level fields:

```json
{
  "rooms": [
    {
      "roomId": "11111111-1111-4111-8111-111111111111",
      "topic": "生態系統探究",
      "status": "open",
      "durationSeconds": 2700,
      "startsAt": "2026-08-31T09:00:00.000Z",
      "closesAt": "2026-08-31T09:45:00.000Z",
      "createdAt": "2026-08-31T08:55:00.000Z"
    }
  ],
  "truncated": false
}
```

The schema is strict:

- Top-level and room-item `additionalProperties` are `false`; both `rooms` and `truncated` are required.
- `rooms` contains at most 50 items. Every item requires exactly `roomId`, `topic`, `status`, `durationSeconds`, `startsAt`, `closesAt`, and `createdAt`.
- `roomId` is a UUID; `topic` retains the existing bounded room-topic contract; `status` is `scheduled | open | paused | closed`; `durationSeconds` remains the server-fixed `2700`; `createdAt` is an ISO date-time; `startsAt` and `closesAt` are ISO date-times or `null`, matching `RoomDetails`.
- The route accepts no pagination, limit, role, teacher, status, or sort query. It selects only rooms owned by the authenticated teacher.
- Ordering is deterministic: every room whose status is not `closed` comes before every closed room; within each group, `createdAt` is descending; equal timestamps use `roomId` descending as the final stable tie-break. The repository query reads at most 51 authorized rows, returns the first 50, and sets `truncated: true` exactly when an authorized fifty-first row exists.
- The endpoint and response never include room codes, seat codes, teacher email, participant data, pseudonyms, actor or member IDs, messages, media, analytics, Agent content, deletion detail, export locators, or provider metadata.
- The response uses `Cache-Control: no-store`. No valid session returns `401 {"code":"AUTH_REQUIRED"}`. A student or any other wrong-role principal returns the same privacy-preserving `404 {"code":"ROOM_NOT_FOUND"}` used for unauthorized room discovery. Service failure returns a bounded 503 code and no partial list.

`SessionGateway` gains one generated-contract method for this route. `/teacher` uses that method to show the bounded room index and navigate to `/session/{roomId}/teacher`; it never recovers room ownership from browser storage. The `truncated` flag produces honest bounded copy and does not trigger an undocumented follow-up query.

### 2.2 Controlled teacher provisioning

Add the operator-only command:

```bash
pnpm teacher:provision -- --email teacher@example.test
```

Its contract is fixed:

- Exactly one `--email` value is required. Unknown flags, missing values, malformed email, unavailable database, or migration mismatch fail non-zero before any ambiguous write.
- The command trims and lowercases the address with the same canonical normalization used by Magic Link lookup, validates it, and performs an atomic `INSERT ... ON CONFLICT (email) DO NOTHING` against `teacher_account`.
- Repeating the command for the same normalized address is safe: the first successful insertion prints `inserted=1`; every later successful invocation prints `inserted=0`.
- Success output contains only that inserted count. Failure output uses a stable redacted reason code. Neither stream may print or interpolate the email, database host/name/URL, connection options, credentials, Magic Link, token, cookie, provider secret, or stack containing those values.
- Database authority comes only from the operator's deployment-controlled environment. The command has no browser route, HTTP handler, interactive public form, password, self-registration behavior, or automatic Magic Link delivery.

Teacher accounts therefore remain allowlisted and provisioned by an authorized operator. `/login` does not become a public registration surface.

---

## 3. Local same-origin HTTPS topology

### 3.1 Exact public and internal origins

The only browser-visible local origin is:

```text
https://127.0.0.1:3000
```

Next.js serves pages/assets on that origin. Fastify remains internal at `http://127.0.0.1:3001`. Only when `LO_LOCAL_SAME_ORIGIN_PROXY=1` is set for the local harness may Next.js rewrite `/v1/:path*` to `http://127.0.0.1:3001/v1/:path*`. With the flag absent or any value other than the exact string `1`, the rewrite list is empty. Production startup must reject this local-only flag.

The rewrite covers ordinary HTTP and WebSocket upgrades under `/v1/*`. It never matches or proxies `/internal`, `/internal/*`, an arbitrary Fastify path, or port 3001 directly. Tests prove the public origin cannot reach an internal route.

Local server configuration uses the same exact public origin for both `LO_PUBLIC_BASE_ORIGIN` and the allowed browser Origin set. Trusted-proxy CIDRs remain empty unless a separately reviewed real proxy exists. Browser REST requests use relative canonical `/v1/*` builders; they never target port 3001.

### 3.2 Cookie, WebSocket, Origin, and certificate rules

- `lo_session` remains opaque, `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/`. It is never exposed to JavaScript, local/session storage, URLs, logs, screenshots, or evidence receipts.
- The room socket URL is derived from the browser origin by changing `https:` to `wss:` and appending only the generated `/v1/rooms/{roomId}/realtime` path. It is therefore `wss://127.0.0.1:3000/...`; no token, ticket, role, actor, or room authority appears in a query.
- Fastify continues exact Origin validation for state-changing HTTP requests and WebSocket upgrades. Wrong, missing where required, reflected, wildcard, `http://127.0.0.1:3000`, `https://localhost:3000`, and direct-port origins do not become equivalent to the approved origin.
- The local harness generates a short-lived self-signed certificate with SAN entries for `127.0.0.1` and `localhost` inside a system temporary directory. The directory is mode `0700`; both certificate and private-key files are mode `0600`. They never enter the repository. Playwright may ignore that certificate's trust error only in this local E2E project.
- The public Magic Link is generated on `https://127.0.0.1:3000/v1/auth/teacher/magic-link/consume`; its relative `303 /teacher` remains on the same secure origin.

This topology exists only for local integration and E2E verification. It is not a staging or production ingress design and does not authorize a public certificate exception.

---

## 4. Runtime ownership and fail-closed integration

### 4.1 Generated-contract-only SessionGateway

`SessionGateway` is the Web application's only REST boundary. Every request and response uses canonical route builders, generated request/response types, and the generated runtime parser. It always sends `credentials: "include"`, uses `cache: "no-store"` for session, list, export, and deletion reads, and never defines a second wire model in `apps/web`. Generated parse failure is a terminal response failure for that operation, not permission to keep unvalidated fields or use a fixture.

The gateway covers session hydrate/revoke, student join, teacher Magic Link request, teacher room list/create/read, room events, media grants/state, Agent state/policy, ECHO-CM and TRACE-AI projection reads, teacher review/correction, export, and deletion. Authorization remains server-owned even when the UI has already hidden an action.

### 4.2 RoomSocket and authoritative room sequence

`RoomSocket` is the single native-socket adapter owned by Plan 05's `RealtimeSessionClient`, not a second transport or state store. It owns one authenticated socket for one authorized route room, uses the generated realtime helpers, sends generated `hello { resumeFrom }`, and treats numeric server `roomSeq` as the only authoritative order for RoomEvents.

- Duplicate or stale RoomEvents do not mutate state. The next new event must equal `completeThroughRoomSeq + 1`.
- A gap leaves the local cursor and projections unchanged, buffers no unbounded data, and reconciles through the generated room-event page route before retrying the exact validated event. Snapshot/resume URLs are accepted only when their origin, route room, path, query, projection key, and role allowlist equal canonical generated builders.
- Projection, media-status, Agent-status, acknowledgment, welcome, heartbeat, and resume-complete frames never enter the RoomEvent ledger and never advance `roomSeq`.
- Lost acknowledgments resend the same immutable command and `commandId`; components cannot supply room, actor, role, clock, or identity fields.
- Socket authentication is the Secure cookie plus server authorization. A query-selected role, a visible console, or an old connection never grants cross-room delivery.

### 4.3 ECHO-CM, TRACE-AI, provider, and teacher-console boundaries

- ECHO-CM and TRACE-AI are computed and versioned by the server/worker path. The browser renders generated projections and warnings only; it does not calculate, repair, predict, or relabel scientific results. Chat, concept, and SNA projection versions remain independent and publish together only at the same numeric `completeThroughRoomSeq` when their policy-available inputs are ready.
- Agent, media, ASR/OCR, storage, and external-provider adapters remain default-off and fail closed. Missing or unauthorized capability produces the bounded server `*_UNAVAILABLE` or policy result and an honest unavailable UI. It never invokes a fixture provider, sends learner data externally, fabricates a transcript/Agent response, or loads the standalone Demo.
- Local acceptance proves the provider-disabled and provider-unavailable branches. A real external provider requires the separately signed Plan 06 authority, exact provider/manifest/region/modalities/retention scope, approved secret-variable names, and its own current evidence.
- `/teacher` lists the authenticated teacher's bounded room summaries and supports creation. `/session/{roomId}/teacher` retains Plan 05's owned room controls, one-time in-memory access-code display, lifecycle acknowledgments, Agent policy controls, review/correction queue, ECHO teacher shadow, TRACE teacher bundle, export, and deletion recovery. The teacher view has no ordinary student composer and cannot revise a student's words.

### 4.4 Export and deletion

Export and deletion remain teacher-only, room-owned server operations. Export uses the generated route builder, `no-store`, a sanitized server filename, a short-lived local object URL, and no content logging. The room-list endpoint is not an export surface.

Deletion remains the Plan 06 idempotent, fail-closed saga. Once deletion starts, ordinary room reads/writes fail closed; the content-free owner-only locator is checked before `RoomDetails`; queued, running, retryable, and dead never claim success; only a validated content-free receipt may show completion. Provider-copy, private-media, derivative, Agent, projection, cache, and backup boundaries keep their separate proofs. A local zero-provider fixture or provider-unavailable result does not prove remote-provider deletion, and the online receipt does not make a broader backup claim.

---

## 5. One local integrated verification command

The only command that may support this addendum's local integrated claim is:

```bash
pnpm verify:local-pilot
```

Individual tests remain useful during development, but their results cannot be combined manually into the local integrated claim. The root command is a fail-fast orchestrator using argument arrays with `shell: false`; it owns startup, readiness, evidence, teardown, and final cleanliness checks.

### 5.1 Exact prerequisites and no-skip rule

Before any test process starts, the command must verify:

- the worktree is a clean, non-detached exact commit and capture its full SHA;
- Node's major/minor is exactly `24.19` and its patch matches the checked-in runtime pin, currently `24.19.0`;
- pnpm is exactly `11.19.0`;
- the active Python interpreter's major/minor is exactly `3.12`, and the hash lock was generated for that minor;
- the connected PostgreSQL server reports major version exactly `18`, migrations match the repository, and test data is disposable;
- generated TypeScript/Python manifests, dependency locks, browser revision, image locks where invoked, the prototype baseline hashes, and canonical SQL hashes are current.

A missing runtime, browser, PostgreSQL 18 service, migration, certificate tool, provider fail-closed seam, or required test is a failure with a stable redacted code. It is never converted to a skipped, pending, or advisory pass. Every test registered in the command's required manifest must execute, and the runner fails if any required suite reports a skip, pending case, focused-only case, empty selection, or missing report.

### 5.2 Required deterministic gate order

The command runs all of the following against one source commit and one disposable local environment:

1. Repository layout, baseline, contract generation-diff, generated ownership, locks, typechecks, Python unit tests, TypeScript unit/integration tests, and PostgreSQL migration tests.
2. Production builds for Web, server, contracts, and Worker packaging/runtime import checks.
3. Local HTTPS startup at `https://127.0.0.1:3000`, internal Fastify at `127.0.0.1:3001`, worker and PostgreSQL readiness, followed by real-browser student and teacher login/session/logout/reload journeys. These journeys use real HTTP, cookie, database, and WebSocket paths; seeded-session helpers and browser request interception cannot satisfy them.
4. Route guards, teacher provisioning idempotency, teacher room list ordering/truncation/redaction, room create/open/pause/resume/close, `RoomSocket` resume/gap/replay, chat/media, server ECHO-CM/TRACE-AI projection synchronization, and teacher review/correction journeys.
5. Provider-disabled and provider-unavailable behavior, exact Origin rejection, Secure-cookie attributes, WSS with no credential query, `/internal` non-proxying, cross-room IDOR, CSRF, stored/untrusted rendering, rate-limit, secret/content-redaction, export bytes, and deletion status/receipt boundaries.
6. Playwright keyboard, reduced-motion, five-viewport, responsive-layout, CLS, focus, live-region, contrast, and axe checks with zero serious or critical accessibility violations.
7. The Plan 06 local engineering load fixture of 10 simultaneous rooms, four students plus one teacher per room, including 50 WebSocket clients, backpressure, error-rate, and latency thresholds. This is a declared local engineering target, not an SLA.

The harness uses synthetic classroom content and test-only teacher accounts. It never uses live learners, production credentials, or a real external provider.

For the teacher journey, local Fastify must use its real SMTP composition to deliver the message to an isolated Mailpit service. The test orchestrator assigns one run-unique synthetic teacher address, polls the Mailpit API only for that recipient, reads only the matching message in the controlling process, and parses the public `https://127.0.0.1:3000/v1/auth/teacher/magic-link/consume` URL there. Playwright then performs ordinary browser navigation to that URL and lets Fastify consume it. The page never receives a development-only login URL or mail API. The message body, Magic Link, token, recipient address, and resulting cookie must not appear in page state, browser console, Playwright trace, application/test logs, screenshots, command output, or receipts. Docker and the isolated Mailpit service are required local-gate dependencies: if either is unavailable, unhealthy, or cannot deliver/read the matching message, the gate fails with a redacted reason code; it never falls back to an injected sender, in-process/file link capture, request interception, or a skipped test.

### 5.3 Cleanup and receipts

On success, test failure, timeout, `SIGINT`, or `SIGTERM`, the runner terminates only child processes it started, closes browsers and sockets, removes its disposable database/test rows and session state, deletes every Mailpit message addressed to the run-unique synthetic teacher, re-queries Mailpit to verify that no such message remains, deletes the temporary TLS directory, and verifies its ports are released. A Mailpit cleanup or residual-message check failure invalidates the gate. A pre-existing listener causes a preflight failure; the runner never kills or adopts an unowned process. It may not delete a pre-existing database or user-owned service.

Content-free JSON receipts go under ignored `test-results/local-pilot/`. Each gate receipt records the full source commit, sanitized argv, start/end time, exit code, exact runtime fingerprints, relevant lock/generated/migration/source SHA-256 values, report SHA-256, cleanup result, and no-skip count. Receipts contain no email, link, token, cookie, connection URL, credential, learner content, media, prompt, provider payload, or signed URL.

The final receipt is valid only if every required gate passed, cleanup passed, `git rev-parse HEAD` still equals the starting SHA, repository hashes still match, and `git status --porcelain` is empty. Any mismatch invalidates the whole local claim.

---

## 6. Acceptance and claim ceiling

Implementation conforms to this addendum only when the exact committed implementation satisfies `pnpm verify:local-pilot` with zero required skips and content-free receipts, and a fresh review confirms all of these statements:

- `/` canonicalizes permanently to one accessible `/login`; student code join and teacher Magic Link remain distinct server-owned authentication flows inside that page.
- All protected routes fail closed on missing session, wrong role, cross-room access, wrong ownership, malformed generated data, and unavailable dependencies; query state never authorizes.
- `GET /v1/teacher/rooms` is generated-contract-only, owner-scoped, bounded to 50, deterministically ordered, truthfully truncated, and contains only the seven approved room fields.
- Teacher provisioning is idempotent, operator-only, non-registering, count-only, and redacted.
- Local browser traffic uses one exact HTTPS/WSS origin; the gated `/v1/*` rewrite cannot reach `/internal`; cookies and Origin checks remain strict; temporary TLS material is mode `0600` and cleaned.
- `SessionGateway`, `RoomSocket`, server-authoritative ECHO-CM/TRACE-AI, provider fail-closed behavior, teacher console, export, and deletion preserve Plans 01–06 boundaries without Demo fallback.

A green result proves only local integrated behavior and provider fail-closed completion for the exact source commit named by the receipts. It does not prove or authorize staging, production, a real external provider, a live classroom pilot, pilot efficacy, algorithm validity, learning outcomes, operational capacity beyond the declared fixture, availability, durability, incident response, or any production SLA. Those claims require their own current environment, provider, human-authority, deployment, and live evidence.

---

## 7. Relationship to Plan 05 and planning audit record

The following Plan 05 details are explicitly superseded: the root join location, unauthenticated teacher-panel location, server/schema immutability where this addendum names the room-list contract and endpoint, and the absence of a teacher room-recovery list. Plan 05's generated-contract ownership, student post-join session hydration, Magic Link consumption, role narrowing, teacher room context, deletion-first recovery, event ledger, realtime/projection separation, UI/privacy/accessibility requirements, and export/deletion evidence ceilings remain binding.

Planning audit on 2026-08-31 observed that a development-mode Next.js command had generated a temporary `apps/web/next-env.d.ts` import difference. The generated file was normalized back to the exact baseline bytes at `66b23909ca230728766cd54754634ae224ea2ed7`, and the implementation worktree was rechecked before implementation. That normalization was planning hygiene, not a product feature or an implementation change, and it provides no test, build, browser, deployment, or runtime evidence.
