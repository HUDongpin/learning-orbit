# Learning Orbit Foundation and Realtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a controlled 45-minute Learning Orbit pilot room with one authenticated teacher, four pseudonymous students, durable ordered text events, and resumable realtime delivery.

**Architecture:** Modular monorepo. Fastify atomically writes `room_event`+`outbox_event`; at-least-once WebSocket clients dedupe `eventId` and advance per-room `roomSeq`. Next.js consumes JSON Schema contracts; Python claims durable jobs.

**Tech Stack:** Node.js 24.19, pnpm 11.19, Next.js 16.2.9, Fastify 5.10 with `@fastify/websocket` 11.3, PostgreSQL 18, SQL migrations, JSON Schema 2020-12/Ajv, Vitest/jsdom/Testing Library, Playwright 1.62.1 with locked Chromium, Python 3.12, `psycopg`, `cryptography` Ed25519, stdlib `unittest`, Docker Compose.

---

## Fixed scope and invariants

- Root `learning-orbit/`; web `apps/web`; API/WS `apps/server`; worker `services/worker`; schemas/generated `packages/contracts/{schemas,src/generated}`; migrations/init `infra/postgres/{migrations,init}`; claim SQL `apps/server/src/db/sql`; Compose `infra/docker-compose.yml`; aggregators `apps/server/src/{routes,realtime}.ts`.
- Demo HTML is read-only. Four seats are `探索者 A–D`; codes/sessions are random, opaque, hash-only.
- State is scheduled→open→paused↔open→closed; first open fixes +2700s; writes require open.
- Envelope/history are immutable; `(room_id,room_seq|causation_id)` unique; retry returns original ack.
- Outbox `learning_orbit.room_event.v1` carries `RoomEventEnvelope` schema `room-event-envelope.v1.json`.
- Envelope permits namespaced names; the Registry rejects unregistered types. Plan 01 registers only core `room.*`/`message.*` schemas.
- Job states: `queued|running|succeeded|retryable|dead|cancelled`; claim excludes cancelled and uses `FOR UPDATE SKIP LOCKED`.
- Plan 01 owns `001_core.sql`; Plan 02 owns `002_media.sql`.
- DB tasks first run `export LO_TEST_DB=postgres://learning_orbit:learning_orbit@127.0.0.1:55432/learning_orbit_test`.
- Media, OCR/ASR, Agent orchestration, analytics, learned moderation, research export, deployment, and SSO are out of scope.

### Task 1: Scaffold the monorepo and lock toolchains

**Files:** Create `learning-orbit/{package.json,pnpm-workspace.yaml,tsconfig.base.json,vitest.config.ts,.nvmrc,.python-version,.gitignore,apps/{web,server}/package.json,packages/contracts/package.json,services/worker/{pyproject.toml,requirements.lock},scripts/{verify-layout,assert-root-scripts,assert-test-project-ownership,verify-python-lock}.mjs}`, `learning-orbit/apps/web/{vitest.config.ts,test/setup.ts}`, `learning-orbit/apps/server/vitest.config.ts`, `learning-orbit/packages/contracts/vitest.config.ts`.

- [ ] **Step 1: Write the failing layout assertion**

```js
// learning-orbit/scripts/verify-layout.mjs
import { access } from "node:fs/promises";
const files=["package.json","pnpm-workspace.yaml","vitest.config.ts","apps/web/package.json","apps/web/vitest.config.ts","apps/server/package.json","apps/server/vitest.config.ts","packages/contracts/package.json","packages/contracts/vitest.config.ts","services/worker/pyproject.toml"];
const missing=[];
for(const file of files){try{await access(new URL(`../${file}`,import.meta.url));}catch{missing.push(file);}}
if(missing.length){console.error(`missing:\n${missing.join("\n")}`);process.exit(1);}
console.log("layout: PASS");
```

- [ ] **Step 2: Verify red**

Run: `mkdir -p learning-orbit/scripts && node learning-orbit/scripts/verify-layout.mjs`

Expected: exit `1`, beginning `missing:`.

- [ ] **Step 3: Create exact manifests and minimal app entries**

```json
{"name":"learning-orbit","private":true,"packageManager":"pnpm@11.19.0","engines":{"node":">=24.19.0 <24.20.0"},"scripts":{"build":"pnpm -r build","typecheck":"pnpm -r typecheck","test":"pnpm -r test","contracts:generate":"pnpm --filter @learning-orbit/contracts generate","test:contracts":"pnpm --filter @learning-orbit/contracts test","test:server":"pnpm --filter @learning-orbit/server test","test:realtime":"pnpm --filter @learning-orbit/server test -- realtime","test:web":"pnpm --filter @learning-orbit/web test","db:migrate":"pnpm --filter @learning-orbit/server db:migrate","db:migrate:test":"pnpm --filter @learning-orbit/server db:migrate:test","playwright":"playwright test"}}
```

```yaml
# learning-orbit/pnpm-workspace.yaml
packages: ["apps/*", "packages/*"]
```

Name packages `@learning-orbit/{server,web,contracts}`; add build/typecheck/test, server dev/db:migrate, and contracts generate. Install exact pins:

```bash
pnpm --filter @learning-orbit/server add fastify@5.10.0 @fastify/cookie@11.0.2 @fastify/websocket@11.3.0 @fastify/rate-limit@11.2.0 ajv@8.17.1 ajv-formats@3.0.1 nodemailer@7.0.6 pg@8.16.3 @learning-orbit/contracts@workspace:*
pnpm --filter @learning-orbit/server add -D typescript@5.9.2 tsx@4.20.5 vitest@3.2.4 ws@8.18.3 @types/node@24.3.0 @types/pg@8.15.5
pnpm --filter @learning-orbit/web add next@16.2.9 react@19.2.0 react-dom@19.2.0 @learning-orbit/contracts@workspace:*
pnpm --filter @learning-orbit/web add -D typescript@5.9.2 vitest@3.2.4 @types/node@24.3.0 @types/react@19.1.12 @playwright/test@1.62.1 @axe-core/playwright@4.13.0 @testing-library/react@16.3.2 @testing-library/dom@10.4.1 @testing-library/jest-dom@7.0.1 @testing-library/user-event@14.6.6 jsdom@30.0.1
pnpm --filter @learning-orbit/contracts add ajv@8.17.1 ajv-formats@3.0.1 && pnpm --filter @learning-orbit/contracts add -D json-schema-to-typescript@15.0.4 typescript@5.9.2 vitest@3.2.4
pnpm add -Dw typescript@5.9.2 vitest@3.2.4 tsx@4.20.5 @types/node@24.3.0 @types/react@19.1.12 @types/react-dom@19.1.9 @playwright/test@1.62.1 @axe-core/playwright@4.13.0 jsdom@30.0.1 react@19.2.0 react-dom@19.2.0 @testing-library/react@16.3.2 @testing-library/dom@10.4.1 @testing-library/jest-dom@7.0.1 @testing-library/user-event@14.6.6
pnpm --filter @learning-orbit/web exec playwright install chromium
```

Root `pnpm vitest ...` commands used throughout Plans 02–06 are owned by the pinned root binary and Vitest 3.2 `test.projects` configuration (not the deprecated workspace file):

```ts
// learning-orbit/vitest.config.ts
import { defineConfig } from "vitest/config";
import { assertTestProjectOwnership } from "./scripts/assert-test-project-ownership.mjs";
export default defineConfig(async()=>{await assertTestProjectOwnership(new URL(".",import.meta.url));return{test:{projects:[
  "apps/server/vitest.config.ts",
  "apps/web/vitest.config.ts",
  "packages/contracts/vitest.config.ts",
  {test:{name:"cross-node",environment:"node",include:["tests/{integration,chaos,pilot}/**/*.test.ts"]}},
  {test:{name:"cross-security",environment:"jsdom",setupFiles:["apps/web/test/setup.ts"],include:["tests/security/**/*.test.{ts,tsx}"]}},
]}}});
```

```js
// scripts/assert-test-project-ownership.mjs
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const ownerPatterns=[/^apps\/server\/test\/.*\.test\.ts$/, /^apps\/web\/(app|src|test)\/.*\.test\.(ts|tsx)$/, /^packages\/contracts\/test\/.*\.test\.ts$/, /^tests\/(integration|chaos|pilot)\/.*\.test\.ts$/, /^tests\/security\/.*\.test\.(ts|tsx)$/];
export async function assertTestProjectOwnership(rootUrl){const root=fileURLToPath(rootUrl),files=[];async function walk(dir,rel=""){for(const e of await readdir(dir,{withFileTypes:true})){if(["node_modules",".git",".next","test-results"].includes(e.name))continue;const r=rel?`${rel}/${e.name}`:e.name,p=`${dir}/${e.name}`;if(e.isDirectory())await walk(p,r);else if(/\.test\.(ts|tsx)$/.test(r))files.push(r);}}await walk(root);const bad=files.map(file=>({file,count:ownerPatterns.filter(pattern=>pattern.test(file)).length})).filter(x=>x.count!==1);if(bad.length)throw new Error(`VITEST_PROJECT_OWNERSHIP:${JSON.stringify(bad)}`);}
```

```ts
// apps/server/vitest.config.ts
import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";
export default defineProject({test:{name:"server",root:fileURLToPath(new URL(".",import.meta.url)),environment:"node",include:["test/**/*.test.ts"]}});
```

```ts
// apps/web/vitest.config.ts
import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";
const root=fileURLToPath(new URL(".",import.meta.url));
export default defineProject({test:{name:"web",root,environment:"jsdom",setupFiles:["test/setup.ts"],include:["{app,src,test}/**/*.test.{ts,tsx}"]}});
```

```ts
// packages/contracts/vitest.config.ts
import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";
export default defineProject({test:{name:"contracts",root:fileURLToPath(new URL(".",import.meta.url)),environment:"node",include:["test/**/*.test.ts"]}});
```

Each child file uses `defineProject`, an absolute root derived from its own `import.meta.url`, a unique name (`server`, `web`, `contracts`), and one closed include pattern. Server/Contracts and cross-node integration/chaos/pilot tests use `environment:"node"`; Web and cross-security rendering tests use `environment:"jsdom"` plus the same setup file. A config-ownership test enumerates every `.test.ts/.test.tsx` and requires exactly one matching project; zero or multiple matches fail. Thus a root file filter such as `pnpm vitest run apps/server/test/media/upload-grant.test.ts` selects the correct project/environment, while package-local filtered scripts remain valid.

```toml
# learning-orbit/services/worker/pyproject.toml
[build-system]
requires=["setuptools==80.9.0"]
build-backend="setuptools.build_meta"
[project]
name="learning-orbit-worker"
version="0.1.0"
requires-python=">=3.12,<3.13"
dependencies=["cryptography==50.0.1","jsonschema==4.25.1","psycopg[binary,pool]==3.2.9"]
[project.optional-dependencies]
dev=[]
```

Write `.nvmrc=24.19.0`, `.python-version=3.12`, strict shared/per-package TS config, and minimal Next layout/page/config. `verify-layout.mjs` rejects any Node version other than `24.19.x`, and the root engine range must match that minor line; this is a reproducibility pin, not a claim that later Node 24 minors are incompatible. Configure the Web Vitest environment as `jsdom` with `test/setup.ts` importing `@testing-library/jest-dom/vitest`; server/contracts/cross-package projects stay Node-only. `assert-root-scripts.mjs` loads the root manifest and fails unless every script named above exists and resolves to the exact filtered/root binary command; it also performs Vitest project ownership discovery, so later plans cannot assume an undeclared binary/config. Type-check without secrets.

Inside the exact Python 3.12 environment install only `pip-tools==7.6.1` as the lock tool, then run `python -m piptools compile --generate-hashes --resolver=backtracking --output-file services/worker/requirements.lock services/worker/pyproject.toml`. `verify-python-lock.mjs` rejects unhashed/non-exact requirements, a lock generated by another Python minor, or direct dependencies missing from the lock. Install runtime/test dependencies with `python -m pip install --require-hashes -r services/worker/requirements.lock`, then install the local package `--no-deps -e services/worker`. Plans 02 and 04 update this same pyproject+lock pair and rerun the verifier; no second requirements file or unlocked `pip install` is allowed.

- [ ] **Step 4: Verify green and commit**

First call Codex `load_workspace_dependencies`; assign its exact bundled Python executable to task-specific `LO_PYTHON_BIN` (or use a separately approved 3.12), never a hardcoded user path. Run: `cd learning-orbit && "$LO_PYTHON_BIN" -c 'import sys; assert sys.version_info[:2]==(3,12)' && "$LO_PYTHON_BIN" -m venv .venv && source .venv/bin/activate && python -m pip install pip-tools==7.6.1 && python -m piptools compile --generate-hashes --resolver=backtracking --output-file services/worker/requirements.lock services/worker/pyproject.toml && python -m pip install --require-hashes -r services/worker/requirements.lock && python -m pip install --no-deps -e services/worker && python3.12 --version && corepack enable && pnpm --version && pnpm install && node scripts/verify-layout.mjs && node scripts/assert-root-scripts.mjs && node scripts/verify-python-lock.mjs && pnpm --filter @learning-orbit/web exec playwright --version && pnpm typecheck`

Expected: Python 3.12.x/Node 24.19.x/pnpm 11.19.0, Playwright 1.62.1 and its Chromium revision are recorded with the reviewed lock; layout/script/typecheck and root Vitest project-discovery PASS; `.venv` ignored. A missing browser launch or unowned/ambiguous test file blocks every later gate.

Commit: `git add . && git commit -m "chore: initialize Learning Orbit monorepo"`

### Task 2: Freeze JSON Schema 2020-12 wire contracts

**Files:** Create `packages/contracts/schemas/{room-command.v1,room-event-envelope.v1,realtime-frame.v1,core-room-event-payloads.v1,room-http.v1}.json`, `packages/contracts/src/{schema-ajv,event-payload-registry,core-room-event,routes,realtime,index}.ts`, `packages/contracts/{scripts/generate-types.mjs,test/{contracts,payload-registry,generated-ownership}.test.ts,test/fixtures.ts}`; generate one `src/generated/<schema-basename>.ts` module per schema plus `src/generated/manifest.json`.

- [ ] **Step 1: Write the failing schema test**

```ts
// packages/contracts/test/contracts.test.ts
import fs from "node:fs";import{expect,it}from"vitest";import{makeSchemaAjv}from"../src/schema-ajv.js";
const read=(n:string)=>JSON.parse(fs.readFileSync(new URL(`../schemas/${n}`,import.meta.url),"utf8"));
it("accepts human add but rejects forged Agent fields",()=>{const ajv=makeSchemaAjv();const command=ajv.compile(read("room-command.v1.json")),base={commandId:"11111111-1111-4111-8111-111111111111",roomId:"22222222-2222-4222-8222-222222222222",type:"message.add",clientTime:"2026-08-28T09:00:00Z",payload:{text:"你好",mentions:[]}};expect(command(base)).toBe(true);expect(command({...base,payload:{...base.payload,agentRunId:base.commandId}})).toBe(false);const schema=read("room-event-envelope.v1.json");expect(schema.properties.type.pattern).toBe("^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_.]*$");expect(schema.properties.actorRole.enum).toContain("system_worker");});
it.each([["human","socratic_facilitator"],["agent","teacher"],["system","student"]])("rejects impossible actor pairing %s/%s",(actorKind,actorRole)=>{expect(validateRoomEvent({...validEnvelope,actorKind,actorRole})).toBe(false);});
```

- [ ] **Step 2: Verify red**

Run: `cd learning-orbit && pnpm --filter @learning-orbit/contracts test`

Expected: FAIL with `ENOENT` for `room-command.v1.json`.

- [ ] **Step 3: Add complete contract definitions**

```json
{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://learning-orbit.local/schemas/room-command.v1.json","title":"RoomCommand","type":"object","additionalProperties":false,"required":["commandId","roomId","type","clientTime","payload"],"properties":{"commandId":{"type":"string","format":"uuid"},"roomId":{"type":"string","format":"uuid"},"type":{"enum":["room.open","room.pause","room.resume","room.close","message.add","message.revise","message.retract"]},"clientTime":{"type":"string","format":"date-time"},"baseRevision":{"type":"integer","minimum":1},"payload":{"type":"object"}},"allOf":[{"if":{"properties":{"type":{"const":"message.add"}}},"then":{"properties":{"payload":{"type":"object","additionalProperties":false,"required":["mentions"],"properties":{"text":{"type":"string","maxLength":4000},"replyTo":{"type":["string","null"],"format":"uuid"},"mentions":{"type":"array","maxItems":5,"uniqueItems":true,"items":{"type":"string","format":"uuid"}},"mediaIds":{"type":"array","maxItems":4,"uniqueItems":true,"items":{"type":"string","format":"uuid"}}},"anyOf":[{"required":["text"],"properties":{"text":{"pattern":"\\S"}}},{"required":["mediaIds"],"properties":{"mediaIds":{"minItems":1}}}]}}}},{"if":{"properties":{"type":{"const":"message.revise"}}},"then":{"required":["baseRevision"],"properties":{"payload":{"type":"object","additionalProperties":false,"required":["messageId","text","replyTo","mentions"],"properties":{"messageId":{"type":"string","format":"uuid"},"text":{"type":"string","maxLength":4000,"pattern":"\\S"},"replyTo":{"type":["string","null"],"format":"uuid"},"mentions":{"type":"array","maxItems":5,"uniqueItems":true,"items":{"type":"string","format":"uuid"}}}}}}},{"if":{"properties":{"type":{"const":"message.retract"}}},"then":{"required":["baseRevision"],"properties":{"payload":{"type":"object","additionalProperties":false,"required":["messageId"],"properties":{"messageId":{"type":"string","format":"uuid"}}}}}},{"if":{"properties":{"type":{"enum":["room.open","room.pause","room.resume","room.close"]}}},"then":{"properties":{"payload":{"type":"object","additionalProperties":false,"maxProperties":0}}}}]}
```

```json
{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://learning-orbit.local/schemas/room-event-envelope.v1.json","title":"RoomEventEnvelope","type":"object","additionalProperties":false,"required":["eventId","schemaVersion","roomId","roomSeq","type","actorId","actorKind","actorRole","revision","operation","eventTime","ingestTime","causationId","correlationId","payload"],"properties":{"eventId":{"type":"string","format":"uuid"},"schemaVersion":{"const":1},"roomId":{"type":"string","format":"uuid"},"roomSeq":{"type":"integer","minimum":1},"type":{"type":"string","pattern":"^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_.]*$"},"actorId":{"type":"string","format":"uuid"},"actorKind":{"enum":["human","agent","system"]},"actorRole":{"enum":["teacher","student","socratic_facilitator","room_clock","system_worker"]},"revision":{"type":"integer","minimum":1},"operation":{"enum":["add","revise","retract"]},"eventTime":{"type":"string","format":"date-time"},"ingestTime":{"type":"string","format":"date-time"},"causationId":{"type":"string","format":"uuid"},"correlationId":{"type":"string","format":"uuid"},"payload":{"type":"object"}},"oneOf":[{"properties":{"actorKind":{"const":"human"},"actorRole":{"enum":["teacher","student"]}}},{"properties":{"actorKind":{"const":"agent"},"actorRole":{"const":"socratic_facilitator"}}},{"properties":{"actorKind":{"const":"system"},"actorRole":{"enum":["room_clock","system_worker"]}}}]}
```

```json
{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://learning-orbit.local/schemas/core-room-event-payloads.v1.json","title":"CoreRoomEventPayloadCatalog","type":"object","additionalProperties":false,"maxProperties":0,"$defs":{"u":{"type":"string","format":"uuid"},"t":{"type":"string","format":"date-time"},"m":{"type":"array","maxItems":5,"uniqueItems":true,"items":{"$ref":"#/$defs/u"}},"ids":{"type":"array","maxItems":4,"uniqueItems":true,"items":{"$ref":"#/$defs/u"}},"RoomOpenedPayload":{"type":"object","additionalProperties":false,"required":["startsAt","closesAt"],"properties":{"startsAt":{"$ref":"#/$defs/t"},"closesAt":{"$ref":"#/$defs/t"}}},"RoomPausedPayload":{"type":"object","additionalProperties":false,"required":["pausedAt"],"properties":{"pausedAt":{"$ref":"#/$defs/t"}}},"RoomResumedPayload":{"type":"object","additionalProperties":false,"required":["resumedAt"],"properties":{"resumedAt":{"$ref":"#/$defs/t"}}},"RoomClosedPayload":{"type":"object","additionalProperties":false,"required":["closedAt"],"properties":{"closedAt":{"$ref":"#/$defs/t"}}},"MessageAddedPayload":{"type":"object","additionalProperties":false,"required":["messageId","text","replyTo","mentions","mediaIds"],"properties":{"messageId":{"$ref":"#/$defs/u"},"text":{"type":"string","maxLength":4000},"replyTo":{"type":["string","null"],"format":"uuid"},"mentions":{"$ref":"#/$defs/m"},"mediaIds":{"$ref":"#/$defs/ids"},"agentRunId":{"$ref":"#/$defs/u"},"sourceEventIds":{"type":"array","maxItems":30,"uniqueItems":true,"items":{"$ref":"#/$defs/u"}},"warningCodes":{"type":"array","maxItems":20,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":100}}}},"MessageRevisedPayload":{"type":"object","additionalProperties":false,"required":["messageId","text","replyTo","mentions","mediaIds"],"properties":{"messageId":{"$ref":"#/$defs/u"},"text":{"type":"string","maxLength":4000},"replyTo":{"type":["string","null"],"format":"uuid"},"mentions":{"$ref":"#/$defs/m"},"mediaIds":{"$ref":"#/$defs/ids"}}},"MessageRetractedPayload":{"type":"object","additionalProperties":false,"required":["messageId"],"properties":{"messageId":{"$ref":"#/$defs/u"}}}}}
```

```json
{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://learning-orbit.local/schemas/room-http.v1.json","title":"RoomHttpCatalog","type":"object","additionalProperties":false,"maxProperties":0,"$defs":{"u":{"type":"string","format":"uuid"},"t":{"type":["string","null"],"format":"date-time"},"code6":{"type":"string","pattern":"^[A-Z2-9]{6}$"},"code10":{"type":"string","pattern":"^[A-Z2-9]{10}$"},"nova":{"type":"object","additionalProperties":false,"required":["actorId","actorKind","actorRole","displayName"],"properties":{"actorId":{"$ref":"#/$defs/u"},"actorKind":{"const":"agent"},"actorRole":{"const":"socratic_facilitator"},"displayName":{"const":"Nova Agent"}}},"p":{"type":"object","additionalProperties":false,"required":["actorId","pseudonym","actorKind","actorRole"],"properties":{"actorId":{"$ref":"#/$defs/u"},"pseudonym":{"type":"string"},"actorKind":{"const":"human"},"actorRole":{"const":"student"}}},"CreateRoomRequest":{"type":"object","additionalProperties":false,"required":["topic"],"properties":{"topic":{"type":"string","minLength":1,"maxLength":160}}},"CreateRoomResponse":{"type":"object","additionalProperties":false,"required":["room","seatInvites"],"properties":{"room":{"type":"object","additionalProperties":false,"required":["roomId","roomCode","status","durationSeconds","nova"],"properties":{"roomId":{"$ref":"#/$defs/u"},"roomCode":{"$ref":"#/$defs/code6"},"status":{"const":"scheduled"},"durationSeconds":{"const":2700},"nova":{"$ref":"#/$defs/nova"}}},"seatInvites":{"type":"array","minItems":4,"maxItems":4,"items":{"type":"object","additionalProperties":false,"required":["roomMemberId","actorId","pseudonym","code"],"properties":{"roomMemberId":{"$ref":"#/$defs/u"},"actorId":{"$ref":"#/$defs/u"},"pseudonym":{"type":"string"},"code":{"$ref":"#/$defs/code10"}}}}}},"JoinRoomRequest":{"type":"object","additionalProperties":false,"required":["roomCode","seatCode"],"properties":{"roomCode":{"$ref":"#/$defs/code6"},"seatCode":{"$ref":"#/$defs/code10"}}},"JoinRoomResponse":{"type":"object","additionalProperties":false,"required":["roomMemberId","actorId","pseudonym"],"properties":{"roomMemberId":{"$ref":"#/$defs/u"},"actorId":{"$ref":"#/$defs/u"},"pseudonym":{"type":"string"}}},"RoomDetails":{"type":"object","additionalProperties":false,"required":["roomId","topic","status","durationSeconds","startsAt","closesAt","nova","participants"],"properties":{"roomId":{"$ref":"#/$defs/u"},"topic":{"type":"string"},"status":{"enum":["scheduled","open","paused","closed"]},"durationSeconds":{"const":2700},"startsAt":{"$ref":"#/$defs/t"},"closesAt":{"$ref":"#/$defs/t"},"nova":{"$ref":"#/$defs/nova"},"participants":{"type":"array","minItems":4,"maxItems":4,"items":{"$ref":"#/$defs/p"}}}},"RoomEventPage":{"type":"object","additionalProperties":false,"required":["events","throughRoomSeq"],"properties":{"events":{"type":"array","maxItems":500,"items":{"$ref":"room-event-envelope.v1.json"}},"throughRoomSeq":{"type":"integer","minimum":0},"nextAfterSeq":{"type":"integer","minimum":0}}}}}
```

- [ ] **Step 4: Add the default-deny payload registry and extension test**

```ts
// packages/contracts/src/event-payload-registry.ts
import{type AnySchema,type ValidateFunction}from"ajv";import{makeSchemaAjv}from"./schema-ajv.js";import catalog from"../schemas/core-room-event-payloads.v1.json" with{type:"json"};
const names={"room.opened":"RoomOpenedPayload","room.paused":"RoomPausedPayload","room.resumed":"RoomResumedPayload","room.closed":"RoomClosedPayload","message.added":"MessageAddedPayload","message.revised":"MessageRevisedPayload","message.retracted":"MessageRetractedPayload"}as const;
export class EventPayloadRegistry{private ajv=makeSchemaAjv();private validators=new Map<string,ValidateFunction>();register(type:string,schema:AnySchema){if(!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/.test(type))throw new Error(`INVALID_EVENT_TYPE_NAME:${type}`);if(this.validators.has(type))throw new Error(`EVENT_TYPE_ALREADY_REGISTERED:${type}`);this.validators.set(type,this.ajv.compile(schema));}assert(type:string,payload:unknown){const validate=this.validators.get(type);if(!validate)throw new Error(`UNKNOWN_EVENT_TYPE:${type}`);if(!validate(payload))throw new Error(`INVALID_EVENT_PAYLOAD:${type}`);}}
export function createCoreEventPayloadRegistry(){const r=new EventPayloadRegistry(),d=catalog.$defs as Record<string,AnySchema>;for(const[t,n]of Object.entries(names))r.register(t,{...d[n],$defs:d});return r;}
```

```ts
// packages/contracts/src/schema-ajv.ts
import Ajv2020 from "ajv/dist/2020.js";import addFormats from "ajv-formats";
export function makeSchemaAjv(){const ajv=new Ajv2020({strict:true,strictNumbers:true,allErrors:true});addFormats(ajv);ajv.addKeyword({keyword:"x-learning-orbit-python-ingress",schemaType:"boolean",valid:true});return ajv;}
```

All contract/server schema factories import `makeSchemaAjv`; no caller silently disables strict mode. `x-learning-orbit-python-ingress` is the sole registered custom annotation and never affects instance validation; any other unknown keyword remains an error. Task 7 marks the auto-close schema, and Plan 02 later uses that same annotation as the only Python-generation selector.

```ts
// packages/contracts/test/payload-registry.test.ts
import{expect,it}from"vitest";import{createCoreEventPayloadRegistry}from"../src/event-payload-registry.js";
it("closes payloads and allows Agent provenance",()=>{const r=createCoreEventPayloadRegistry(),base={messageId:"11111111-1111-4111-8111-111111111111",text:"證據？",replyTo:null,mentions:[],mediaIds:[]};expect(()=>r.assert("message.added",{...base,unknown:true})).toThrow("INVALID_EVENT_PAYLOAD");expect(()=>r.assert("message.added",{...base,agentRunId:"22222222-2222-4222-8222-222222222222",sourceEventIds:[],warningCodes:[]})).not.toThrow();expect(()=>r.assert("message.revised",{...base,agentRunId:base.messageId})).toThrow("INVALID_EVENT_PAYLOAD");});
it("defaults unknown namespaces closed",()=>{const r=createCoreEventPayloadRegistry();expect(()=>r.assert("extension.sampled",{})).toThrow("UNKNOWN_EVENT_TYPE:extension.sampled");r.register("extension.sampled",{type:"object",additionalProperties:false});expect(()=>r.assert("extension.sampled",{})).not.toThrow();});
```

```ts
// packages/contracts/test/generated-ownership.test.ts
import{expect,expectTypeOf,it}from"vitest";import type{JoinRoomRequest,JoinRoomResponse,CreateRoomRequest,CreateRoomResponse,RoomDetails,RoomEventPage,MessageAddedPayload}from"../src/index.js";import{parseCoreRoomEvent,routes}from"../src/index.js";import{read,event,U}from"./fixtures.js";
type Owned=[JoinRoomRequest,JoinRoomResponse,CreateRoomRequest,CreateRoomResponse,RoomDetails,RoomEventPage,MessageAddedPayload];
it("owns generated wires",()=>{for(const n of["room-http.v1","core-room-event-payloads.v1"]){const s=read(n);expect([s.$schema,s.$id,s.title,s.additionalProperties]).toEqual(["https://json-schema.org/draft/2020-12/schema",expect.any(String),expect.any(String),false]);}expectTypeOf<Owned>().not.toEqualTypeOf<never>();expect(routes.rooms.events("a/b",{afterSeq:4,limit:500})).toContain("a%2Fb/events?afterSeq=4&limit=500");expect(()=>routes.rooms.events("x",{limit:501})).toThrow();});
it("narrows core",()=>{expect(parseCoreRoomEvent(event("extension.sampled",{}))).toBeNull();expect(()=>parseCoreRoomEvent(event("message.added",{bad:1}))).toThrow("INVALID_EVENT_PAYLOAD:message.added");expect(parseCoreRoomEvent(event("message.added",{messageId:U,text:"",replyTo:null,mentions:[],mediaIds:[]}))?.type).toBe("message.added");});
```

```ts
// packages/contracts/src/core-room-event.ts
import type{RoomEventEnvelope}from"./generated/room-event-envelope.v1.js";import type*as P from"./generated/core-room-event-payloads.v1.js";import{createCoreEventPayloadRegistry}from"./event-payload-registry.js";
type E<T extends string,P>=Omit<RoomEventEnvelope,"type"|"payload">&{type:T;payload:P};
export type CoreRoomEvent=E<"room.opened",P.RoomOpenedPayload>|E<"room.paused",P.RoomPausedPayload>|E<"room.resumed",P.RoomResumedPayload>|E<"room.closed",P.RoomClosedPayload>|E<"message.added",P.MessageAddedPayload>|E<"message.revised",P.MessageRevisedPayload>|E<"message.retracted",P.MessageRetractedPayload>;
const core=new Set(["room.opened","room.paused","room.resumed","room.closed","message.added","message.revised","message.retracted"]),payloads=createCoreEventPayloadRegistry();
export function parseCoreRoomEvent(e:RoomEventEnvelope):CoreRoomEvent|null{if(!core.has(e.type))return null;payloads.assert(e.type,e.payload);return e as CoreRoomEvent;}
```

Index re-exports Registry/factory, generated payloads and `parseCoreRoomEvent`. Later plans register schemas only at composition.

Closed realtime union: client `hello`/`command`/`presence`/`typing`/`heartbeat`; server `welcome`/`ack`/`reject`/`event`/`presence`/`typing`/`resume_complete`/`snapshot_required`/`degraded`/`heartbeat` with the listed fields in tests. `welcome` and every server heartbeat carry a validated `serverTime` date-time used only to estimate the classroom countdown; the client never extends `closesAt`. Client presence is exactly `{type:"presence",state:"active"|"away",clientSeq}` and typing is `{type:"typing",active:boolean,clientSeq}`. Server presence/typing replaces client identity with the authenticated room actor and adds `expiresAt`; `degraded` is the closed content-free branch `{type:"degraded",scope:"realtime"|"media"|"analytics"|"agent",code,updatedAt,retryAfterMs?,projectionKey?}`. `projectionKey` is forbidden outside analytics; code `STUDENT_ANALYTICS_NOT_PROMOTED` requires exactly `echo.student_approved` or `trace.student_bundle`, allowing one promoted/revoked panel to change without affecting the other or chat. None of these ephemeral/status branches contains text or becomes a `RoomEvent`. Reject enum: `AUTH_REQUIRED|FORBIDDEN|INVALID_COMMAND|ROOM_NOT_OPEN|MESSAGE_NOT_FOUND|REVISION_CONFLICT|RESYNC_REQUIRED|INTERNAL`.

`packages/contracts/src/realtime.ts` owns and exports one `realtimeContract` object with generated-schema-backed `parseRealtimeFrame`, `encodeClientFrame` and `encodeRoomCommand`; it accepts no provider delta or unregistered later frame until a later plan adds that schema branch and its parser fixture. Web/server code imports this named object rather than a namespace export or handwritten union.

- [ ] **Step 5: Generate types with a deterministic script**

```js
// packages/contracts/scripts/generate-types.mjs
import{createHash}from"node:crypto";import{mkdir,readdir,readFile,rm,writeFile}from"node:fs/promises";import{compileFromFile}from"json-schema-to-typescript";
const schemas=new URL("../schemas/",import.meta.url),out=new URL("../src/generated/",import.meta.url),opts={bannerComment:"/* generated; source is JSON Schema */",unreachableDefinitions:true};await mkdir(out,{recursive:true});
const names=(await readdir(schemas)).filter((n)=>n.endsWith(".json")).sort();
if(!names.length)throw new Error("NO_CONTRACT_SCHEMAS");
for(const old of(await readdir(out)).filter((n)=>n.endsWith(".ts"))){if(!names.includes(old.slice(0,-3)+".json"))await rm(new URL(old,out));}
const sourceSchemas=[],generatedModules=[];
for(const file of names){const n=file.slice(0,-5),bytes=await readFile(new URL(file,schemas)),schema=JSON.parse(bytes.toString("utf8"));if(typeof schema.$id!=="string")throw new Error(`SCHEMA_ID_MISSING:${file}`);sourceSchemas.push({file,id:schema.$id,sha256:createHash("sha256").update(bytes).digest("hex")});const moduleFile=`${n}.ts`;await writeFile(new URL(moduleFile,out),await compileFromFile(new URL(file,schemas).pathname,opts));generatedModules.push({sourceFile:file,moduleFile,language:"typescript"});}
await writeFile(new URL("manifest.json",out),JSON.stringify({schemaVersion:1,sourceSchemas,generatedModules},null,2)+"\n");
```

`generated-ownership.test.ts` freezes the only manifest-v1 ABI as `{schemaVersion:1,sourceSchemas:[{file,id,sha256}],generatedModules:[{sourceFile,moduleFile,language}]}`. It compares sorted `sourceSchemas[].file` with the schema directory, verifies every `$id` and SHA-256, and compares the TypeScript `generatedModules` entries with generated `.ts` basenames. The legacy fields `sourceSchemaFiles` and `schemaSha256` are forbidden. Adding/removing a schema without regenerating, retaining an orphan generated module, or emitting a second manifest shape fails. Plan 02 extends this same generator to a Python output directory whose manifest uses the identical v1 object shape and canonical `sourceSchemas` array; only `generatedModules` differs by language.

Run: `pnpm --filter @learning-orbit/contracts generate && pnpm --filter @learning-orbit/contracts test && pnpm --filter @learning-orbit/contracts typecheck`

Expected: all generated declarations, contract tests, and typecheck PASS.

- [ ] **Step 6: Commit**

Commit: `git add packages/contracts && git commit -m "feat(contracts): freeze room realtime schemas"`

### Task 3: Add PostgreSQL 18, migrations, Outbox, and job claims

**Files:** Create `infra/{docker-compose.yml,postgres/{init/001_test_database.sql,migrations/001_core.sql}}`, `apps/server/src/db/{sql/{claim_outbox_event,claim_worker_job,settle_worker_job_claims,lock_room_xact,lock_room_session,unlock_room_session}.sql,migrate.ts,pool.ts,transactions.ts}`, `apps/server/src/modules/{jobs/job-claim-authority,rooms/room-lock}.ts`, `apps/server/test/db/{schema,job-claim-authority,room-lock}.test.ts`.

- [ ] **Step 1: Write the failing schema test**

```ts
// apps/server/test/db/schema.test.ts
import{Pool}from"pg";import{expect,it}from"vitest";import{runMigrations}from"../../src/db/migrate.js";
const url=process.env.TEST_DATABASE_URL!;
it("creates frozen core tables idempotently",async()=>{await runMigrations(url,"infra/postgres/migrations");await runMigrations(url,"infra/postgres/migrations");const p=new Pool({connectionString:url});const r=await p.query("select table_name from information_schema.tables where table_schema='public' and table_name=any($1) order by 1",[["teacher_account","magic_link","auth_session","classroom_room","room_member","room_event","outbox_event","worker_job","worker_job_completion"]]);expect(r.rows).toHaveLength(9);await p.end();});
it("persists one non-null correlation ID on every worker job",async()=>{await runMigrations(url,"infra/postgres/migrations");const p=new Pool({connectionString:url});const c=await p.query("select is_nullable,column_default from information_schema.columns where table_schema='public' and table_name='worker_job' and column_name='correlation_id'");expect(c.rows[0]).toMatchObject({is_nullable:"NO"});expect(c.rows[0].column_default).toMatch(/gen_random_uuid/);const j=await p.query("insert into worker_job(job_type,dedupe_key,payload) values('schema.probe.v1',$1,'{}') returning correlation_id",[`schema.probe:${crypto.randomUUID()}`]);expect(j.rows[0].correlation_id).toMatch(/^[0-9a-f-]{36}$/);await p.end();});
it("requires a fenced lease only while a worker job is running",async()=>{await runMigrations(url,"infra/postgres/migrations");const p=new Pool({connectionString:url});await expect(p.query("insert into worker_job(job_type,dedupe_key,payload,status,locked_at,locked_by) values('schema.probe.v1',$1,'{}','running',now(),'w')",[`bad-lease:${crypto.randomUUID()}`])).rejects.toThrow(/worker_job_check/);const j=await p.query("insert into worker_job(job_type,dedupe_key,payload) values('schema.probe.v1',$1,'{}') returning claim_generation,claim_token,locked_at,locked_by",[`clean-lease:${crypto.randomUUID()}`]);expect(j.rows[0]).toEqual({claim_generation:"0",claim_token:null,locked_at:null,locked_by:null});await p.end();});
```

```ts
// apps/server/test/db/job-claim-authority.test.ts
it("locks the exact running tuple and accepts one stable completion marker",async()=>{const claim=await claimedJob("room.auto-close.v1");await db.tx(async tx=>{await authority.requireCurrent(tx,claim);await authority.completeBusiness(tx,claim,"ROOM_AUTO_CLOSE_COMPLETED");await authority.completeBusiness(tx,claim,"ROOM_AUTO_CLOSE_COMPLETED");});expect(await completionRows(claim.jobId)).toEqual([{generation:claim.claimGeneration,code:"ROOM_AUTO_CLOSE_COMPLETED"}]);await expect(db.tx(tx=>authority.requireCurrent(tx,{...claim,claimToken:crypto.randomUUID()}))).rejects.toThrow("JOB_CLAIM_STALE");});
it("rejects a conflicting code for the same generation",async()=>{const claim=await claimedJob("schema.probe.v1");await db.tx(tx=>authority.completeBusiness(tx,claim,"PROBE_COMPLETED"));await expect(db.tx(tx=>authority.completeBusiness(tx,claim,"OTHER_COMPLETION"))).rejects.toThrow("JOB_COMPLETION_CONFLICT");});
```

- [ ] **Step 2: Verify red**

Run: `cd learning-orbit && docker compose -f infra/docker-compose.yml up -d postgres && TEST_DATABASE_URL="$LO_TEST_DB" pnpm --filter @learning-orbit/server test -- test/db/schema.test.ts`

Expected: FAIL: migration runner absent.

- [ ] **Step 3: Add migration runtime and exact SQL**

Compose uses `postgres:18`, port `55432`, `learning_orbit` credentials/database, `pg_isready`, and read-only `./postgres/init`; init creates test DB with the same owner.

```sql
-- infra/postgres/migrations/001_core.sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE FUNCTION learning_orbit_room_lock_key(p_room_id uuid)
RETURNS bigint LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT hashtextextended('learning-orbit-room-v1:' || p_room_id::text, 0)
$$;
CREATE TABLE teacher_account(teacher_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text UNIQUE NOT NULL CHECK(email=lower(email)),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE magic_link(magic_link_id uuid PRIMARY KEY,teacher_id uuid NOT NULL REFERENCES teacher_account ON DELETE CASCADE,token_hash bytea UNIQUE NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL);
CREATE TABLE classroom_room(room_id uuid PRIMARY KEY,room_code_hash bytea NOT NULL UNIQUE,nova_actor_id uuid NOT NULL UNIQUE,teacher_id uuid NOT NULL REFERENCES teacher_account,topic text NOT NULL CHECK(char_length(topic) BETWEEN 1 AND 160),status text NOT NULL DEFAULT 'scheduled' CHECK(status IN('scheduled','open','paused','closed')),duration_seconds int NOT NULL DEFAULT 2700 CHECK(duration_seconds=2700),starts_at timestamptz,closes_at timestamptz,closed_at timestamptz,next_room_seq bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE room_member(room_member_id uuid PRIMARY KEY,actor_id uuid NOT NULL UNIQUE,room_id uuid NOT NULL REFERENCES classroom_room ON DELETE CASCADE,seat_index smallint NOT NULL CHECK(seat_index BETWEEN 1 AND 4),pseudonym text NOT NULL,code_hash bytea NOT NULL,UNIQUE(room_id,seat_index),UNIQUE(room_id,pseudonym),UNIQUE(room_id,code_hash));
CREATE TABLE auth_session(session_id uuid PRIMARY KEY,token_hash bytea UNIQUE NOT NULL,principal_kind text NOT NULL CHECK(principal_kind IN('teacher','student')),teacher_id uuid REFERENCES teacher_account ON DELETE CASCADE,room_member_id uuid REFERENCES room_member ON DELETE CASCADE,expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),CHECK((principal_kind='teacher' AND teacher_id IS NOT NULL AND room_member_id IS NULL) OR (principal_kind='student' AND teacher_id IS NULL AND room_member_id IS NOT NULL)));
```

```sql
-- event delivery and jobs remain in the same 001_core.sql transaction
CREATE TABLE room_event(event_id uuid PRIMARY KEY,room_id uuid NOT NULL REFERENCES classroom_room ON DELETE CASCADE,room_seq bigint NOT NULL,schema_version int NOT NULL DEFAULT 1,type text NOT NULL,actor_id uuid NOT NULL,actor_kind text NOT NULL CHECK(actor_kind IN('human','agent','system')),actor_role text NOT NULL,revision int NOT NULL CHECK(revision>=1),operation text NOT NULL CHECK(operation IN('add','revise','retract')),event_time timestamptz NOT NULL,ingest_time timestamptz NOT NULL,causation_id uuid NOT NULL,correlation_id uuid NOT NULL,payload jsonb NOT NULL,UNIQUE(room_id,room_seq),UNIQUE(room_id,causation_id));
CREATE INDEX room_event_resume_idx ON room_event(room_id,room_seq);
CREATE INDEX room_event_message_idx ON room_event(room_id,((payload->>'messageId')),revision DESC);
CREATE TABLE outbox_event(outbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,event_id uuid UNIQUE NOT NULL REFERENCES room_event ON DELETE CASCADE,room_id uuid NOT NULL REFERENCES classroom_room ON DELETE CASCADE,room_seq bigint NOT NULL,topic text NOT NULL DEFAULT 'learning_orbit.room_event.v1',envelope jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),available_at timestamptz NOT NULL DEFAULT now(),locked_at timestamptz,locked_by text,publish_attempts int NOT NULL DEFAULT 0,published_at timestamptz,last_error text);
CREATE TABLE worker_job(
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  room_id uuid REFERENCES classroom_room ON DELETE CASCADE,
  source_event_id uuid REFERENCES room_event ON DELETE CASCADE,
  dedupe_key text UNIQUE NOT NULL,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK(status IN('queued','running','succeeded','retryable','dead','cancelled')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  run_after timestamptz NOT NULL DEFAULT now(),
  claim_generation bigint NOT NULL DEFAULT 0 CHECK(claim_generation >= 0),
  claim_token uuid,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status='running' AND claim_token IS NOT NULL AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
    OR
    (status<>'running' AND claim_token IS NULL AND locked_at IS NULL AND locked_by IS NULL)
  )
);
CREATE TABLE worker_job_completion(
  job_id uuid NOT NULL REFERENCES worker_job(job_id) ON DELETE CASCADE,
  claim_generation bigint NOT NULL CHECK(claim_generation > 0),
  claim_token_hash char(64) NOT NULL CHECK(claim_token_hash ~ '^[a-f0-9]{64}$'),
  completion_code text NOT NULL CHECK(completion_code ~ '^[A-Z0-9_]{1,64}$'),
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id,claim_generation),
  UNIQUE (job_id,claim_token_hash)
);
```

```sql
-- apps/server/src/db/sql/claim_worker_job.sql
SELECT j.job_id
FROM worker_job j
WHERE j.run_after<=now()
  AND (
    (j.status IN('queued','retryable') AND j.claim_token IS NULL
      AND j.locked_at IS NULL AND j.locked_by IS NULL)
    OR (j.status='running' AND j.locked_at<now()-interval '2 minutes')
  )
ORDER BY j.run_after,j.created_at
FOR UPDATE SKIP LOCKED
LIMIT %s;
```

```sql
-- apps/server/src/db/sql/settle_worker_job_claims.sql
WITH recovered AS (
  UPDATE worker_job j
  SET status='succeeded',claim_token=NULL,locked_at=NULL,locked_by=NULL,
      last_error=NULL,updated_at=now()
  FROM worker_job_completion c
  WHERE j.job_id=c.job_id AND j.status='running'
    AND j.job_id=ANY(%s::uuid[])
    AND c.claim_generation=j.claim_generation
    AND c.claim_token_hash=encode(digest(j.claim_token::text,'sha256'),'hex')
    AND j.locked_at<now()-interval '2 minutes'
  RETURNING j.job_id
), recovered_completion_cleanup AS (
  DELETE FROM worker_job_completion c
  USING recovered r
  WHERE c.job_id=r.job_id
  RETURNING c.job_id
), exhausted AS (
  UPDATE worker_job j
  SET status='dead',claim_token=NULL,locked_at=NULL,locked_by=NULL,
      last_error='JOB_LEASE_EXPIRED_MAX_ATTEMPTS',updated_at=now()
  WHERE j.job_id=ANY(%s::uuid[]) AND j.status='running'
    AND j.locked_at<now()-interval '2 minutes'
    AND j.attempts>=j.max_attempts
    AND j.job_id NOT IN (SELECT job_id FROM recovered)
  RETURNING j.job_id
), picked AS (
  SELECT j.job_id FROM worker_job j
  WHERE j.job_id=ANY(%s::uuid[]) AND j.attempts<j.max_attempts
    AND j.job_id NOT IN (SELECT job_id FROM recovered)
    AND j.job_id NOT IN (SELECT job_id FROM exhausted)
    AND (
      (j.status IN('queued','retryable') AND j.claim_token IS NULL AND j.locked_at IS NULL AND j.locked_by IS NULL)
      OR (j.status='running' AND j.locked_at<now()-interval '2 minutes')
    )
)
UPDATE worker_job j
SET status='running',locked_at=now(),locked_by=%s,
    claim_token=gen_random_uuid(),claim_generation=j.claim_generation+1,
    attempts=j.attempts+1,updated_at=now()
FROM picked WHERE j.job_id=picked.job_id
RETURNING j.*;
```

`JobStore.claim(1)` opens one READ COMMITTED transaction, executes `claim_worker_job.sql` to lock/skip exactly one candidate, then executes `settle_worker_job_claims.sql` as a second command with a fresh statement snapshot before committing. A final business transaction locks the same worker row before writing its completion marker: if it already owns the row, candidate selection skips it; if selection wins, old business CAS fails; if its marker committed earlier, the second command sees it. A directed test starts candidate selection while the business transaction holds the row, commits the marker, releases, and proves the first call skipped while the next call recovers succeeded—never dead/reclaimed. The settle command receives the locked UUID array three times plus worker ID and cannot act on an unlocked row. `claim_outbox_event.sql` remains its separate unpublished-row claimant. `migrate.ts` checks migrations transactionally.

`worker_job.correlation_id` is the durable source for the frozen WorkerJob ABI and OpenTelemetry parent link. Event-derived enqueues must copy the canonical `room_event.correlation_id`; HTTP/service enqueues copy the server request correlation; scheduler-only jobs derive or generate one at enqueue and retain it across every retry. The database default exists for source-less probes/maintenance and guarantees no claimed row lacks a value; production repositories may not replace a known upstream correlation with a fresh default. `claim_generation` and per-claim `claim_token` are different: each claim/reclaim creates a new fencing identity without changing correlation. `RETURNING j.*` gives `JobStore` both authorities.

Room serialization has one database-owned key derivation and three canonical SQL files:

```sql
-- lock_room_xact.sql
SELECT pg_advisory_xact_lock(learning_orbit_room_lock_key($1::uuid));
-- lock_room_session.sql
SELECT pg_advisory_lock(learning_orbit_room_lock_key($1::uuid));
-- unlock_room_session.sql
SELECT pg_advisory_unlock(learning_orbit_room_lock_key($1::uuid));
```

`room-lock.ts` exposes `lockRoomInTransaction(tx,roomId)` and `withRoomSessionLock(pool,roomId,fn)`. The latter checks out one dedicated connection, acquires the session lock, runs bounded work on that same connection, and unlocks in `finally`; a false unlock result poisons/discards the connection and fails closed. No language computes or caches an advisory key. The global room-scoped lock order is: canonical room advisory lock → `classroom_room FOR UPDATE` → family domain rows in documented primary-key order → exact `worker_job FOR UPDATE` → mutation/marker. Candidate claiming locks only `worker_job` and never acquires a room/domain lock. Every later room service, `RoomEventRepository.transact`, media grant/finalize, analytics replay, Agent/provider-open/finalization, retention and deletion imports these SQL files or `room-lock.ts`; an independently named advisory lock is forbidden. `room-lock.test.ts` opens competing Node transactions/connections and proves same-room blocking, different-room independence, xact release, session `finally` release and the two lock-order races without deadlock.

Create one canonical TypeScript owner for claim fencing and completion markers before any internal route exists:

```ts
// apps/server/src/modules/jobs/job-claim-authority.ts
import type { PoolClient } from "pg";

export type JobClaimIdentity = Readonly<{
  jobId: string; jobType: string; roomId: string | null;
  sourceEventId: string | null; dedupeKey: string; correlationId: string;
  claimGeneration: string; claimToken: string; workerId: string;
}>;

export class JobClaimAuthority {
  async requireCurrent(tx: PoolClient, claim: JobClaimIdentity): Promise<void> {
    const result = await tx.query(
      `SELECT 1 FROM worker_job WHERE job_id=$1 AND job_type=$2
       AND room_id IS NOT DISTINCT FROM $3::uuid
       AND source_event_id IS NOT DISTINCT FROM $4::uuid
       AND dedupe_key=$5 AND correlation_id=$6::uuid
       AND claim_generation=$7::bigint AND claim_token=$8::uuid
       AND locked_by=$9 AND status='running' FOR UPDATE`,
      [claim.jobId,claim.jobType,claim.roomId,claim.sourceEventId,claim.dedupeKey,
       claim.correlationId,claim.claimGeneration,claim.claimToken,claim.workerId]
    );
    if (result.rowCount !== 1) throw new Error("JOB_CLAIM_STALE");
  }

  async completeBusiness(
    tx: PoolClient, claim: JobClaimIdentity, completionCode: string
  ): Promise<void> {
    if (!/^[A-Z0-9_]{1,64}$/.test(completionCode))
      throw new Error("JOB_COMPLETION_CODE_INVALID");
    await this.requireCurrent(tx, claim);
    await tx.query(
      `INSERT INTO worker_job_completion(
         job_id,claim_generation,claim_token_hash,completion_code
       ) VALUES($1,$2::bigint,encode(digest($3::text,'sha256'),'hex'),$4)
       ON CONFLICT (job_id,claim_generation) DO NOTHING`,
      [claim.jobId,claim.claimGeneration,claim.claimToken,completionCode]
    );
    const marker = await tx.query(
      `SELECT claim_token_hash,completion_code FROM worker_job_completion
       WHERE job_id=$1 AND claim_generation=$2::bigint FOR UPDATE`,
      [claim.jobId,claim.claimGeneration]
    );
    const expected = await tx.query(
      `SELECT encode(digest($1::text,'sha256'),'hex') AS token_hash`,
      [claim.claimToken]
    );
    if (marker.rowCount !== 1 || marker.rows[0].claim_token_hash !== expected.rows[0].token_hash ||
        marker.rows[0].completion_code !== completionCode)
      throw new Error("JOB_COMPLETION_CONFLICT");
  }
}
```

Every TypeScript internal business route receives this singleton through application composition; media, analytics, Agent and lifecycle modules may not duplicate its SQL. Room-scoped business transactions acquire the canonical advisory lock, lock the room and family rows, then call `requireCurrent`, mutate those already-locked rows, and call `completeBusiness` in that same transaction. The claimant itself locks only `worker_job` and never waits for a room lock. A directed test covers candidate-first and business-first schedules and proves there is no deadlock or stale write. Plan 01 Task 13 implements the Python `JobClaims` equivalent for direct Worker database transactions and runs the same fixture vectors (exact tuple, stale token, duplicate same code, conflicting code and SHA-256 token hash) against this table contract.

- [ ] **Step 4: Verify green and commit**

Run: `DATABASE_URL="$LO_TEST_DB" pnpm db:migrate && TEST_DATABASE_URL="$LO_TEST_DB" pnpm --filter @learning-orbit/server test -- test/db/schema.test.ts test/db/job-claim-authority.test.ts test/db/room-lock.test.ts`

Expected: each migration once, rerun none, all tests PASS; Node callers share the database-derived room key, the TypeScript helper locks the exact current claim, hashes tokens only inside the database boundary, accepts an identical marker idempotently and rejects stale/conflicting markers.

Commit: `git add infra/docker-compose.yml infra/postgres apps/server/src/db apps/server/src/modules/jobs/job-claim-authority.ts apps/server/src/modules/rooms/room-lock.ts apps/server/test/db && git commit -m "feat(db): add canonical room locks and fenced jobs"`

### Task 4: Bootstrap Fastify and implement teacher magic-link sessions

**Files:** Create `packages/contracts/schemas/{auth-session.v1.json,auth-http.v1.json}`, `apps/server/src/{config,clock,app,main,routes,realtime}.ts`, `apps/server/src/modules/auth/`, `apps/server/src/modules/security/{service-assertion,canonical-json}.ts`, `apps/server/test/auth/{magic-link,session-bootstrap}.test.ts`, `apps/server/test/security/{origin-rate-limit,service-assertion}.test.ts`, `apps/server/test/fixtures/service-assertion-issuer.ts`, `.env.example`; modify contracts index/routes and Compose, while verifying the auto-discovery generator unchanged.

- [ ] **Step 1: Write failing auth tests**

```ts
// apps/server/test/auth/magic-link.test.ts
import{expect,it}from"vitest";import{buildApp}from"../../src/app.js";
it("hides email and consumes once",async()=>{const sent:string[]=[];const app=await buildApp({sendMagicLink:async(_,u)=>sent.push(u)}),post=(email:string)=>app.inject({method:"POST",url:"/v1/auth/teacher/magic-link",payload:{email}});const a=await post("teacher@example.edu"),b=await post("unknown@example.edu");expect([a.statusCode,b.statusCode,a.body===b.body,sent.length]).toEqual([202,202,true,1]);const token=new URL(sent[0]!).searchParams.get("token")!,url=`/v1/auth/teacher/magic-link/consume?token=${token}`,first=await app.inject({method:"GET",url});expect(first.statusCode).toBe(303);expect(first.headers.location).toBe("/teacher");expect(first.headers["set-cookie"]).toContain("HttpOnly");expect(first.headers["cache-control"]).toContain("no-store");expect(first.headers["referrer-policy"]).toBe("no-referrer");expect(first.body).not.toContain(token);expect((await app.inject({method:"GET",url})).statusCode).toBe(400);await app.close();});
```

```ts
it("bootstraps cookie identity from seeded rows",async()=>{expect(await bodies(noCookie,seededStudentCookie,teacherCookie)).toEqual([401,{role:"student",roomId,roomMemberId,actorId,pseudonym:"探索者 A",nova},{role:"teacher",teacherId,actorId:teacherId}]);});
it("closes browser origin",async()=>{expect(await originResults(noOrigin,crossOrigin)).toEqual([403,403]);});
it("freezes named rate policies before their routes exist",async()=>{expect(await policyHarness.results({magicAttempts:6,failedJoinAttempts:11,agentAttemptsForOneRoomActor:4})).toEqual({magic:429,join:429,agentTrigger:429});expect(await joinFourNormally()).toBe(true);});
```

```ts
// apps/server/test/security/service-assertion.test.ts
it("binds issuer subject audience body and the complete claim tuple",()=>{const body=autoCloseBody(currentClaim);const raw=fixtureIssuer.sign({subject:currentClaim.workerId,audience:"internal.rooms.autoClose",body,expiresInSeconds:60});expect(authorizeServiceAssertion(raw,body,{audience:"internal.rooms.autoClose",workerId:currentClaim.workerId,claim:currentClaim},trust,clock.now())).toEqual(currentClaim);for(const changed of [wrongAudience(raw),wrongSubject(raw),tamperBody(raw),expired(raw),lifetime(raw,61)])expect(()=>authorizeServiceAssertion(changed,body,{audience:"internal.rooms.autoClose",workerId:currentClaim.workerId,claim:currentClaim},trust,clock.now())).toThrow("SERVICE_ASSERTION_INVALID");});
it("has no development bypass",()=>{expect(()=>loadServiceAssertionTrust({})).toThrow("SERVICE_ASSERTION_TRUST_NOT_CONFIGURED");});
```

- [ ] **Step 2: Verify red**

Run: `TEST_DATABASE_URL="$LO_TEST_DB" pnpm --filter @learning-orbit/server test -- test/auth test/security`

Expected: FAIL: `buildApp`/auth routes absent.

- [ ] **Step 3: Implement token/session behavior**

```json
{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://learning-orbit.local/schemas/auth-session.v1.json","title":"AuthSession","oneOf":[{"type":"object","additionalProperties":false,"required":["role","roomId","roomMemberId","actorId","pseudonym","nova"],"properties":{"role":{"const":"student"},"roomId":{"type":"string","format":"uuid"},"roomMemberId":{"type":"string","format":"uuid"},"actorId":{"type":"string","format":"uuid"},"pseudonym":{"type":"string"},"nova":{"type":"object","additionalProperties":false,"required":["actorId","actorKind","actorRole","displayName"],"properties":{"actorId":{"type":"string","format":"uuid"},"actorKind":{"const":"agent"},"actorRole":{"const":"socratic_facilitator"},"displayName":{"const":"Nova Agent"}}}}},{"type":"object","additionalProperties":false,"required":["role","teacherId","actorId"],"properties":{"role":{"const":"teacher"},"teacherId":{"type":"string","format":"uuid"},"actorId":{"type":"string","format":"uuid"}}}]}
```

```json
{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://learning-orbit.local/schemas/auth-http.v1.json","title":"AuthHttpCatalog","type":"object","additionalProperties":false,"maxProperties":0,"$defs":{"TeacherMagicLinkRequest":{"type":"object","additionalProperties":false,"required":["email"],"properties":{"email":{"type":"string","format":"email","maxLength":254}}},"TeacherMagicLinkAccepted":{"type":"object","additionalProperties":false,"required":["accepted"],"properties":{"accepted":{"const":true}}}}}
```

The schema auto-discovery generator emits `auth-session.v1.ts` and `auth-http.v1.ts`; export `AuthSession`, `TeacherMagicLinkRequest` and `TeacherMagicLinkAccepted` from `src/index.ts`. In `generated-ownership.test.ts`:

```ts
import type{AuthSession,TeacherMagicLinkAccepted,TeacherMagicLinkRequest}from"../src/index.js";
it("owns auth wire types",()=>{const s=read("auth-session.v1"),h=read("auth-http.v1");expect([s.$schema,s.$id,s.title]).toEqual(["https://json-schema.org/draft/2020-12/schema",expect.any(String),"AuthSession"]);expect(s.oneOf.every((x:any)=>x.additionalProperties===false)).toBe(true);expect(Object.keys(h.$defs).sort()).toEqual(["TeacherMagicLinkAccepted","TeacherMagicLinkRequest"]);expectTypeOf<[AuthSession,TeacherMagicLinkAccepted,TeacherMagicLinkRequest]>().not.toEqualTypeOf<never>();});
```

```ts
// packages/contracts/src/routes.ts
type EventQuery={afterSeq?:number;limit?:number};const room=(id:string,s="")=>`/v1/rooms/${encodeURIComponent(id)}${s}`;
const events=(id:string,q:EventQuery={})=>{if(q.afterSeq!==undefined&&(!Number.isSafeInteger(q.afterSeq)||q.afterSeq<0))throw new RangeError("afterSeq");if(q.limit!==undefined&&(!Number.isSafeInteger(q.limit)||q.limit<1||q.limit>500))throw new RangeError("limit");const p=Object.entries(q).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);return room(id,`/events${p.length?`?${p.join("&")}`:""}`);};
export const routes={auth:{session:()=>"/v1/auth/session",teacherMagicLink:()=>"/v1/auth/teacher/magic-link"},rooms:{create:()=>"/v1/rooms",join:()=>"/v1/rooms/join",get:(id:string)=>room(id),events,websocket:(id:string)=>room(id,"/realtime"),open:(id:string)=>room(id,"/open"),pause:(id:string)=>room(id,"/pause"),resume:(id:string)=>room(id,"/resume"),close:(id:string)=>room(id,"/close")}}as const;
```

Generate/export all three auth types. The magic-link handler validates only `TeacherMagicLinkRequest` and returns only `TeacherMagicLinkAccepted`; malformed syntax receives the same bounded non-enumerating public response policy chosen by the server and never leaks an allowlist result. Cookie-only GET session is 401 or server-owned student+Nova / teacher `actorId=teacherId`. Plan 05 hydrates here after join, then opens cookie WS; no ticket.

```ts
// apps/server/src/modules/auth/crypto.ts
import{createHash,randomBytes}from"node:crypto";export const opaqueToken=()=>randomBytes(32).toString("base64url");export const tokenHash=(v:string)=>createHash("sha256").update(v).digest();
```

Create the one service-to-service assertion verifier now, before the first internal route. `canonical-json.ts` implements deterministic UTF-8 canonical JSON for the deliberately narrow assertion value domain: sorted object keys, arrays in order, strings/booleans/null and safe integers only. It rejects duplicate keys, floats (including negative zero), unsafe/non-finite numbers, binary values and prototypes, avoiding cross-language number serialization drift. The signed envelope is closed and contains `{alg:"Ed25519",keyId,issuer,subject,audience,issuedAt,expiresAt,bodySha256,signature}`. `authorizeServiceAssertion`:

1. parses the closed envelope and resolves `(issuer,keyId)` from an immutable public-key allowlist;
2. requires `alg=Ed25519`, exact audience, exact Worker subject, `issuedAt <= DB now <= expiresAt`, no more than 60 seconds of lifetime and at most the configured small clock skew;
3. recomputes SHA-256 over the canonical validated request body and compares it in constant time;
4. compares the expected `jobId,jobType,roomId,sourceEventId,dedupeKey,correlationId,claimGeneration,claimToken,workerId` with fields in that body before returning a `JobClaimIdentity`;
5. returns only the verified tuple and never logs the assertion, raw token, signature or body.

The fixture issuer generates an ephemeral Ed25519 keypair in test setup and exposes only its public key to the application. Production configuration accepts public verification keys only; it contains no test private key and has no `NODE_ENV`, localhost or missing-config bypass. Startup fails closed when the allowlist is absent. `.env.example` lists only `LO_SERVICE_ASSERTION_TRUST_FILE` and `LO_WORKER_ASSERTION_PRIVATE_KEY_FILE` variable names with external-path examples—never key material. Route code must still call the Task 3 `JobClaimAuthority` under its business transaction: a valid signature is not proof of a current lease. Later plans reuse this verifier; Plan 04 extends the same module with the separately scoped, non-job `authorizeProviderHealthAssertion`, while Plan 06 governs trust imports and rotation rather than defining either verifier for the first time.

`magic-link-service.ts` normalizes allowlisted email, stores SHA-256 token hashes, expires at 15 minutes, atomically consumes once, and creates an eight-hour hashed teacher session. Known/unknown requests share one 202 body; only SMTP receives the raw link. A successful first consume sets the secure HttpOnly cookie and returns exactly `303 Location: /teacher` with `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and no token/body echo; reuse/expiry returns the same bounded 400 recovery page without redirect.

`session-service.ts` hashes `lo_session`, reads active sessions, and returns teacher `principalId=teacherId` or the student member/actor/room/pseudonym. DELETE revokes and clears cookie; guards return only `401 AUTH_REQUIRED`/`403 FORBIDDEN`.

Register rate-limit 11.2.0. Security uses exact browser/WS Origins, explicit proxy CIDRs, and the plugin key generator; tests cover trusted/untrusted proxy and IPv6 spoofing without a second IP layer. No credential wildcard CORS. Wrong/missing Origin is 403; only signed storage PUT is cross-origin; services use separate auth. Limits: magic 5/15m, failed join 10/10m, Agent 3/min per room+actor; four seats pass.

- [ ] **Step 4: Verify green and commit**

Run: `pnpm contracts:generate && pnpm test:contracts && docker compose -f infra/docker-compose.yml up -d postgres mailpit && TEST_DATABASE_URL="$LO_TEST_DB" pnpm --filter @learning-orbit/server test -- test/auth test/security && pnpm --filter @learning-orbit/server typecheck`

Expected: PASS; auth generated types and manifest hashes are current; known/unknown match; link one-use; cookie opaque; every service-assertion field and body byte is bound, stale/wrong-scope assertions fail, and production trust cannot silently fall back to a fixture key.

Commit: `git add .env.example infra/docker-compose.yml packages/contracts apps/server/src apps/server/test/auth apps/server/test/security apps/server/test/fixtures/service-assertion-issuer.ts && git commit -m "feat(auth): add teacher sessions and service assertions"`

### Task 5: Create four pseudonymous seats and join with opaque student sessions

**Files:** Create `apps/server/src/modules/rooms/{seat-codes,room-service}.ts`, `apps/server/test/rooms/seats.test.ts`; modify `apps/server/src/{app,routes}.ts`.

- [ ] **Step 1: Write failing seat tests**

```ts
// apps/server/test/rooms/seats.test.ts
it("creates four seats and rotates a session",async()=>{const made=await createRoom("生態系統");expect(made.seatInvites.map((x:any)=>x.pseudonym)).toEqual(["探索者 A","探索者 B","探索者 C","探索者 D"]);expect(new Set(made.seatInvites.map((x:any)=>x.code)).size).toBe(4);const req={roomCode:made.room.roomCode,seatCode:made.seatInvites[0].code},a=await join(req),b=await join(req);expect(a.body).toEqual({roomMemberId:made.seatInvites[0].roomMemberId,actorId:made.seatInvites[0].actorId,pseudonym:"探索者 A"});expect([a.body.roomId,a.cookie===b.cookie,await session(a.cookie),(await session(b.cookie)).pseudonym]).toEqual([undefined,false,401,"探索者 A"]);});
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @learning-orbit/server test -- test/rooms/seats.test.ts`

Expected: FAIL: create/join absent.

- [ ] **Step 3: Implement exact seat creation and join**

```ts
// apps/server/src/modules/rooms/seat-codes.ts
import{createHmac,randomInt,timingSafeEqual}from"node:crypto";
const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const code=(length:number)=>Array.from({length},()=>chars[randomInt(chars.length)]).join("");
export const roomCode=()=>code(6);export const seatCode=()=>code(10);
export class CodeHasher{
  constructor(private readonly currentVersion:number,private readonly peppers:ReadonlyMap<number,Buffer>){if(!peppers.has(currentVersion))throw new Error("CODE_PEPPER_NOT_CONFIGURED");}
  hash(value:string){const version=Buffer.alloc(2);version.writeUInt16BE(this.currentVersion);const digest=createHmac("sha256",this.peppers.get(this.currentVersion)!).update(value.trim().toUpperCase()).digest();return Buffer.concat([version,digest]);}
  verify(value:string,stored:Buffer){if(stored.length!==34)return false;const version=stored.readUInt16BE(0),pepper=this.peppers.get(version);if(!pepper)return false;const candidate=this.hashWith(version,pepper,value);return timingSafeEqual(stored,candidate);}
  private hashWith(versionNumber:number,pepper:Buffer,value:string){const version=Buffer.alloc(2);version.writeUInt16BE(versionNumber);return Buffer.concat([version,createHmac("sha256",pepper).update(value.trim().toUpperCase()).digest()]);}
}
```

```ts
// key transaction in room-service.ts
const names=["探索者 A","探索者 B","探索者 C","探索者 D"];
return inTransaction(db,async c=>{const roomId=randomUUID(),novaActorId=randomUUID(),roomCode=makeRoomCode();await c.query("insert into classroom_room(room_id,room_code_hash,nova_actor_id,teacher_id,topic) values($1,$2,$3,$4,$5)",[roomId,codeHasher.hash(roomCode),novaActorId,teacherId,topic.trim()]);const seatInvites=[];for(const[i,pseudonym]of names.entries()){const roomMemberId=randomUUID(),actorId=randomUUID(),code=makeSeatCode();await c.query("insert into room_member(room_member_id,actor_id,room_id,seat_index,pseudonym,code_hash) values($1,$2,$3,$4,$5,$6)",[roomMemberId,actorId,roomId,i+1,pseudonym,codeHasher.hash(code)]);seatInvites.push({roomMemberId,actorId,pseudonym,code});}const nova={actorId:novaActorId,actorKind:"agent",actorRole:"socratic_facilitator",displayName:"Nova Agent"};return{room:{roomId,roomCode,status:"scheduled",durationSeconds:2700,nova},seatInvites};});
```

Routes validate generated Create/Join shapes. Create returns room+Nova/four seat codes once; join accepts only codes, locks an open seat, compares the versioned HMAC in constant time, rotates its hashed session, and returns no roomId. `ROOM_CODE_PEPPER_V1` (and any rotation key) comes from deployment secret configuration, never the database, repository, logs or client; startup fails if the active key version is absent. The stored two-byte version supports read-old/write-new rotation. Magic-link tokens remain high-entropy and may continue to use plain SHA-256 token hashing, but the enumerable room/seat codes never do. Tests prove a database-only dictionary cannot reproduce a stored hash without the deployment pepper, old/new key rotation works, malformed lengths do not reach comparison, and every bad pair has the same 403/timing envelope. Authorized GET room returns generated `RoomDetails`, including exactly four human/student participants plus room Nova.

- [ ] **Step 4: Verify green and commit**

Run: `pnpm --filter @learning-orbit/server test -- test/rooms/seats.test.ts && pnpm --filter @learning-orbit/server typecheck`

Expected: PASS; four hashes, no plaintext, global actor uniqueness, old cookie 401.

Commit: `git add apps/server/src/app.ts apps/server/src/routes.ts apps/server/src/modules/rooms apps/server/test/rooms/seats.test.ts && git commit -m "feat(rooms): add four pseudonymous seat codes"`

### Task 6: Implement the atomic RoomEvent ledger and Outbox boundary

**Files:** Create `apps/server/src/modules/rooms/{room-event-repository,errors}.ts`, `apps/server/test/rooms/ledger.test.ts`.

- [ ] **Step 1: Write failing sequence/idempotency tests**

```ts
// apps/server/test/rooms/ledger.test.ts
it("allocates monotonic roomSeq and deduplicates causation",async()=>{const first=await append(commandId,"room.opened");const duplicate=await append(commandId,"room.opened");const second=await append(randomUUID(),"room.closed");expect([first.roomSeq,duplicate.roomSeq,second.roomSeq]).toEqual([1,1,2]);expect(duplicate.eventId).toBe(first.eventId);expect((await db.query("select * from outbox_event")).rows).toHaveLength(2);});
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @learning-orbit/server test -- test/rooms/ledger.test.ts`

Expected: FAIL: `RoomEventRepository` absent.

- [ ] **Step 3: Implement one locked transaction**

```ts
// apps/server/src/modules/rooms/room-event-repository.ts
async transact<T>(roomId:string,fn:(x:Context)=>Promise<T>){return inTransaction(this.db,async c=>{await lockRoomInTransaction(c,roomId);const room=(await c.query("select * from classroom_room where room_id=$1 for update",[roomId])).rows[0];if(!room)throw new RoomError("FORBIDDEN");const append=async(d:Draft)=>{this.payloads.assert(d.type,d.payload);const old=(await c.query("select envelope from outbox_event where room_id=$1 and envelope->>'causationId'=$2",[roomId,d.causationId])).rows[0];if(old)return old.envelope;const eventId=randomUUID(),roomSeq=room.next_room_seq++,ingestTime=new Date(),e={...d,eventId,schemaVersion:1,roomId,roomSeq,eventTime:d.eventTime.toISOString(),ingestTime:ingestTime.toISOString()};await c.query("update classroom_room set next_room_seq=next_room_seq+1 where room_id=$1",[roomId]);await c.query("insert into room_event(event_id,room_id,room_seq,type,actor_id,actor_kind,actor_role,revision,operation,event_time,ingest_time,causation_id,correlation_id,payload) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",[eventId,roomId,roomSeq,d.type,d.actorId,d.actorKind,d.actorRole,d.revision,d.operation,d.eventTime,ingestTime,d.causationId,d.correlationId,d.payload]);await c.query("insert into outbox_event(event_id,room_id,room_seq,envelope) values($1,$2,$3,$4)",[eventId,roomId,roomSeq,e]);return e;};return fn({client:c,room,append});});}
```

`lockRoomInTransaction` is the Task 3 canonical SQL-backed helper and is always called before the room row. Errors are `FORBIDDEN|INVALID_COMMAND|ROOM_NOT_OPEN|MESSAGE_NOT_FOUND|REVISION_CONFLICT`. App injects the core registry. `eventsAfter` reads ordered envelopes; causation lookup uses its unique column.

- [ ] **Step 4: Verify green and commit**

Run: `pnpm --filter @learning-orbit/server test -- test/rooms/ledger.test.ts && pnpm --filter @learning-orbit/server typecheck`

Expected: PASS; contiguous sequence, duplicate adds no row.

Commit: `git add apps/server/src/modules/rooms apps/server/test/rooms/ledger.test.ts && git commit -m "feat(events): add atomic ledger and outbox"`

### Task 7: Enforce the 45-minute room lifecycle

**Files:** Create `packages/contracts/schemas/room-internal-auto-close.v1.json`, `apps/server/src/modules/rooms/{lifecycle-service,internal-auto-close-route}.ts`, `apps/server/test/rooms/{lifecycle,auto-close-enqueue,auto-close-internal}.test.ts`; modify `packages/contracts/src/index.ts`, `apps/server/src/{app,routes}.ts`; reuse without copying `apps/server/src/modules/security/service-assertion.ts`, `apps/server/src/modules/jobs/job-claim-authority.ts`, and `apps/server/src/modules/rooms/room-lock.ts`.

- [ ] **Step 1: Write failing deterministic-clock tests**

```ts
// apps/server/test/rooms/lifecycle.test.ts
it("pauses without extending",async()=>{clock.set("2026-08-28T09:00:00Z");expect((await open(roomId)).closesAt).toContain("09:45:00");const p=await pause(roomId,id);expect((await pause(roomId,id)).eventId).toBe(p.eventId);expect((await studentMessage(roomId)).code).toBe("ROOM_NOT_OPEN");await resume(roomId);clock.set("2026-08-28T09:45:00Z");expect([(await getRoom(roomId)).status,await eventTypes(roomId)]).toEqual(["closed",["room.opened","room.paused","room.resumed","room.closed"]]);});
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @learning-orbit/server test -- test/rooms/lifecycle.test.ts`

Expected: FAIL: lifecycle commands absent.

- [ ] **Step 3: Implement lifecycle transactions**

```ts
// core of lifecycle-service.ts
async open(roomId:string,teacherId:string,commandId:string,now:Date){return ledger.transact(roomId,async x=>{if(x.room.teacher_id!==teacherId)throw forbidden();if(x.room.status!=="scheduled")return x.findByCausation(commandId);const closes=new Date(now.getTime()+2_700_000);await x.client.query("update classroom_room set status='open',starts_at=$2,closes_at=$3 where room_id=$1",[roomId,now,closes]);const event=await x.append({causationId:commandId,correlationId:randomUUID(),type:"room.opened",actorId:teacherId,actorKind:"human",actorRole:"teacher",revision:1,operation:"add",eventTime:now,payload:{startsAt:now.toISOString(),closesAt:closes.toISOString()}});return{event,closesAt:closes.toISOString()};});}
```

The open transaction also inserts exactly one raw `worker_job`: `job_type='room.auto-close.v1'`, `room_id=roomId`, `source_event_id=room.opened.eventId`, closed payload `{roomId,closesAt}`, dedupe `room.auto-close.v1:{roomId}`, correlation equal to that canonical opened event, `run_after=closes_at`, queued status and (after Plan 03) NULL analytics-order fields. Only the owner drives manual transitions; causation dedupes races. Pause/resume do not change `closes_at`.

```json
{"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://learning-orbit.local/schemas/room-internal-auto-close.v1.json","title":"RoomInternalAutoCloseContract","x-learning-orbit-python-ingress":true,"type":"object","additionalProperties":false,"maxProperties":0,"$defs":{"Request":{"type":"object","additionalProperties":false,"required":["jobId","jobType","roomId","sourceEventId","dedupeKey","correlationId","claimGeneration","claimToken","workerId","closesAt"],"properties":{"jobId":{"type":"string","format":"uuid"},"jobType":{"const":"room.auto-close.v1"},"roomId":{"type":"string","format":"uuid"},"sourceEventId":{"type":"string","format":"uuid"},"dedupeKey":{"type":"string","pattern":"^room\\.auto-close\\.v1:[0-9a-f-]{36}$"},"correlationId":{"type":"string","format":"uuid"},"claimGeneration":{"type":"string","pattern":"^[1-9][0-9]{0,18}$"},"claimToken":{"type":"string","format":"uuid"},"workerId":{"type":"string","minLength":1,"maxLength":128},"closesAt":{"type":"string","format":"date-time"}}},"Response":{"oneOf":[{"type":"object","additionalProperties":false,"required":["status","code"],"properties":{"status":{"const":"completed"},"code":{"enum":["ROOM_CLOSED","ALREADY_CLOSED"]}}},{"type":"object","additionalProperties":false,"required":["status","code"],"properties":{"status":{"const":"retryable"},"code":{"const":"ROOM_CLOSE_NOT_DUE"}}},{"type":"object","additionalProperties":false,"required":["status","code"],"properties":{"status":{"const":"rejected"},"code":{"enum":["SERVICE_ASSERTION_INVALID","JOB_CLAIM_STALE","JOB_FAMILY_IDENTITY_INVALID","ROOM_DELETION_IN_PROGRESS"]}}}]}}}
```

`room-internal-auto-close.v1.json` freezes a closed claim-bound request and generated completed/retryable/rejected response union. The route is registered as `internal.rooms.autoClose`. It calls Plan 01's canonical `authorizeServiceAssertion`, then takes the room lock, validates the complete raw job family identity and calls the injected singleton `JobClaimAuthority.requireCurrent`; neither helper nor its SQL may be copied into the room module. Not-due writes no completion. Both close and already-closed terminal branches atomically call `JobClaimAuthority.completeBusiness(...,"ROOM_AUTO_CLOSE_COMPLETED")`; their response codes remain `ROOM_CLOSED` versus `ALREADY_CLOSED`. Response loss at maximum attempt therefore recovers succeeded without rerunning the handler. Other cancelled jobs have all lease fields cleared, while this claim remains running for the wrapper. Forged/stale tests write nothing; kill-after-marker tests require one close event and automatic recovery.

- [ ] **Step 4: Verify green and commit**

Run: `pnpm contracts:generate && pnpm test:contracts && pnpm --filter @learning-orbit/server test -- test/rooms/lifecycle.test.ts test/rooms/auto-close-enqueue.test.ts test/rooms/auto-close-internal.test.ts`

Expected: PASS; the transaction creates one deduplicated due job, direct signed-route retries create no second close, and no test requires a not-yet-built Worker.

Commit: `git add packages/contracts apps/server/src/app.ts apps/server/src/routes.ts apps/server/src/modules/rooms apps/server/test/rooms/lifecycle.test.ts apps/server/test/rooms/auto-close-enqueue.test.ts apps/server/test/rooms/auto-close-internal.test.ts && git commit -m "feat(rooms): enforce forty-five-minute lifecycle"`

### Task 8: Accept text, reply, and mention commands through one service

**Files:** Create `apps/server/src/modules/rooms/{message-service,command-service,attachment-validator}.ts`, `apps/server/test/rooms/message-add.test.ts`; modify `apps/server/src/{app,routes}.ts`.

- [ ] **Step 1: Write failing message command tests**

```ts
// apps/server/test/rooms/message-add.test.ts
it("stores text/reply/mention",async()=>{const x=await add(a,{text:"能量來自太陽",mentions:[]}),y=await add(b,{text:"@A 同意",replyTo:x.payload.messageId,mentions:[a.actorId]});expect(y.payload).toMatchObject({replyTo:x.payload.messageId,mentions:[a.actorId],mediaIds:[]});});
it("rejects cross-room mention",async()=>{const n=await eventCount(roomId);expect((await add(a,{text:"x",mentions:[otherRoomSeat]})).code).toBe("INVALID_COMMAND");expect(await eventCount(roomId)).toBe(n);});
it("allows only this room's Nova",async()=>{expect((await add(a,"@Nova",[room.novaActorId])).type).toBe("message.added");expect((await add(a,"cross",[otherRoom.novaActorId])).code).toBe("INVALID_COMMAND");expect((await rawCommand(a,{actorId:room.novaActorId,payload:{text:"forge",mentions:[]}})).code).toBe("INVALID_COMMAND");});
it("fails media/teacher add closed",async()=>{const n=await eventCount(roomId);expect([(await add(a,{mentions:[],mediaIds:[mediaId]})).code,(await add(teacher,{text:"x",mentions:[]})).code]).toEqual(["INVALID_COMMAND","FORBIDDEN"]);expect(await eventCount(roomId)).toBe(n);});
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @learning-orbit/server test -- test/rooms/message-add.test.ts`

Expected: FAIL: `MessageService`/route absent.

- [ ] **Step 3: Implement validated add semantics**

```ts
// core of apps/server/src/modules/rooms/message-service.ts
async add(p:Principal,c:RoomCommand){const{text="",replyTo=null,mentions,mediaIds=[]}=c.payload as AddPayload,clean=text.trim();if(p.kind!=="student")throw forbidden();if(!clean&&!mediaIds.length)throw invalid();return this.ledger.transact(c.roomId,async x=>{this.authorize(x.room,p);if(x.room.status!=="open"||x.room.closes_at<=this.clock.now())throw notOpen();if(replyTo&&!await existsActiveMessage(x.client,c.roomId,replyTo))throw invalid();const q=await x.client.query("select actor_id from room_member where room_id=$1 union all select nova_actor_id from classroom_room where room_id=$1",[c.roomId]),allowed=new Set(q.rows.map(r=>r.actor_id));if(mentions.some(id=>!allowed.has(id)))throw invalid();await this.attachments.assertAttachable(x.client,p,c.roomId,mediaIds);return x.append({causationId:c.commandId,correlationId:randomUUID(),type:"message.added",actorId:p.principalId,actorKind:"human",actorRole:p.kind,revision:1,operation:"add",eventTime:new Date(c.clientTime),payload:{messageId:randomUUID(),text:clean,replyTo,mentions,mediaIds}});});}
const existsActiveMessage=async(c:PoolClient,roomId:string,id:string)=>{const row=(await c.query("select operation from room_event where room_id=$1 and payload->>'messageId'=$2 order by revision desc limit 1",[roomId,id])).rows[0];return !!row&&row.operation!=="retract";};
```

Command service Ajv-validates and maps stable errors. Its default `AttachmentValidator` accepts only `[]`; Plan 02 injects a transaction-aware same-room/owner/state validator. Authenticated POST commands returns closed ack/reject frames; `routes.ts` is sole aggregator.

- [ ] **Step 4: Verify green and commit**

Run: `pnpm --filter @learning-orbit/server test -- test/rooms/message-add.test.ts && pnpm --filter @learning-orbit/server typecheck`

Expected: PASS; refs room-local; invalid commands append nothing.

Commit: `git add apps/server/src/app.ts apps/server/src/routes.ts apps/server/src/modules/rooms apps/server/test/rooms/message-add.test.ts && git commit -m "feat(chat): add text reply and mention commands"`

### Task 9: Add optimistic revise and retract events

**Files:** Modify `apps/server/src/modules/rooms/message-service.ts`; create `apps/server/test/rooms/message-revision.test.ts`.

- [ ] **Step 1: Write failing ownership and conflict tests**

```ts
// apps/server/test/rooms/message-revision.test.ts
it("revises by owner/revision",async()=>{const m=await add(a,"原文"),r=await revise(a,m.messageId,1,"修正");expect(r).toMatchObject({type:"message.revised",revision:2});expect(await revise(a,m.messageId,1,"衝突")).toMatchObject({code:"REVISION_CONFLICT",currentRevision:2});expect((await revise(teacher,m.messageId,2,"改寫")).code).toBe("FORBIDDEN");expect((await retract(a,m.messageId,2)).type).toBe("message.retracted");});
it("lets only owner teacher retract",async()=>{const m=await add(a,"原文"),old=await add(b,{text:"reply",replyTo:m.messageId,mentions:[]});expect([(await retract(b,m.messageId,1)).code,(await retract(otherTeacher,m.messageId,1)).code]).toEqual(["FORBIDDEN","FORBIDDEN"]);const r=await retract(teacher,m.messageId,1);expect(r).toMatchObject({type:"message.retracted",actorId:teacherId,actorRole:"teacher"});expect((await add(b,{text:"new",replyTo:m.messageId,mentions:[]})).code).toBe("INVALID_COMMAND");expect(await eventById(old.eventId)).toBeTruthy();});
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @learning-orbit/server test -- test/rooms/message-revision.test.ts`

Expected: FAIL: revise/retract absent.

- [ ] **Step 3: Implement append-only revision checks**

```ts
// shared revise/retract core in message-service.ts
async mutate(p:Principal,c:RoomCommand,kind:"revise"|"retract"){return this.ledger.transact(c.roomId,async x=>{this.authorize(x.room,p);if(x.room.status!=="open")throw notOpen();const id=String(c.payload.messageId),prior=(await x.client.query("select actor_id,revision,operation,payload from room_event where room_id=$1 and payload->>'messageId'=$2 order by revision desc limit 1",[c.roomId,id])).rows[0];if(!prior||prior.operation==='retract')throw missing();if(p.kind==="teacher"&&kind!=="retract"||p.kind==="student"&&prior.actor_id!==p.principalId)throw forbidden();if(prior.revision!==c.baseRevision)throw conflict(prior.revision);const revision=prior.revision+1,payload=kind==='revise'?{messageId:id,text:String(c.payload.text).trim(),mentions:c.payload.mentions??[],replyTo:prior.payload.replyTo,mediaIds:prior.payload.mediaIds??[]}:{messageId:id},type=kind==="revise"?"message.revised":"message.retracted";return x.append({causationId:c.commandId,correlationId:randomUUID(),type,actorId:p.principalId,actorKind:"human",actorRole:p.kind,revision,operation:kind,eventTime:new Date(c.clientTime),payload});});}
```

Students revise/retract self; owner teacher retracts any but never adds/revises. Event actor is moderator; original/replies remain audit-only. Revise copies prior media IDs; reads select latest.

- [ ] **Step 4: Verify green and commit**

Run: `pnpm --filter @learning-orbit/server test -- test/rooms/message-revision.test.ts test/rooms/message-add.test.ts`

Expected: PASS; conflict exposes only `currentRevision`.

Commit: `git add apps/server/src/modules/rooms/message-service.ts apps/server/test/rooms/message-revision.test.ts && git commit -m "feat(chat): append revise and retract events"`

### Task 10: Implement WebSocket commands, ephemeral collaboration signals, degraded state, and heartbeat

**Files:** Create `apps/server/src/modules/realtime/{room-hub,connection,ephemeral-signals,realtime-delivery-authorizer}.ts`, `apps/server/src/realtime.ts`, `apps/server/test/realtime/{protocol,ephemeral-signals}.test.ts`; modify `apps/server/src/app.ts`.

- [ ] **Step 1: Write a failing live-socket protocol test**

```ts
// apps/server/test/realtime/protocol.test.ts
it("hellos, acks, heartbeats",async()=>{const ws=await connect(studentCookie,roomId);send(ws,{type:"hello",resumeFrom:0});expect(await types(ws,2)).toEqual(["welcome","resume_complete"]);send(ws,{type:"command",command:addCommand(roomId,"測試")});expect(await next(ws)).toMatchObject({type:"ack",roomSeq:2,revision:1});expect((await eventually(ws,"heartbeat")).type).toBe("heartbeat");ws.close();});
it("keeps presence typing and degraded frames ephemeral",async()=>{const [a,b]=await connectPair(roomId);send(a,{type:"presence",state:"active",clientSeq:1});send(a,{type:"typing",active:true,clientSeq:2});expect(await nextTypes(b,2)).toEqual(["presence","typing"]);expect(await latestFrames(b)).toMatchObject([{actorId:actorA},{actorId:actorA,active:true}]);await clock.advance(5_001);expect(await eventually(b,"typing")).toMatchObject({active:false});expect(await roomEventTypes(roomId)).not.toContain(expect.stringMatching(/presence|typing|degraded/));});
it("reauthorizes an established socket before every durable frame",async()=>{const ws=await connectAndHello(studentCookie,roomId);expect(await initialTypes(ws)).toEqual(["welcome","resume_complete"]);await revokeSession(studentCookie);await hub.broadcastAuthorized(roomId,{type:"event",event:fixtureEvent});expect(await eventFrames(ws,fixtureEvent.eventId)).toEqual([]);expect(await closeCode(ws)).toBe(4401);});
it("closes an established removed membership with 4403 before delivery",async()=>{const ws=await connectAndHello(studentCookie,roomId);await removeMembership(studentCookie);await hub.broadcastAuthorized(roomId,{type:"event",event:fixtureEvent});expect(await eventFrames(ws,fixtureEvent.eventId)).toEqual([]);expect(await closeCode(ws)).toBe(4403);});
it.each(["command","presence","typing","heartbeat"] as const)("rejects revoked session before inbound %s",async(type)=>{const ws=await connectAndHello(studentCookie,roomId),before=await roomEventCount(roomId);await revokeSession(studentCookie);send(ws,inboundFixture(type));expect(await closeCode(ws)).toBe(4401);expect(await roomEventCount(roomId)).toBe(before);expect(await ephemeralMutationCount(roomId)).toBe(0);});
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @learning-orbit/server test -- test/realtime/protocol.test.ts`

Expected: FAIL with WebSocket HTTP `404`.

- [ ] **Step 3: Implement the protocol state machine**

`RoomHub` owns `Map<roomId, Map<WebSocket, ConnectionIdentity>>`, where identity contains only the durable server session ID, principal kind/ID and room membership ID captured at upgrade. `join()` returns an idempotent leave closure. `broadcastAuthorized()` re-reads current session, membership and room access through `RealtimeDeliveryAuthorizer` immediately before every durable core event frame; an expired/revoked connection closes 4401, a removed membership closes 4403, and a deleting room closes 4410, always before any frame. Authorization may be batch-read per room/frame but may not be cached across a commit or heartbeat. `evictRoom(roomId,4410)` closes/removes every connection idempotently. Ephemeral presence/typing uses the same current connection set and cannot keep a revoked socket alive.

```ts
socket.on("message",raw=>onFrame(JSON.parse(raw.toString()),{socket,connectionIdentity,roomId,commands,hub,deliveryAuthorizer}));
```

`onFrame` requires hello first, then before every heartbeat/command/presence/typing it calls `deliveryAuthorizer.reauthorize(connectionIdentity.sessionId, roomId)` and derives a fresh principal; it never reuses the upgrade-time principal. Expired/revoked closes 4401, removed membership 4403 and closed/deleting room 4410 before mutation. Commands pass the session ID into `CommandService`, whose room-locked write transaction rechecks current session/membership/room state again; this closes reauthorize→revoke→commit TOCTOU. Resume before hub and each replay page also reauthorize. Ack/reject is exact; malformed/order closes 4400. Presence is limited to one update per five seconds and expires to `unknown` after 30 seconds; typing is limited to two updates per second, expires to `false` after five seconds, and disconnect cleanup broadcasts the expired state. `clientSeq` is monotonic per connection and suppresses stale signal updates. The server derives actor identity from the current authenticated membership, never accepts an actor field, never persists these signals, and does not replay them after reconnect. Operational adapters may emit only the generated content-free `degraded` branch. Unit-test every branch, rate limit, TTL, disconnect and absence from `room_event`/`outbox_event`.

Realtime is cookie-only/no-ticket, requires hello in 5s, heartbeats at 15s, clears resources, caps 16 KiB, and rejects client actor fields. Upgrade authorization is not treated as a perpetual delivery grant: session revocation applies to the next frame/heartbeat. Ephemeral signals are optional affordances: absence or expiry means “unknown”, never “offline”, and the UI must not turn them into a claimed real online count.

- [ ] **Step 4: Verify green and commit**

Run: `pnpm --filter @learning-orbit/server test -- test/realtime/protocol.test.ts test/realtime/ephemeral-signals.test.ts && pnpm --filter @learning-orbit/server typecheck`

Expected: PASS; unauthorized 401; pre-hello closes 4400; stale/rate-excess signals are ignored or rejected without ledger writes; TTL/disconnect cleanup is deterministic.

Commit: `git add apps/server/src/app.ts apps/server/src/realtime.ts apps/server/src/modules/realtime apps/server/test/realtime/protocol.test.ts apps/server/test/realtime/ephemeral-signals.test.ts && git commit -m "feat(realtime): add authenticated websocket protocol"`

### Task 11: Publish Outbox events and resume missed sequences

**Files:** Create `apps/server/src/modules/realtime/outbox-publisher.ts`, `apps/server/test/realtime/resume.test.ts`; modify `apps/server/src/{app,realtime,routes}.ts`.

- [ ] **Step 1: Write failing reconnect tests**

```ts
// apps/server/test/realtime/resume.test.ts
it("replays gap once",async()=>{await sendThreeEvents();const ws=await hello(cookie,roomId,2);expect(await seqsUntilResume(ws)).toEqual([3,4]);await unlockPublishedEvent(4);await pumpOnce();expect((await collect(ws,100)).filter(x=>x.event?.eventId===event4)).toHaveLength(1);});
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @learning-orbit/server test -- test/realtime/resume.test.ts`

Expected: FAIL: resume/publisher absent.

- [ ] **Step 3: Implement durable replay and publisher acknowledgment**

```ts
// core of outbox-publisher.ts
async tick(){for(const row of await claim(this.db,100,this.workerId)){try{await this.hub.broadcastAuthorized(row.room_id,{type:"event",event:row.envelope});await markPublished(this.db,row.outbox_id);}catch(error){await retryLater(this.db,row.outbox_id,String(error));}}}
```

Publish marks success or bounded retry. A frame delivered to zero currently authorized sockets may still mark the durable outbox row published; future replay remains governed by the current read guard. Hello joins before ordered replay and suppresses live rows through snapshot seq; ≤500 sends welcome/events/resume_complete, otherwise snapshot_required/4409. Both replay and live delivery reauthorize; an expired/revoked session between replay page reads closes 4401, removed membership closes 4403, and room deletion closes 4410 before the next frame. Authorized `routes.rooms.events(id,{afterSeq,limit})` returns generated `{events,throughRoomSeq,nextAfterSeq?}`, stable ascending, cap 500.

- [ ] **Step 4: Verify green and commit**

Run: `pnpm --filter @learning-orbit/server test -- test/realtime/resume.test.ts test/realtime/protocol.test.ts`

Expected: PASS; gap exact; stale locks recover.

Commit: `git add apps/server/src apps/server/test/realtime/resume.test.ts && git commit -m "feat(realtime): publish outbox and resume gaps"`

### Task 12: Build the reconnecting Next.js room client

**Files:** Create `apps/web/src/lib/realtime/room-socket.ts`, `apps/web/test/room-socket.test.ts`, `apps/web/app/rooms/[roomId]/{page,room-client}.tsx`.

- [ ] **Step 1: Write failing cursor, retry, and dedupe tests**

```ts
// apps/web/test/room-socket.test.ts
it("resumes/resends/dedupes",()=>{const sink=vi.fn(),c=clientAt(7,sink),ws=fakeSocket();c.send(command("fixed"),ws);c.onFrame({type:"resume_complete"},ws);c.onFrame(eventFrame(eventId,8),ws);c.onFrame(eventFrame(eventId,8),ws);expect([c.hello().resumeFrom,sentCommandIds(ws),sink.mock.calls.length]).toEqual([8,["fixed","fixed"],1]);});
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @learning-orbit/web test -- test/room-socket.test.ts`

Expected: FAIL: `RoomSocket` absent.

- [ ] **Step 3: Implement resumable client state**

```ts
// apps/web/src/lib/realtime/room-socket.ts
import type{RoomCommand,RoomEventEnvelope}from"@learning-orbit/contracts";
export class RoomSocket{private pending=new Map<string,RoomCommand>();private seen=new Set<string>();lastRoomSeq:number;constructor(private id:string,private storage:Storage,private sink:(e:RoomEventEnvelope)=>void){this.lastRoomSeq=Number(storage.getItem(`lo:${id}:seq`)??0);}hello(){return{type:"hello",resumeFrom:this.lastRoomSeq};}send(c:RoomCommand,ws:WebSocket){this.pending.set(c.commandId,c);ws.send(JSON.stringify({type:"command",command:c}));}onFrame(f:any,ws:WebSocket){if(f.type==="resume_complete")for(const c of this.pending.values())this.send(c,ws);if(f.type==="ack"||(f.type==="reject"&&!f.retryable))this.pending.delete(f.commandId);if(f.type==="event"&&!this.seen.has(f.event.eventId)&&f.event.roomSeq>this.lastRoomSeq){this.seen.add(f.event.eventId);this.storage.setItem(`lo:${this.id}:seq`,String(this.lastRoomSeq=f.event.roomSeq));this.sink(f.event);}}}
```

Wrapper sends hello, answers heartbeat, retries at 0.5/1/2/4/8 seconds, and preserves pending command IDs. UI renders canonical reply/mention/revision/retraction/pending and an `aria-live` reject region; demo HTML stays unchanged.

- [ ] **Step 4: Verify green and commit**

Run: `pnpm --filter @learning-orbit/web test -- test/room-socket.test.ts && pnpm --filter @learning-orbit/web typecheck && pnpm --filter @learning-orbit/web build`

Expected: reconnect/typecheck/build PASS.

Commit: `git add apps/web && git commit -m "feat(web): add resumable room client"`

### Task 13: Implement the Python 3.12 durable job runner with stdlib tests

**Files:** Create `services/worker/src/learning_orbit_worker/{__init__,jobs,room_lock,service_assertion,internal_http,handler_registry,core_handlers,main}.py`, `services/worker/tests/{worker_fixtures,test_jobs,test_worker_lease,test_job_claim_parity,test_room_lock_parity,test_service_assertion,test_internal_http,test_handler_registry,test_auto_close_handler}.py`, `apps/server/test/rooms/auto-close-restart.test.ts`; modify `services/worker/{pyproject.toml,requirements.lock}` for package discovery and the already-declared locked `cryptography==50.0.1` dependency.

- [ ] **Step 1: Write the failing stdlib `unittest` integration test**

```python
# services/worker/tests/test_jobs.py
import os,unittest,uuid,psycopg
from learning_orbit_worker.jobs import CompletionMissing, JobStore, StaleClaim
from tests.worker_fixtures import handler_dispatch_count, insert_old_completion_hash, job_status, race_candidate_lock_with_completion, record_fixture_completion, seed_claimed_job
class JobStoreTest(unittest.TestCase):
    def setUp(self): self.connection=psycopg.connect(os.environ["TEST_DATABASE_URL"],autocommit=True);self.connection.execute("TRUNCATE worker_job CASCADE")
    def tearDown(self): self.connection.close()
    def test_claim_success_and_dedupe(self):
        key=f"probe:{uuid.uuid4()}";self.connection.execute("INSERT INTO worker_job(job_type,dedupe_key,payload) VALUES('probe.v1',%s,'{}')",(key,));store=JobStore(self.connection,"worker-a");job=store.claim(1)[0];self.assertIsNotNone(job["correlation_id"]);self.assertIsNotNone(job["claim_token"]);self.assertEqual(job["claim_generation"],1);self.assertEqual(job["locked_by"],"worker-a");self.assertEqual(store.claim(1),[]);record_fixture_completion(self.connection,job);store.succeed(job);self.assertEqual(self.connection.execute("SELECT status FROM worker_job WHERE dedupe_key=%s",(key,)).fetchone()[0],"succeeded")
        self.assertRaisesRegex(ValueError,"WORKER_CLAIM_SIZE_MUST_BE_ONE",lambda:store.claim(2))
    def test_stale_running_claim_is_fenced_from_late_success(self):
        key=f"stale:{uuid.uuid4()}";self.connection.execute("INSERT INTO worker_job(job_type,dedupe_key,payload) VALUES('probe.v1',%s,'{}')",(key,));a=JobStore(self.connection,"worker-a");first=a.claim(1)[0];self.connection.execute("UPDATE worker_job SET locked_at=now()-interval '3 minutes' WHERE job_id=%s",(first["job_id"],));b=JobStore(self.connection,"worker-b");second=b.claim(1)[0];self.assertNotEqual(first["claim_token"],second["claim_token"]);self.assertEqual(second["claim_generation"],first["claim_generation"]+1);self.assertRaises(StaleClaim,lambda:a.succeed(first));record_fixture_completion(self.connection,second);b.succeed(second)
    def test_stale_max_attempt_with_business_receipt_recovers_without_dispatch(self):
        job=seed_claimed_job(self.connection,attempts=5,max_attempts=5,locked_minutes_ago=3);record_fixture_completion(self.connection,job);claimed=JobStore(self.connection,"worker-b").claim(1);self.assertEqual(claimed,[]);self.assertEqual(job_status(self.connection,job["job_id"]),"succeeded");self.assertEqual(handler_dispatch_count(job["job_id"]),0)
    def test_success_requires_matching_completion_receipt(self):
        job=seed_claimed_job(self.connection,attempts=1,max_attempts=5);store=JobStore(self.connection,job["locked_by"]);self.assertRaises(CompletionMissing,lambda:store.succeed(job));record_fixture_completion(self.connection,job);store.succeed(job);self.assertEqual(job_status(self.connection,job["job_id"]),"succeeded")
    def test_old_generation_receipt_cannot_recover_new_claim(self):
        first=seed_claimed_job(self.connection,attempts=1,max_attempts=5,locked_minutes_ago=3);second=JobStore(self.connection,"worker-b").claim(1)[0];insert_old_completion_hash(self.connection,first,"FORGED_OLD");self.connection.execute("UPDATE worker_job SET locked_at=now()-interval '3 minutes' WHERE job_id=%s",(second["job_id"],));third=JobStore(self.connection,"worker-c").claim(1)[0];self.assertGreater(third["claim_generation"],second["claim_generation"]);self.assertEqual(job_status(self.connection,third["job_id"]),"running")
    def test_completion_and_candidate_lock_are_linearizable_in_both_orders(self):
        for winner in ("business_first","claim_first"):
            result=race_candidate_lock_with_completion(self.connection,winner);self.assertTrue(result.old_business_xor_new_claim);self.assertNotEqual(result.final_status,"dead");self.assertLessEqual(result.business_commit_count,1)
    def test_postcommit_exception_cannot_turn_marker_into_retry(self):
        job=seed_claimed_job(self.connection,attempts=5,max_attempts=5);record_fixture_completion(self.connection,job);JobStore(self.connection,job["locked_by"]).fail(job,RuntimeError("broadcast failed"));self.assertEqual(job_status(self.connection,job["job_id"]),"succeeded")
    def test_heartbeat_prevents_reclaim_and_exhausted_stale_job_becomes_dead(self):
        fresh=seed_claimed_job(self.connection,attempts=1,max_attempts=2);store=JobStore(self.connection,"worker-a");store.heartbeat(fresh);self.assertEqual(JobStore(self.connection,"worker-b").claim(1),[]);expired=seed_claimed_job(self.connection,attempts=2,max_attempts=2,locked_minutes_ago=3);store.claim(1);self.assertEqual(job_status(self.connection,expired["job_id"]),"dead")
if __name__=="__main__": unittest.main()
```

- [ ] **Step 2: Verify red**

Run: `cd learning-orbit && .venv/bin/python -m pip install --no-deps -e services/worker && node scripts/verify-python-lock.mjs && TEST_DATABASE_URL="$LO_TEST_DB" .venv/bin/python -m unittest discover -s services/worker/tests -v`

Expected: import ERROR for `learning_orbit_worker.jobs`.

- [ ] **Step 3: Implement exact claim and transition rules**

```python
# services/worker/src/learning_orbit_worker/jobs.py
from pathlib import Path
CLAIM_SQL = (Path(__file__).parents[4] / "apps/server/src/db/sql/claim_worker_job.sql").read_text()
SETTLE_SQL = (Path(__file__).parents[4] / "apps/server/src/db/sql/settle_worker_job_claims.sql").read_text()
class JobStore:
    def __init__(self,db,worker_id): self.db,self.worker_id=db,worker_id
    def claim(self,n=1):
        if n != 1: raise ValueError("WORKER_CLAIM_SIZE_MUST_BE_ONE")
        with self.db.transaction():
            ids = [row[0] for row in self.db.execute(CLAIM_SQL,(n,)).fetchall()]
            if not ids: return []
            return rows_as_dicts(self.db.execute(
                SETTLE_SQL,(ids,ids,ids,self.worker_id)
            ))
    def heartbeat(self,job): require_one(self.db.execute("UPDATE worker_job SET locked_at=now(),updated_at=now() WHERE job_id=%s AND status='running' AND locked_by=%s AND claim_generation=%s AND claim_token=%s",(job["job_id"],self.worker_id,job["claim_generation"],job["claim_token"])),"STALE_CLAIM")
    def succeed(self,job): succeed_with_matching_completion(self.db,job,self.worker_id)
    def fail(self,job,error): apply_bounded_retry_or_dead_cas(self.db,job,self.worker_id,error)
```

Create the single Worker-side signer and bounded internal HTTP client used by every later job family:

```python
# services/worker/src/learning_orbit_worker/service_assertion.py
from base64 import urlsafe_b64encode
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from json import dumps
from pathlib import Path
from cryptography.hazmat.primitives.serialization import load_pem_private_key

def canonical_json(value: object) -> bytes:
    assert_closed_assertion_value(value)  # recursive; safe integers, strings, bool/null only
    return dumps(value, ensure_ascii=False, allow_nan=False,
                 separators=(",", ":"), sort_keys=True).encode("utf-8")

class ServiceAssertionSigner:
    def __init__(self, issuer: str, key_id: str, private_key_file: Path, clock):
        self.issuer, self.key_id, self.clock = issuer, key_id, clock
        self.key = load_private_ed25519_key_from_owner_only_regular_file(
            private_key_file
        )

    def sign(self, audience: str, subject: str, body: dict,
             lifetime_seconds: int = 60) -> str:
        if lifetime_seconds < 1 or lifetime_seconds > 60:
            raise ValueError("SERVICE_ASSERTION_LIFETIME_INVALID")
        now = self.clock.now().astimezone(timezone.utc)
        protected = {
            "alg": "Ed25519", "keyId": self.key_id, "issuer": self.issuer,
            "subject": subject, "audience": audience,
            "issuedAt": now.isoformat().replace("+00:00", "Z"),
            "expiresAt": (now + timedelta(seconds=lifetime_seconds)).isoformat().replace("+00:00", "Z"),
            "bodySha256": sha256(canonical_json(body)).hexdigest(),
        }
        signature = self.key.sign(canonical_json(protected))
        envelope = {**protected, "signature": urlsafe_b64encode(signature).rstrip(b"=").decode()}
        return urlsafe_b64encode(canonical_json(envelope)).rstrip(b"=").decode()
```

The Python and TypeScript canonicalizers share a checked-in JSON fixture corpus containing nested objects, Unicode, booleans/null, arrays, safe-integer boundaries, rejected float/negative-zero/non-finite values and reordered keys; both must produce the same UTF-8 bytes and hashes. The Ed25519 signature covers the closed protected fields, while `bodySha256` binds the already-schema-validated full request body. Each job-bound body contains the complete `JobClaimIdentity`, including `workerId=job.locked_by`; `InternalServiceClient.post` refuses a different subject, signs for one exact route audience, sends the value only in `X-LO-Service-Assertion`, uses explicit connect/read/total deadlines and accepts only the generated closed response. The client never retries inside one attempt, follows no redirects, permits only the configured internal HTTPS/loopback test origin and redacts assertion, claim token and request body from exceptions/logs. Plan 02 and Plan 04 inject this same signer/client through `WorkerDeps`; they may add generated request codecs but may not create another signer.

The private key is loaded only from `LO_WORKER_ASSERTION_PRIVATE_KEY_FILE`, which must resolve to a non-symlink regular file owned by the process with mode `0600`; raw key environment variables are rejected. Test keys are generated in a temporary directory, their public fingerprints are denylisted by the pilot configuration, and no fixture private key is packaged. Production/pilot startup requires an approved current key ID and refuses fixture/expired/revoked IDs. `test_service_assertion.py` checks exact 60-second scope, deterministic cross-language bytes/signatures, mode/symlink/key-type rejection and secret-free logs. `test_internal_http.py` checks wrong audience/subject/body/claim, redirect, timeout and response-schema failure. `auto-close-restart.test.ts` launches the real Python handler against the real Fastify internal route using a temporary key pair and proves a valid round trip closes once while tampering writes zero rows.

`room_lock.py` reads `lock_room_xact.sql`, `lock_room_session.sql` and `unlock_room_session.sql` from the same canonical repository/runtime path as Node and passes only the room UUID; it contains no UUID hash. `test_room_lock_parity.py` coordinates Python and Node connections to prove same-room blocking, different-room independence and the global advisory→room row→domain rows→job lock order.

After the caller has acquired the canonical room lock and locked its family domain rows, `WorkerDeps.job_claims.complete_business(tx,job,familyCompletionCode)` locks the exact current `worker_job` row before any domain mutation, then inserts the receipt through `INSERT ... SELECT`; it stores SHA-256 of the claim token, never the token. Calling it before room/domain locks is a lock-order violation tested in both languages. `ON CONFLICT(job_id,claim_generation) DO NOTHING` is followed by a read requiring existing token hash and family-stable code to match. Codes describe family terminal completion—not branch wording—so auto-close uses `ROOM_AUTO_CLOSE_COMPLETED`, media reconcile `MEDIA_RECONCILE_COMPLETED`, media processing `MEDIA_PROCESS_COMPLETED`, analytics consume/replay stable codes, Agent `AGENT_EXECUTION_TERMINAL`, multimodal `MULTIMODAL_DERIVATION_COMPLETED`, and lifecycle `LIFECYCLE_SURFACE_COMPLETED`. `succeed_with_matching_completion` transaction verifies that hash/generation, marks the job succeeded/clears lease, then deletes the ephemeral completion row. Stale recovery does the same update then CTE cleanup. Thus lifecycle jobs with NULL room leave no completion/token artifact, and completion data never enters APIs/logs/receipts. Candidate and final transactions lock the same job row, closing the snapshot race. Tests cover both lock orders, same-claim retry, old-marker/new-generation completion and max-attempt kill recovery.

`test_job_claim_parity.py` consumes the exact fixture table used by `apps/server/test/db/job-claim-authority.test.ts` and proves both implementations agree on exact tuple comparison, canonical decimal generation, token SHA-256, duplicate same-code idempotency, conflicting-code failure and stale-token rejection. It also hashes the two canonical claim SQL files at test startup so a Python copy or diverging query is impossible. The Python helper remains necessary for Worker-owned direct database transactions; server internal HTTP routes use only the TypeScript singleton.

`apply_bounded_retry_or_dead_cas` uses the same claim predicate and additionally requires no matching completion receipt. If one exists, the wrapper takes the success/recovery path rather than converting completed business work to retry/dead. Retry/dead transitions clear lease fields; cancellation does likewise. A zero-row result is classified as expected stale claim, already-completed, or fail-closed invariant error by a read on the same connection. The two-minute lease is renewed no less frequently than every 30 seconds; `heartbeatPeriod < lease/3` is tested.

`run_with_lease(job, handler, base_deps)` is the only dispatch wrapper. It creates `attempt_deps = base_deps.for_attempt(WorkerClaim.from_job(job), attempt_cancelled, stop_heartbeat)`: shared immutable pools/ports, but distinct per-attempt cancellation and heartbeat-stop events. An independent heartbeat thread with its own DB connection starts before the synchronous handler. It waits interruptibly and renews no less frequently than every 30 seconds. A failed/late CAS sets only `attempt_cancelled`; every network/process control receives it and later transactions fail claim validation. In `finally`, the wrapper first sets/wakes `stop_heartbeat`, performs a bounded join and treats a surviving thread as a fatal worker-health error; it never joins a still-looping heartbeat.

Handlers return `HandlerOutcome = success | terminal_cancelled | lost_lease`; retryable/deterministic failures remain typed exceptions with safe codes. `success` alone calls fenced `JobStore.succeed(job)`. A handler that already atomically cancelled/cleared the job returns `terminal_cancelled`; the wrapper verifies that terminal row and performs no second transition. When the supervisor lost the claim, or a final transition raises the specifically expected `STALE_CLAIM`, the wrapper records only content-free `JOB_ATTEMPT_FENCED_AWAY`, performs no succeed/fail, and continues the main loop; any other zero-row transition is fail-closed. Tests cover quick success/fail with zero heartbeat-thread leaks, Agent policy cancellation followed by another job, a blocked handler over two lease periods, two concurrent scoped attempts where only one loses its lease, and old-token external/business writes remaining zero.

`handler_registry.py` is the single extensible dispatch authority. Freeze one claimed ABI: `WorkerJob = {job_id,job_type,room_id,source_event_id,dedupe_key,payload,attempts,correlation_id,locked_by,claim_generation,claim_token}`; `locked_by` is non-null and must equal the `JobStore.worker_id` that received the row. `WorkerClaim.from_job` includes that persisted subject, generation and token. `WorkerDeps` is the attempt-scoped view and `Handler` returns `HandlerOutcome`. Registration rejects duplicate/unknown names; every durable mutation/assertion rechecks the exact current-running tuple, and service assertion subject must equal `job.locked_by`. `main.py` owns one registry/base container/JobStore, claims exactly one per loop and starts the supervisor immediately; horizontal processes provide concurrency. Configuration rejects larger claim sizes. Later plans only register families—no copied runner/query/map. Tests pin subject equality, heartbeat cleanup, stale reclaim, isolated cancellation, terminal/lost outcomes, old-token rejection and restart behavior.

- [ ] **Step 4: Verify green and commit**

Run: `TEST_DATABASE_URL=postgres://learning_orbit:learning_orbit@127.0.0.1:55432/learning_orbit_test .venv/bin/python -m unittest discover -s services/worker/tests -v && TEST_DATABASE_URL="$LO_TEST_DB" pnpm --filter @learning-orbit/server test -- test/rooms/auto-close-restart.test.ts`

Expected: unittest PASS; TypeScript/Python claim, room-lock and canonical-signature fixtures agree; the real signed internal call succeeds while tampering/secret logging fails; a fresh lease is not reclaimed, stale running gets a new token/generation, old-worker heartbeat/success/fail and business commit are rejected, exhausted stale work becomes dead, and stopping/restarting the real worker across the deadline closes a paused/open room without a read request, broadcasts one event, revokes sessions, and creates no second close under a manual-close race.

Commit: `git add services/worker apps/server/src/db/sql/claim_worker_job.sql apps/server/test/rooms/auto-close-restart.test.ts && git commit -m "feat(worker): add durable PostgreSQL job runner"`

### Task 14: Prove the four-seat realtime pilot end to end

**Files:** Create `apps/server/test/e2e/{four-seat-pilot,contract-conformance}.test.ts`, `apps/server/test/helpers/pilot.ts`, `README.md`.

- [ ] **Step 1: Write the failing four-client acceptance test**

```ts
// apps/server/test/e2e/four-seat-pilot.test.ts
it("proves four-seat resume and close",async()=>{const r=await runFourSeatPilot();expect(r).toMatchObject({seatCount:4,gapReplayed:true,duplicateSuppressed:true,closedAt2700:true,postCloseCode:"ROOM_NOT_OPEN",contiguousSeq:true});});
```

- [ ] **Step 2: Write the failing stored-envelope conformance test**

```ts
// apps/server/test/e2e/contract-conformance.test.ts
it("validates every persisted envelope",async()=>{await seedPilotTranscript();const rows=await db.query("select envelope from outbox_event order by outbox_id");for(const row of rows.rows)expect(validateRoomEvent(row.envelope),JSON.stringify(validateRoomEvent.errors)).toBe(true);});
```

- [ ] **Step 3: Verify the acceptance tests are red, then complete only their exposed gaps**

Run: `pnpm --filter @learning-orbit/server test -- test/e2e`

Expected: explicit assertion failure. Fix its owner, add focused regression, rerun focused then E2E; never weaken identity/order/contracts.

- [ ] **Step 4: Run the full release-candidate verification ladder**

Run exactly:

```bash
cd learning-orbit
docker compose -f infra/docker-compose.yml up -d postgres mailpit
DATABASE_URL="$LO_TEST_DB" pnpm db:migrate
pnpm --filter @learning-orbit/contracts generate
pnpm typecheck
TEST_DATABASE_URL="$LO_TEST_DB" pnpm test
TEST_DATABASE_URL="$LO_TEST_DB" .venv/bin/python -m unittest discover -s services/worker/tests -v
pnpm build
```

Expected: checksums stable; TS/Python/contracts/build all PASS without generated diff.

- [ ] **Step 5: Document local operation and commit the verified slice**

README gives exact install, services, migration, teacher allowlist, app/worker, test, and stop commands; labels demo HTML a local visual fixture and disclaims deployment proof.

Commit:

```bash
git add README.md apps/server/test/e2e apps/server/test/helpers/pilot.ts
git commit -m "test: prove four-seat realtime pilot"
git status --short
```

Expected: commit succeeds and `git status --short` prints nothing.

## Sub-plan release gate

- [ ] Only `learning-orbit/` changes; demo hash stays fixed. PostgreSQL is `postgres:18`; checksum SQL, no ORM.
- [ ] Canonical core tables/names are frozen; `room_member.actor_id` is globally UNIQUE; human actor IDs are authenticated.
- [ ] Cookie session is 401 or server-owned student+Nova/teacher identity; join returns no roomId. Plan 05 hydrates session.
- [ ] Room Nova is unique; four-member+Nova mentions are room-local; forged/cross-room actors fail.
- [ ] Owner-only lifecycle follows scheduled→open→paused↔open→closed; pause preserves fixed 2700s/read/background boundaries.
- [ ] Only students browser-add/revise; students retract self, owner teacher retracts any; active reply targets only; history remains immutable.
- [ ] Cookie WS uses exact Origin/no ticket; cookie mutations enforce Origin; service auth is separate; no wildcard credential CORS.
- [ ] Outbox/jobs use SKIP LOCKED, bounded retry/stale recovery/no row deletion; cancelled jobs are never claimed.
- [ ] Every worker job has one persisted non-null `correlation_id`; event/request-derived enqueues preserve upstream identity and all retries reuse the claimed value.
- [ ] Room HTTP/Auth/core payload schemas are closed, titled, identified 2020-12 sources; generated types/routes/pages regenerate cleanly.
- [ ] Registry rejects unknowns; mediaIds are bounded and default-denied until Plan 02 validates; only server Agent output carries provenance.
- [ ] Reviewed pins/lock match Node 24.19, pnpm 11.19, Python 3.12, Next 16.2.9, Fastify 5.10.0, WS 11.3.0, rate-limit 11.2.0; proxy/IPv6/429 tests leak no code detail.
- [ ] Exact ladder passes server/web/stdlib unittest/typecheck/build.
- [ ] Clean final commit proves only local pilot foundation, not provider/deploy/live/privacy approval.

## Explicit non-goals

- No images, audio, object storage, signed URLs, antivirus, OCR, ASR, or media-derived events.
- No Agent model call, tool use, prompt orchestration, ECHO-CM, TRACE-AI, or analytics projection.
- No learned content moderation, teacher review queue, guardian workflow, research consent/export, or institutional SSO.
- No Redis, Kafka, multi-region fanout, horizontal WebSocket coordination, cloud database provisioning, CI/CD, domain, or deployment.
- No claim that the reference Python algorithms or the self-contained HTML prototype are running production services.
