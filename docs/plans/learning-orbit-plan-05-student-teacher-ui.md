# Learning Orbit Student and Teacher UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved controlled-classroom-pilot web UI for students and teachers, preserving the verified Learning Orbit visual and accessibility contract while replacing all local demo state with authenticated server events, generated contracts, replayable projections, and auditable teacher actions.

**Architecture:** `apps/web` is a Next.js App Router application whose only mutable client state is a framework-free `SessionStore` exposed through `useSyncExternalStore`. A typed `SessionGateway` and `RealtimeSessionClient` consume the server and the generated contract artifacts from the preceding plans; `EventLedger`, concept-map reducer, SNA reducer, and `ProjectionCoordinator` remain independent pure projections. React components render those projections through CSS Modules and authored SVG, so graph and list views always share selectors, provenance, independent `projectionVersion` values, numeric `completeThroughRoomSeq`, and accessibility text.

**Tech Stack:** Next.js App Router, React, TypeScript, CSS Modules, `useSyncExternalStore`, native WebSocket and MediaRecorder APIs, authored SVG, Vitest, React Testing Library, Playwright, and `@axe-core/playwright`. Do not add Tailwind, Redux, D3, CSS-in-JS, client-side scientific scoring, or a second contract definition.

---

## Execution boundary and prerequisites

All commands in this plan run from the project root:

```bash
cd learning-orbit
```

Plans 01–04 plus the Plan 06 Tasks 3–4 export/deletion backend-and-contract slice must already pass. Before changing `apps/web`, run:

```bash
test -d packages/contracts/schemas
test -f packages/contracts/schemas/room-event-envelope.v1.json
test -f packages/contracts/schemas/auth-http.v1.json
test -f packages/contracts/schemas/echo-concept-projection.v1.json
test -f packages/contracts/schemas/trace-projection.v1.json
test -f packages/contracts/schemas/derived-text-artifact-page.v1.json
test -f packages/contracts/schemas/deletion-lifecycle.v1.json
test -f packages/contracts/schemas/agent-command.v1.json
test -f packages/contracts/schemas/agent-current-state.v1.json
test -d packages/contracts/src/generated
test -f packages/contracts/src/generated/derived-text-artifact-page.v1.ts
test -f packages/contracts/src/generated/deletion-lifecycle.v1.ts
test -f packages/contracts/src/core-room-event.ts
test -f packages/contracts/src/routes.ts
test -f packages/contracts/src/realtime.ts
test -d apps/server
pnpm --filter @learning-orbit/server test
```

Expected: every `test` command exits `0`; the Plan 01–04 server/analytics/Agent suites and Plan 06 export/deletion contract/backend slice exit `0` with no skipped contract or realtime tests. If any command fails, stop Plan 05 and complete the owning prerequisite. Do not create replacement schemas or server handlers in `apps/web`. Gate 6 still owns the final real-browser export-byte and deletion-lifecycle E2E proof.

Canonical contract ownership is frozen:

- JSON Schemas: `packages/contracts/schemas/*.json`
- Generated TypeScript: `packages/contracts/src/generated/`
- REST path builders: `packages/contracts/src/routes.ts`
- WebSocket envelope parsing/encoding helpers: `packages/contracts/src/realtime.ts`

The UI may import those artifacts and define view models, but it must not modify them. The server transport is hidden behind `apps/web/src/session/session-gateway.ts`; tests inject a deterministic gateway and transport without shipping fixture behavior in the production bundle.

## File map

| Area | Exact files and responsibility |
|---|---|
| App entry | `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `apps/web/app/globals.css`, `apps/web/app/session/[roomId]/page.tsx`, `apps/web/app/session/[roomId]/SessionWorkspace.tsx` — metadata, join route, cookie-auth session hydration, room route and dependency wiring |
| App shell | `apps/web/src/shell/AppShell.tsx`, `AppShell.module.css`, `SessionHeader.tsx`, `ParticipantActivity.tsx`, `session/session-clock.ts` — skip link, server-clock progress, ephemeral activity, degraded state and three-region layout |
| Contracts | `apps/web/src/contracts/generated.ts`, `apps/web/src/contracts/generated.test.ts` — re-export generated wire types, canonical REST path builders and realtime helpers only |
| Session core | `apps/web/src/session/event-ledger.ts`, `session-store.ts`, `use-session-store.ts`, `realtime-session-client.ts`, `projection-sync.ts`, `session-gateway.ts`, `fetch-session-gateway.ts`, `projection-coordinator.ts` — RoomEvent ordering, independently deduplicated analytics frames, authorized HTTP projection catch-up, external store, transport, server boundary and atomic projection readiness |
| Auth/join | `apps/web/src/auth/JoinSessionForm.tsx`, `JoinSessionForm.module.css`, `join-session.ts` — room-code and seat-code join; server-assigned pseudonym, actor identity and session bootstrap |
| View preferences | `apps/web/src/preferences/view-preferences.ts`, `use-view-preferences.ts` — query-string state for graph/list, SNA scope and fixed server time window |
| Chat | `apps/web/src/chat/ChatPanel.tsx`, `MessageList.tsx`, `MessageCard.tsx`, `Composer.tsx`, `ReplyBanner.tsx`, `MentionPicker.tsx`, `InquiryPromptChips.tsx`, `ChatPanel.module.css` — event-selected messages, inquiry drafting aids, compose, reply, mention, revise and retract |
| Media | `apps/web/src/media/ImageAttachmentTray.tsx`, `AudioRecorderTray.tsx`, `media-command.ts`, `recorder-machine.ts`, `Media.module.css` — accessible image metadata, owned recorder sessions, upload/command lifecycle |
| Agent | `apps/web/src/agent/AgentStatus.tsx`, `AgentDisclosure.tsx`, `agent-presentation.ts`, `AgentStatus.module.css` — generated `AgentRun.state` and service-health input, derived presentation state, role, source and policy-hold messaging |
| Concept map | `apps/web/src/concept/concept-reducer.ts`, `concept-selectors.ts`, `ConceptPanel.tsx`, `ConceptGraph.tsx`, `ConceptList.tsx`, `ConceptInspector.tsx`, `ConceptTimeline.tsx`, `ConceptPanel.module.css` — generated `ConceptMapPatch` reducer, object evidence refs, multi-dimensional edge status, graph/list parity, inspector and replay cursor |
| SNA | `apps/web/src/sna/sna-reducer.ts`, `sna-selectors.ts`, `sna-view-adapter.ts`, `sna-live-controller.ts`, `port-allocator.ts`, `SnaPanel.tsx`, `SnaGraph.tsx`, `SnaMetrics.tsx`, `SnaInspector.tsx`, `SnaPanel.module.css` — generated bundle with two server windows × exactly three views, shared cursors, presentation pause, pure screen geometry and group metrics |
| Teacher | `apps/web/app/teacher/page.tsx`, `app/session/[roomId]/teacher/page.tsx`, `src/teacher/TeacherConsole.tsx`, `teacher-room-context.ts`, `DeletionRecoveryPage.tsx`, `TeacherAuthPanel.tsx`, `RoomAccessCodes.tsx`, `RoomLifecycleControls.tsx`, `AgentPolicyControls.tsx`, `ReviewQueue.tsx`, `CorrectionForm.tsx`, `ExportControls.tsx`, `DeleteSessionDialog.tsx`, `use-deletion-saga.ts`, `TeacherConsole.module.css` — auth, room context, review/correction, export and deletion recovery |
| Student privacy | `apps/web/src/student/PseudonymRoster.tsx`, `GroupMetricDisclosure.tsx`, `StudentPrivacyNotice.tsx` — pseudonyms and group-only interpretation |
| Tests | `apps/web/src/**/*.test.ts(x)`, `apps/web/e2e/*.spec.ts`, `apps/web/src/testing/legacy-contract-matrix.ts`, `apps/web/playwright.config.ts`, `apps/web/vitest.config.ts`, `apps/web/test/setup.ts` — unit, component, accessibility, five-viewport and legacy-contract migration evidence |

## Legacy HTML contract migration

The existing `work/test_html_contract.py` has 19 tests. Preserve its intent through these exact proof IDs; the final gate runs all named proof files, and `legacy-contract-migration.test.ts` verifies that each ID occurs exactly once.

| Proof ID | Existing contract intent | New proof file |
|---|---|---|
| LO-HTML-01 | Document, language and viewport contract | `app/layout.test.tsx` |
| LO-HTML-02 | Only causally granted external media transfer crosses the origin boundary | `e2e/network-policy.spec.ts` |
| LO-HTML-03 | Three semantic regions and honest session disclosure | `src/shell/AppShell.test.tsx` |
| LO-HTML-04 | Composer, reply, media and honest fallbacks | `src/chat/Composer.test.tsx` |
| LO-HTML-05 | Keyboard-operable image picker | `src/media/ImageAttachmentTray.test.tsx` |
| LO-HTML-06 | Concept question, states, evidence and controls | `src/concept/ConceptPanel.test.tsx` |
| LO-HTML-07 | SNA views, geometry, metrics and limitation | `src/sna/SnaPanel.test.tsx` |
| LO-HTML-08 | Mobile SNA tabs do not scroll horizontally | `e2e/viewports.spec.ts` |
| LO-HTML-09 | 44px graph targets and mobile list defaults | `e2e/viewports.spec.ts` |
| LO-HTML-10 | One event updates topology and provenance | `src/session/projection-coordinator.test.ts` |
| LO-HTML-11 | Replay restores multi-source concept provenance | `src/concept/concept-reducer.test.ts` |
| LO-HTML-12 | Dedicated live SNA status and unique edge names | `src/sna/SnaPanel.test.tsx` |
| LO-HTML-13 | Owned recorder sessions and race guards | `src/media/recorder-machine.test.ts` |
| LO-HTML-14 | Independent server-owned sources hydrate one coherent local state | `src/session/session-store.test.ts` |
| LO-HTML-15 | Fixed-height SNA limitation remains reachable | `e2e/viewports.spec.ts` |
| LO-HTML-16 | Generated shared contracts drive projections | `src/contracts/generated.test.ts` |
| LO-HTML-17 | Unmatched message text is retained without mutating concept projection state | `src/session/event-ledger.test.ts` |
| LO-HTML-18 | Accessibility, reduced motion and breakpoints | `e2e/accessibility.spec.ts` |
| LO-HTML-19 | Structural icons are authored SVG, not emoji | `src/shell/AppShell.test.tsx` |

### Task 1: Extend the existing Plan 01 Next.js scaffold and remove the duplicate room route

**Files:**
- Inspect: `learning-orbit/apps/web/tsconfig.json`
- Verify unchanged: `learning-orbit/apps/web/package.json`
- Verify unchanged: `learning-orbit/pnpm-lock.yaml`
- Modify: `learning-orbit/apps/web/next.config.ts`
- Verify unchanged: `learning-orbit/apps/web/vitest.config.ts`
- Verify unchanged: `learning-orbit/apps/web/test/setup.ts`
- Modify: `learning-orbit/apps/web/app/layout.tsx`
- Create: `learning-orbit/apps/web/app/layout.test.tsx`
- Modify: `learning-orbit/apps/web/app/page.tsx`
- Modify: `learning-orbit/apps/web/app/globals.css`
- Create: `learning-orbit/apps/web/app/route-uniqueness.test.ts`
- Delete: `learning-orbit/apps/web/app/rooms/[roomId]/page.tsx`

- [ ] **Step 1: Write the failing semantic-root test**

```tsx
// apps/web/app/layout.test.tsx
import { render, screen } from "@testing-library/react";
import HomePage from "./page";

it("[LO-HTML-01] renders a Traditional Chinese document root and one product heading", () => {
  render(<HomePage />);
  expect(screen.getByRole("heading", { level: 1, name: "Learning Orbit｜共學星球" })).toBeVisible();
  expect(document.documentElement.lang).toBe("zh-Hant");
});
```

```ts
// apps/web/app/route-uniqueness.test.ts
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nextConfig from "../next.config";

it("has one canonical room UI route and a config redirect for the Plan 01 legacy path", async () => {
  const legacyRoute = fileURLToPath(new URL("./rooms/[roomId]/page.tsx", import.meta.url));
  expect(existsSync(legacyRoute)).toBe(false);
  expect(await nextConfig.redirects?.()).toContainEqual({ source: "/rooms/:roomId", destination: "/session/:roomId", permanent: false });
});
```

- [ ] **Step 2: Run the test and verify the red state**

Run: `pnpm --filter @learning-orbit/web test -- app/layout.test.tsx app/route-uniqueness.test.ts`

Expected: FAIL because the approved product root and canonical `/session/:roomId` route are absent; the Plan 01 jsdom/Testing Library harness itself must already pass.

- [ ] **Step 3: Extend the existing root and migrate the legacy route**

```tsx
// apps/web/app/layout.tsx
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Learning Orbit｜共學星球",
  description: "受控課堂協作探究空間",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, colorScheme: "light" };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
```

```tsx
// apps/web/app/page.tsx
export default function HomePage() {
  return <main id="main-content"><h1>Learning Orbit｜共學星球</h1></main>;
}
```

Reuse Plan 01's `jsdom` Vitest configuration, Testing Library setup, exact locked test packages and installed Chromium revision without reinstalling or repinning them. Add a non-permanent Next config redirect from `/rooms/:roomId` to `/session/:roomId`, then delete the old `app/rooms/[roomId]/page.tsx` so only the canonical App Router entry remains. Verify the frozen toolchain:

```bash
pnpm --filter @learning-orbit/web exec playwright --version
node scripts/assert-root-scripts.mjs
pnpm licenses list --json
```

Expected: the unchanged Plan 01 lock records the reviewed versions; Playwright reports 1.62.1 and launches the locked Chromium revision; the root script manifest remains complete. The license inventory identifies Playwright as Apache-2.0, axe-core tooling as MPL-2.0, and Testing Library/jsdom packages as MIT, with no unreviewed dependency. If Chromium cannot launch, Gate 5 is blocked and Playwright must not be reported as passing.

- [ ] **Step 4: Verify unit, type and build baselines**

Run: `pnpm --filter @learning-orbit/web test -- app/layout.test.tsx app/route-uniqueness.test.ts && pnpm --filter @learning-orbit/web typecheck && pnpm --filter @learning-orbit/web build`

Expected: semantic-root and canonical-route tests pass; TypeScript exits `0`; Next.js reports a successful production build.

- [ ] **Step 5: Commit the scaffold**

```bash
git add -- apps/web/next.config.ts apps/web/app/layout.tsx apps/web/app/layout.test.tsx apps/web/app/page.tsx apps/web/app/globals.css apps/web/app/route-uniqueness.test.ts 'apps/web/app/rooms/[roomId]/page.tsx'
git commit -m "chore(web): extend scaffold and canonicalize room route"
```

### Task 2: Bind generated contracts and register all 19 migrated proofs

**Files:**
- Create: `learning-orbit/apps/web/src/contracts/generated.ts`
- Create: `learning-orbit/apps/web/src/contracts/generated.test.ts`
- Create: `learning-orbit/apps/web/src/testing/contract-fixtures.ts`
- Create: `learning-orbit/apps/web/src/testing/factories.ts`
- Create: `learning-orbit/apps/web/src/testing/legacy-contract-matrix.ts`
- Create: `learning-orbit/apps/web/src/testing/legacy-contract-migration.test.ts`

- [ ] **Step 1: Write failing contract-identity and 19-proof tests**

```ts
// apps/web/src/contracts/generated.test.ts
import type { ConceptMapPatch, ConceptMapSnapshot, DerivedTextArtifactPage, RoomEventEnvelope, SnaProjectionBundle } from "./generated";
import { realtimeContract, routeContract } from "./generated";
import { DELETION_JOB_ID, EPOCH_A, MEDIA_IMAGE_ID, ROOM_ID, SOURCE_ARTIFACT_ID } from "../testing/contract-fixtures";
import { PENDING_REVIEW_STATUS } from "../testing/factories";

it("[LO-HTML-16] uses the canonical generated contracts and realtime helpers", () => {
  expect(typeof realtimeContract).toBe("object");
  expect(Object.keys(realtimeContract).length).toBeGreaterThan(0);
  expect(typeof routeContract).toBe("object");
  expect(Object.keys(routeContract).length).toBeGreaterThan(0);
  expectTypeOf<RoomEventEnvelope["roomSeq"]>().toEqualTypeOf<number>();
  expectTypeOf<ConceptMapPatch["baseVersion"]>().toEqualTypeOf<number>();
  expectTypeOf<ConceptMapSnapshot["projectionVersion"]>().toEqualTypeOf<number>();
  expectTypeOf<SnaProjectionBundle["payload"]["views"]>().toMatchTypeOf<{ observed: unknown; human_only: unknown; lineage_adjusted: unknown }>();
  expectTypeOf<DerivedTextArtifactPage>().toMatchTypeOf<object>();
});

it("uses only shared builders for session, room, analytics, Agent, export and deletion routes", () => {
  expect(routeContract.auth.session()).toBe("/v1/auth/session");
  expect(routeContract.rooms.get(ROOM_ID)).toBe(`/v1/rooms/${ROOM_ID}`);
  expect(routeContract.rooms.events(ROOM_ID, { afterSeq: 8, limit: 50 })).toBe(`/v1/rooms/${ROOM_ID}/events?afterSeq=8&limit=50`);
  expect(routeContract.rooms.websocket(ROOM_ID)).toBe(`/v1/rooms/${ROOM_ID}/realtime`);
  expect(routeContract.analytics.latest(ROOM_ID, "echo.student_approved")).toBe(`/v1/rooms/${ROOM_ID}/analytics/echo.student_approved/latest`);
  expect(routeContract.analytics.patches(ROOM_ID, "echo.student_approved", EPOCH_A, 4)).toBe(`/v1/rooms/${ROOM_ID}/analytics/echo.student_approved/patches?analysisEpoch=${EPOCH_A}&afterProjectionVersion=4`);
  const artifactRoute = new URL(routeContract.analytics.artifacts(ROOM_ID, { reviewStatus: PENDING_REVIEW_STATUS, afterArtifactId: SOURCE_ARTIFACT_ID, limit: 50 }), "https://contract.test");
  expect(artifactRoute.pathname).toBe(`/v1/rooms/${ROOM_ID}/analytics/artifacts`);
  expect(Object.fromEntries(artifactRoute.searchParams)).toEqual({ reviewStatus: PENDING_REVIEW_STATUS, afterArtifactId: SOURCE_ARTIFACT_ID, limit: "50" });
  expect(routeContract.agent.current(ROOM_ID)).toBe(`/v1/rooms/${ROOM_ID}/agent/current`);
  expect(routeContract.media.get(ROOM_ID, MEDIA_IMAGE_ID)).toContain(MEDIA_IMAGE_ID);
  expect(routeContract.rooms.export(ROOM_ID, "json")).toBe(`/v1/rooms/${ROOM_ID}/export?format=json`);
  expect(routeContract.deletions.get(DELETION_JOB_ID)).toContain(DELETION_JOB_ID);
  expect(routeContract.deletions.forRoom(ROOM_ID)).toContain(ROOM_ID);
});
```

```ts
// apps/web/src/testing/legacy-contract-migration.test.ts
import { legacyContractProofs } from "./legacy-contract-matrix";

it("registers exactly 19 unique legacy HTML proof IDs", () => {
  expect(legacyContractProofs).toHaveLength(19);
  expect(new Set(legacyContractProofs.map(({ id }) => id)).size).toBe(19);
  expect(legacyContractProofs.every(({ proofFile, testName }) => proofFile.length > 0 && testName.startsWith("[LO-HTML-"))).toBe(true);
});
```

- [ ] **Step 2: Run the tests and verify missing modules**

Run: `pnpm --filter @learning-orbit/web test -- src/contracts/generated.test.ts src/testing/legacy-contract-migration.test.ts`

Expected: FAIL with module-not-found errors for `generated.ts` and `legacy-contract-matrix.ts`.

- [ ] **Step 3: Add imports and the complete proof registry**

```ts
// apps/web/src/contracts/generated.ts
export type * from "../../../../packages/contracts/src/index";
export type { RoomEventEnvelope } from "../../../../packages/contracts/src/generated/room-event-envelope.v1";
export type { ConceptMapPatch, ConceptMapSnapshot } from "../../../../packages/contracts/src/generated/echo-concept-projection.v1";
export type { SnaProjectionBundle } from "../../../../packages/contracts/src/generated/trace-projection.v1";
export type { DerivedTextArtifactPage } from "../../../../packages/contracts/src/generated/derived-text-artifact-page.v1";
export type { DeleteRoomAccepted, DeleteRoomRequest, DeletionReceipt, DeletionStatus } from "../../../../packages/contracts/src/generated/deletion-lifecycle.v1";
export { parseCoreRoomEvent } from "../../../../packages/contracts/src/core-room-event";
export type { CoreRoomEvent } from "../../../../packages/contracts/src/core-room-event";
export { routes as routeContract } from "../../../../packages/contracts/src/routes";
export type { ArtifactPageQuery } from "../../../../packages/contracts/src/routes";
export { realtimeContract } from "../../../../packages/contracts/src/realtime";
```

```ts
// apps/web/src/testing/contract-fixtures.ts
// Stable schema-valid UUIDs belong to test support only. UI short labels are
// derived separately and are never serialized as wire identifiers.
export const ROOM_ID = "11111111-1111-4111-8111-111111111111";
export const ROOM_MEMBER_A = "22222222-2222-4222-8222-222222222221";
export const ROOM_MEMBER_B = "22222222-2222-4222-8222-222222222222";
export const ROOM_MEMBER_C = "22222222-2222-4222-8222-222222222223";
export const ROOM_MEMBER_D = "22222222-2222-4222-8222-222222222224";
export const ACTOR_A = "33333333-3333-4333-8333-333333333331";
export const ACTOR_B = "33333333-3333-4333-8333-333333333332";
export const ACTOR_C = "33333333-3333-4333-8333-333333333333";
export const ACTOR_D = "33333333-3333-4333-8333-333333333334";
export const NOVA_ACTOR_ID = "44444444-4444-4444-8444-444444444444";
export const RUN_ID = "55555555-5555-4555-8555-555555555555";
export const EPOCH_A = "66666666-6666-4666-8666-666666666666";
export const EVENT_001 = "77777777-7777-4777-8777-777777777701";
export const EVENT_002 = "77777777-7777-4777-8777-777777777702";
export const EVENT_003 = "77777777-7777-4777-8777-777777777703";
export const EVENT_006 = "77777777-7777-4777-8777-777777777706";
export const EVENT_007 = "77777777-7777-4777-8777-777777777707";
export const EVENT_008 = "77777777-7777-4777-8777-777777777708";
export const MESSAGE_001 = "88888888-8888-4888-8888-888888888801";
export const MESSAGE_002 = "88888888-8888-4888-8888-888888888802";
export const MESSAGE_003 = "88888888-8888-4888-8888-888888888803";
export const MESSAGE_008 = "88888888-8888-4888-8888-888888888808";
export const AGENT_MESSAGE_ID = "88888888-8888-4888-8888-888888888809";
export const CONCEPT_EDGE_ID = "99999999-9999-4999-8999-999999999917";
export const SOURCE_ARTIFACT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6";
export const MEDIA_IMAGE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
export const MEDIA_IMAGE_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
export const MEDIA_IMAGE_3 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
export const MEDIA_IMAGE_4 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4";
export const MEDIA_AUDIO_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
export const DELETION_JOB_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const PROJECTION_TARGET_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const ROOM_CODE = "ECOS2A";
export const SEAT_CODE_A = "SEAT2ABCDE";
export const SEAT_CODE_B = "SEAT2ABCDF";
export const SEAT_CODE_C = "SEAT2ABCDG";
export const SEAT_CODE_D = "SEAT2ABCDH";

export const displayEventLabel = (eventId: string) =>
  ({ [EVENT_001]: "事件 001", [EVENT_006]: "事件 006", [EVENT_007]: "事件 007", [EVENT_008]: "事件 008" })[eventId] ?? "事件";
```

Every factory that invokes a generated parser imports these constants. Do not invent abbreviated room, actor, run, epoch, event, message, artifact or concept identifiers as wire fixtures. Visible short labels come from selectors such as `displayEventLabel`; they are never substituted back into commands, URLs, evidence refs or generated payloads.

`testing/factories.ts` builds complete inputs and immediately validates them with the canonical generated parser for that schema. It exports the `roomEventEnvelope`, projection-frame, analytics recorded-event, create-room, DerivedTextArtifact page, media view and deletion lifecycle fixtures referenced below, plus `PENDING_REVIEW_STATUS` derived from a parsed `DerivedTextArtifact`. Factories fill every required generated field, including Plan 01/04 Nova configuration, without `as`, partial-object casts or a duplicate interface.

```ts
// apps/web/src/testing/legacy-contract-matrix.ts
export const legacyContractProofs = [
  { id: "LO-HTML-01", proofFile: "app/layout.test.tsx", testName: "[LO-HTML-01] renders a Traditional Chinese document root and one product heading" },
  { id: "LO-HTML-02", proofFile: "e2e/network-policy.spec.ts", testName: "[LO-HTML-02] allows only approved app API WebSocket and signed media transfer boundaries" },
  { id: "LO-HTML-03", proofFile: "src/shell/AppShell.test.tsx", testName: "[LO-HTML-03] exposes chat concept and SNA regions with live session disclosure" },
  { id: "LO-HTML-04", proofFile: "src/chat/Composer.test.tsx", testName: "[LO-HTML-04] supports compose reply media and explicit unsupported states" },
  { id: "LO-HTML-05", proofFile: "src/media/ImageAttachmentTray.test.tsx", testName: "[LO-HTML-05] opens the image picker from a keyboard-operable button" },
  { id: "LO-HTML-06", proofFile: "src/concept/ConceptPanel.test.tsx", testName: "[LO-HTML-06] exposes focus question relationship states evidence and timeline controls" },
  { id: "LO-HTML-07", proofFile: "src/sna/SnaPanel.test.tsx", testName: "[LO-HTML-07] exposes three SNA views group metrics geometry and limitation text" },
  { id: "LO-HTML-08", proofFile: "e2e/viewports.spec.ts", testName: "[LO-HTML-08] keeps mobile SNA view tabs within the viewport" },
  { id: "LO-HTML-09", proofFile: "e2e/viewports.spec.ts", testName: "[LO-HTML-09] preserves 44 pixel targets and mobile list defaults" },
  { id: "LO-HTML-10", proofFile: "src/session/projection-coordinator.test.ts", testName: "[LO-HTML-10] publishes one coherent chat concept and SNA batch" },
  { id: "LO-HTML-11", proofFile: "src/concept/concept-reducer.test.ts", testName: "[LO-HTML-11] replays exact multi-source concept provenance" },
  { id: "LO-HTML-12", proofFile: "src/sna/SnaPanel.test.tsx", testName: "[LO-HTML-12] announces SNA changes and gives every edge a unique accessible name" },
  { id: "LO-HTML-13", proofFile: "src/media/recorder-machine.test.ts", testName: "[LO-HTML-13] owns recorder sessions and rejects stale start-stop completions" },
  { id: "LO-HTML-14", proofFile: "src/session/session-store.test.ts", testName: "[LO-HTML-14] hydrates one local state from independent server-owned sources" },
  { id: "LO-HTML-15", proofFile: "e2e/viewports.spec.ts", testName: "[LO-HTML-15] keeps the SNA limitation reachable in fixed-height layouts" },
  { id: "LO-HTML-16", proofFile: "src/contracts/generated.test.ts", testName: "[LO-HTML-16] uses the canonical generated contracts and realtime helpers" },
  { id: "LO-HTML-17", proofFile: "src/session/event-ledger.test.ts", testName: "[LO-HTML-17] retains unmatched message text without mutating concept projection state" },
  { id: "LO-HTML-18", proofFile: "e2e/accessibility.spec.ts", testName: "[LO-HTML-18] passes accessibility reduced-motion and breakpoint checks" },
  { id: "LO-HTML-19", proofFile: "src/shell/AppShell.test.tsx", testName: "[LO-HTML-19] uses authored SVG rather than emoji for structural icons" },
] as const;
```

- [ ] **Step 4: Run the focused tests**

Run: `pnpm --filter @learning-orbit/web test -- src/contracts/generated.test.ts src/testing/legacy-contract-migration.test.ts`

Expected: generated type identity and shared-route tests pass, and the registry reports 19 unique proof IDs.

- [ ] **Step 5: Commit the contract boundary**

```bash
git add apps/web/src/contracts apps/web/src/testing
git commit -m "test(web): register generated contracts and legacy proofs"
```

### Task 3: Implement the RoomEventLedger and local ChatMessageView selector

**Files:**
- Create: `learning-orbit/apps/web/src/session/event-ledger.ts`
- Create: `learning-orbit/apps/web/src/session/event-ledger.test.ts`
- Create: `learning-orbit/apps/web/src/chat/chat-message-view.ts`

- [ ] **Step 1: Write failing ledger tests for room sequence, message root, revision, retraction and unmatched text**

```ts
// apps/web/src/session/event-ledger.test.ts
import { selectChatMessageViews } from "../chat/chat-message-view";
import { parseCoreRoomEvent } from "../contracts/generated";
import { createEventLedger, reduceRoomEvent } from "./event-ledger";
import { roomEventEnvelope } from "../testing/factories";
import { EVENT_001, EVENT_002, EVENT_003, EVENT_006, EVENT_007, EVENT_008, MESSAGE_001, MESSAGE_002, MESSAGE_003, MESSAGE_008 } from "../testing/contract-fixtures";

it("uses payload.messageId as the revision root and roomSeq as authoritative order", () => {
  const added = reduceRoomEvent(createEventLedger(), roomEventEnvelope({ eventId: EVENT_001, roomSeq: 1, eventTime: "2026-08-28T09:20:00+08:00", revision: 1, type: "message.added", payload: { messageId: MESSAGE_001, text: "first", mediaIds: [] } }));
  const revised = reduceRoomEvent(added, roomEventEnvelope({ eventId: EVENT_002, roomSeq: 2, eventTime: "2026-08-28T09:10:00+08:00", revision: 2, type: "message.revised", payload: { messageId: MESSAGE_001, text: "corrected", mediaIds: [] } }));
  expect(selectChatMessageViews(revised)[0]).toMatchObject({ messageId: MESSAGE_001, text: "corrected", revision: 2, roomSeq: 2, eventTime: "2026-08-28T09:10:00+08:00" });
  expect(revised.audit).toHaveLength(2);
  expect(revised.projectionVersion).toBe(2);
  expect(revised.completeThroughRoomSeq).toBe(2);
});

it("does not advance across a RoomEvent gap and accepts the missing sequence before the buffered event", () => {
  const afterOne = reduceRoomEvent(createEventLedger(), roomEventEnvelope({ eventId: EVENT_001, roomSeq: 1, revision: 1, type: "message.added", payload: { messageId: MESSAGE_001, text: "one", mediaIds: [] } }));
  const eventThree = roomEventEnvelope({ eventId: EVENT_003, roomSeq: 3, revision: 1, type: "message.added", payload: { messageId: MESSAGE_003, text: "three", mediaIds: [] } });
  expect(() => reduceRoomEvent(afterOne, eventThree)).toThrow("ROOM_EVENT_GAP(2,3)");
  expect(afterOne.completeThroughRoomSeq).toBe(1);
  const afterTwo = reduceRoomEvent(afterOne, roomEventEnvelope({ eventId: EVENT_002, roomSeq: 2, revision: 1, type: "message.added", payload: { messageId: MESSAGE_002, text: "two", mediaIds: [] } }));
  const afterThree = reduceRoomEvent(afterTwo, eventThree);
  expect(afterThree.completeThroughRoomSeq).toBe(3);
  expect(afterThree.projectionVersion).toBe(3);
});

it("[LO-HTML-17] retains unmatched message text without mutating concept projection state", () => {
  const event = roomEventEnvelope({ eventId: EVENT_008, roomSeq: 1, revision: 1, type: "message.added", payload: { messageId: MESSAGE_008, text: "這個關係需要更多證據", mediaIds: [] } });
  const state = reduceRoomEvent(createEventLedger(), event);
  expect(selectChatMessageViews(state)[0].text).toBe("這個關係需要更多證據");
  expect(event.payload).not.toHaveProperty("interactionTarget");
  expect(event.payload).not.toHaveProperty("warningCodes");
  expect(state).not.toHaveProperty("concept");
});

it("uses the shared core payload parser and rejects an invalid message payload", () => {
  expect(parseCoreRoomEvent(roomEventEnvelope({ eventId: EVENT_006, roomSeq: 6, type: "analytics.review.recorded.v1", payload: analyticsRecordedPayload }))).toBeNull();
  expect(() => parseCoreRoomEvent(genericEnvelope({ eventId: EVENT_007, roomSeq: 7, type: "message.added", payload: { text: 17 } }))).toThrow();
});
```

- [ ] **Step 2: Verify the reducer is absent**

Run: `pnpm --filter @learning-orbit/web test -- src/session/event-ledger.test.ts`

Expected: FAIL because `createEventLedger`, `reduceRoomEvent` and `selectChatMessageViews` are not defined.

- [ ] **Step 3: Add a monotonic, non-destructive reducer**

```ts
// apps/web/src/session/event-ledger.ts
import type { CoreRoomEvent, RoomEventEnvelope, RoomEventPage } from "../contracts/generated";
import { parseCoreRoomEvent } from "../contracts/generated";

export type EventLedger = Readonly<{
  byEventId: ReadonlyMap<string, RoomEventEnvelope>;
  latestMessageByRoot: ReadonlyMap<string, CoreRoomEvent>;
  audit: readonly RoomEventEnvelope[];
  projectionVersion: number;
  completeThroughRoomSeq: number;
}>;

export const createEventLedger = (base: { completeThroughRoomSeq: number; projectionVersion: number } = { completeThroughRoomSeq: 0, projectionVersion: 0 }): EventLedger => ({
  byEventId: new Map(), latestMessageByRoot: new Map(), audit: [], projectionVersion: base.projectionVersion, completeThroughRoomSeq: base.completeThroughRoomSeq,
});

export class RoomEventGapError extends Error {
  readonly code = "ROOM_EVENT_GAP";
  constructor(readonly expected: number, readonly actual: number) { super(`ROOM_EVENT_GAP(${expected},${actual})`); }
}

type MessageRoomEvent = Extract<CoreRoomEvent, { type: "message.added" | "message.revised" | "message.retracted" }>;
const isMessageEvent = (event: CoreRoomEvent): event is MessageRoomEvent => event.type === "message.added" || event.type === "message.revised" || event.type === "message.retracted";
const messageRoot = (event: MessageRoomEvent) => event.payload.messageId ?? event.eventId;

export function reduceRoomEvent(state: EventLedger, event: RoomEventEnvelope): EventLedger {
  if (state.byEventId.has(event.eventId) || event.roomSeq <= state.completeThroughRoomSeq) return state;
  const expected = state.completeThroughRoomSeq + 1;
  if (event.roomSeq !== expected) throw new RoomEventGapError(expected, event.roomSeq);
  const byEventId = new Map(state.byEventId).set(event.eventId, event);
  const latestMessageByRoot = new Map(state.latestMessageByRoot);
  const core = parseCoreRoomEvent(event);
  if (core && isMessageEvent(core)) {
    const root = messageRoot(core);
    if (core.type === "message.retracted") latestMessageByRoot.delete(root);
    else latestMessageByRoot.set(root, core);
  }
  return { byEventId, latestMessageByRoot, audit: [...state.audit, event], projectionVersion: state.projectionVersion + Number(Boolean(core && isMessageEvent(core))), completeThroughRoomSeq: event.roomSeq };
}
```

```ts
// apps/web/src/chat/chat-message-view.ts
import type { CoreRoomEvent } from "../contracts/generated";
import type { EventLedger } from "../session/event-ledger";

type VisibleMessageEvent = Extract<CoreRoomEvent, { type: "message.added" | "message.revised" }>;
const isVisibleMessageEvent = (event: CoreRoomEvent): event is VisibleMessageEvent => event.type === "message.added" || event.type === "message.revised";
export type ChatMessageView = Readonly<{
  messageId: string; eventId: string; roomSeq: number; eventTime: string; revision: number;
  actorId: VisibleMessageEvent["actorId"]; actorKind: VisibleMessageEvent["actorKind"]; actorRole: VisibleMessageEvent["actorRole"];
  text: string; mediaIds: readonly string[]; replyTo: string | null; mentions: readonly string[];
  agentRunId?: string; sourceEventIds?: readonly string[]; warningCodes?: readonly string[];
}>;

export function selectChatMessageViews(ledger: EventLedger): readonly ChatMessageView[] {
  return [...ledger.latestMessageByRoot.values()]
    .filter(isVisibleMessageEvent)
    .sort((a, b) => a.roomSeq - b.roomSeq)
    .map((event) => ({
      messageId: event.payload.messageId ?? event.eventId, eventId: event.eventId, roomSeq: event.roomSeq, eventTime: event.eventTime, revision: event.revision,
      actorId: event.actorId, actorKind: event.actorKind, actorRole: event.actorRole,
      text: event.payload.text, mediaIds: event.payload.mediaIds, replyTo: event.payload.replyTo, mentions: event.payload.mentions,
      agentRunId: event.payload.agentRunId, sourceEventIds: event.payload.sourceEventIds, warningCodes: event.payload.warningCodes,
    }));
}
```

`EventLedger` stores every generic generated `RoomEventEnvelope` for ordering and audit. Before reading any core payload field, call the shared `parseCoreRoomEvent(event: RoomEventEnvelope): CoreRoomEvent | null` from `packages/contracts/src/core-room-event.ts`: non-core events return `null`, invalid core payloads throw the stable shared error, and only its generated `message.added`, `message.revised` and `message.retracted` branches feed `ChatMessageView`. Do not cast `event.payload` or copy message payload interfaces locally.

After duplicate/stale checks, require `event.roomSeq === completeThroughRoomSeq + 1`. A larger sequence throws `RoomEventGapError` with stable `ROOM_EVENT_GAP(expected,actual)` data and leaves the immutable state untouched; `RealtimeSessionClient` hands that gap to `RoomEventSync` for generated-route pagination before retrying the buffered event. Only explicit server bootstrap/reset code may call `createEventLedger({ completeThroughRoomSeq, projectionVersion })` with a nonzero base cursor. The local chat `projectionVersion` increments only when a parsed message branch changes the chat projection; it is presentation synchronization metadata, not a wire field.

`eventTime` is display metadata only. Never sort, deduplicate, advance completeness or select the current revision from event time. `revision` is a top-level `RoomEventEnvelope` field; do not duplicate it inside `payload`. If generated core message payloads do not include interaction metadata, keep `interactionTarget` in the approved analytics projection state rather than extending `RoomEventEnvelope.payload` in the web app. The optional server-only Agent provenance fields expressly frozen by Plan 01 remain allowed on final `message.added` payloads.

`ChatMessageView` is local and read-only but retains every generated field needed to render author, reply, mentions, media and Agent disclosure. A separate roster selector maps `actorId` and mention IDs to server-assigned `探索者 A/B/C/D` or `Nova Agent`; components never render actor UUIDs in text, DOM IDs, data attributes or URLs, and never serialize the view back to the server.

- [ ] **Step 4: Run reducer tests and typecheck**

Run: `pnpm --filter @learning-orbit/web test -- src/session/event-ledger.test.ts && pnpm --filter @learning-orbit/web typecheck`

Expected: ledger tests pass; duplicate/stale room sequences leave the same state object; a 1→3 gap does not advance until 2 is applied; explicit base cursor reset works; message revision roots come only from `payload.messageId ?? eventId`; visible messages, local chat `projectionVersion` and `completeThroughRoomSeq` follow numeric `roomSeq`; typecheck exits `0`.

- [ ] **Step 5: Commit the ledger**

```bash
git add apps/web/src/session/event-ledger.ts apps/web/src/session/event-ledger.test.ts apps/web/src/chat/chat-message-view.ts
git commit -m "feat(web): project chat views from room events"
```

### Task 4: Add composed HydratedSessionState, SessionStore and React subscription hooks

**Files:**
- Create: `learning-orbit/apps/web/src/session/session-store.ts`
- Create: `learning-orbit/apps/web/src/session/use-session-store.ts`
- Create: `learning-orbit/apps/web/src/session/session-store.test.ts`

- [ ] **Step 1: Write failing snapshot-stability and composed-hydration tests**

```ts
// apps/web/src/session/session-store.test.ts
import { SessionStore } from "./session-store";
import { hydratedSessionState } from "../testing/factories";

it("notifies subscribers once for one committed transaction", () => {
  const store = new SessionStore();
  const listener = vi.fn();
  store.subscribe(listener);
  store.commit({ type: "connection", status: "connected" });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot()).toBe(store.getSnapshot());
});

it("[LO-HTML-14] hydrates one local state from independent server-owned sources", () => {
  const store = new SessionStore();
  store.hydrateFromSources(hydratedSessionState({
    completeThroughRoomSeq: 128,
    chatProjectionVersion: 41,
    conceptProjectionVersion: 12,
    snaProjectionVersion: 9,
  }));
  const state = store.getSnapshot();
  expect([state.ledger.completeThroughRoomSeq, state.concept!.completeThroughRoomSeq, state.sna!.completeThroughRoomSeq]).toEqual([128, 128, 128]);
  expect([state.ledger.projectionVersion, state.concept!.projectionVersion, state.sna!.projectionVersion]).toEqual([41, 12, 9]);
  expect(state.projectionAvailability).toEqual({ concept: "ready", sna: "ready" });
});
```

- [ ] **Step 2: Run and observe missing store failures**

Run: `pnpm --filter @learning-orbit/web test -- src/session/session-store.test.ts`

Expected: FAIL because `SessionStore` does not exist.

- [ ] **Step 3: Implement a stable external store without Redux**

```ts
// apps/web/src/session/session-store.ts
import type { AuthSession, RoomDetails } from "../contracts/generated";
import type { ConceptState } from "../concept/concept-reducer";
import type { SnaState } from "../sna/sna-reducer";
import type { EventLedger } from "./event-ledger";

export type HydratedSessionState = Readonly<{
  session: AuthSession;
  room: RoomDetails;
  ledger: EventLedger;
  concept: ConceptState | null;
  sna: SnaState | null;
  projectionAvailability: Readonly<Record<"concept" | "sna", "loading" | "ready" | "not_available_by_policy" | "failed">>;
}>;

export class SessionStore {
  private listeners = new Set<() => void>();
  private snapshot = createInitialSessionState();

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  commit(transaction: SessionTransaction) {
    const next = reduceSessionTransaction(this.snapshot, transaction);
    if (next === this.snapshot) return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }

  hydrateFromSources(hydrated: HydratedSessionState) {
    this.snapshot = hydrated;
    this.listeners.forEach((listener) => listener());
  }
}
```

```ts
// apps/web/src/session/use-session-store.ts
"use client";
import { useSyncExternalStore } from "react";
import type { SessionStore } from "./session-store";

export function useSessionStore(store: SessionStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
```

Keep `createInitialSessionState` and `reduceSessionTransaction` in the same file until a second consumer exists. `HydratedSessionState` is a local composition of generated auth-session response, generated room response, RoomEventLedger and any policy-available generated ECHO/TRACE projections; it is not a wire schema. A policy-unavailable projection is `null` with `not_available_by_policy`, not an empty scientific graph and not a fabricated version zero. No monolithic `SessionSnapshot` or room snapshot endpoint may be introduced. RoomEvent resume and analytics reconciliation proceed independently, and the store exposes ready only through `ProjectionCoordinator` when all enabled numeric cursors align.

- [ ] **Step 4: Verify store and React behavior**

Run: `pnpm --filter @learning-orbit/web test -- src/session/session-store.test.ts && pnpm --filter @learning-orbit/web typecheck`

Expected: all store tests pass; no React state library appears in `apps/web/package.json`.

- [ ] **Step 5: Commit the store**

```bash
git add apps/web/src/session/session-store.ts apps/web/src/session/use-session-store.ts apps/web/src/session/session-store.test.ts
git commit -m "feat(web): add external session store"
```

### Task 5: Implement generated realtime-frame routing and authorized ProjectionSync

**Files:**
- Move: `learning-orbit/apps/web/src/lib/realtime/room-socket.ts` → `learning-orbit/apps/web/src/session/realtime-session-client.ts`
- Move: `learning-orbit/apps/web/test/room-socket.test.ts` → `learning-orbit/apps/web/src/session/realtime-session-client.test.ts`
- Modify: `learning-orbit/apps/web/src/session/realtime-session-client.ts`
- Modify: `learning-orbit/apps/web/src/session/realtime-session-client.test.ts`
- Create: `learning-orbit/apps/web/src/session/projection-sync.ts`
- Create: `learning-orbit/apps/web/src/session/projection-sync.test.ts`
- Create: `learning-orbit/apps/web/src/session/room-event-sync.ts`
- Create: `learning-orbit/apps/web/src/session/room-event-sync.test.ts`
- Create: `learning-orbit/apps/web/src/session/ephemeral-collaboration.ts`
- Create: `learning-orbit/apps/web/src/session/ephemeral-collaboration.test.ts`
- Create: `learning-orbit/apps/web/src/testing/fake-websocket.ts`

- [ ] **Step 1: Write failing discriminated-frame, independent-deduplication and catch-up tests**

```ts
// apps/web/src/session/realtime-session-client.test.ts
import { routeContract as routes } from "../contracts/generated";
import { EPOCH_A, MEDIA_IMAGE_ID, ROOM_ID, RUN_ID } from "../testing/contract-fixtures";

it("routes generated event and projection frames with independent deduplication", () => {
  const socket = new FakeWebSocket();
  const onRoomEvent = vi.fn();
  const onMediaStatus = vi.fn();
  const onAgentStatus = vi.fn();
  const projectionSync = { onFrame: vi.fn(), reconcileApproved: vi.fn() };
  const roomEventSync = { recover: vi.fn(), recoverGap: vi.fn() };
  const agentStatusSync = { hydrateCurrent: vi.fn() };
  const client = new RealtimeSessionClient({ socketFactory: () => socket, onRoomEvent, onMediaStatus, onAgentStatus, onControlFrame: vi.fn(), projectionSync, roomEventSync, agentStatusSync });
  client.connect(new URL(routes.rooms.websocket(ROOM_ID), "wss://classroom.test").toString());
  socket.open();
  expect(socket.sentFrames()).toEqual([{ type: "hello", resumeFrom: 0 }]);
  expect(projectionSync.reconcileApproved).not.toHaveBeenCalled();
  socket.receive(realtimeFrameJson({ type: "event", event: roomEvent({ roomSeq: 1 }) }));
  socket.receive(realtimeFrameJson({ type: "event", event: roomEvent({ roomSeq: 1 }) }));
  socket.receive(realtimeFrameJson(projectionFrame({ projectionKey: "echo.student_approved", analysisEpoch: EPOCH_A, projectionVersion: 4 })));
  socket.receive(realtimeFrameJson(projectionFrame({ projectionKey: "echo.student_approved", analysisEpoch: EPOCH_A, projectionVersion: 4 })));
  socket.receive(realtimeFrameJson(projectionFrame({ projectionKey: "trace.student_bundle", analysisEpoch: EPOCH_A, projectionVersion: 4 })));
  socket.receive(realtimeFrameJson({ type: "media_status", mediaId: MEDIA_IMAGE_ID, state: "processing", failureCode: null, updatedAt: "2026-08-28T09:17:59+08:00" }));
  socket.receive(realtimeFrameJson({ type: "agent_status", roomId: ROOM_ID, agentRunId: RUN_ID, state: "running", serviceHealth: "healthy", agentEnabled: true, failureCode: null, updatedAt: "2026-08-28T09:18:00+08:00" }));
  socket.receive(realtimeFrameJson({ type: "event", event: roomEvent({ roomSeq: 2 }) }));
  socket.receive(realtimeFrameJson({ type: "resume_complete", throughRoomSeq: 2 }));
  expect(onRoomEvent.mock.calls.map(([event]) => event.roomSeq)).toEqual([1, 2]);
  expect(projectionSync.onFrame).toHaveBeenCalledTimes(2);
  expect(onMediaStatus).toHaveBeenCalledTimes(1);
  expect(onAgentStatus).toHaveBeenCalledTimes(1);
  expect(client.getHighestRoomSeq()).toBe(2);
  expect(onRoomEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "projection" }));
  expect(projectionSync.reconcileApproved).toHaveBeenCalledTimes(1);
  expect(agentStatusSync.hydrateCurrent).toHaveBeenCalledTimes(1);
});

it("recovers snapshot_required room events before reconnecting with the new cursor", async () => {
  const sockets: FakeWebSocket[] = [];
  const roomEventSync = { recover: vi.fn().mockResolvedValue(42), recoverGap: vi.fn() };
  const projectionSync = { onFrame: vi.fn(), reconcileApproved: vi.fn() };
  const client = new RealtimeSessionClient({ socketFactory: () => { const socket = new FakeWebSocket(); sockets.push(socket); return socket; }, onRoomEvent: vi.fn(), onMediaStatus: vi.fn(), onAgentStatus: vi.fn(), onControlFrame: vi.fn(), projectionSync, roomEventSync, agentStatusSync: { hydrateCurrent: vi.fn() } });
  client.connect(new URL(routes.rooms.websocket(ROOM_ID), "wss://classroom.test").toString());
  const socket = sockets[0];
  socket.open();
  const snapshotUrl = routes.rooms.events(ROOM_ID, { afterSeq: 8, limit: 500 });
  socket.receive(realtimeFrameJson({ type: "snapshot_required", snapshotUrl, throughRoomSeq: 42 }));
  await vi.runAllTimersAsync();
  expect(roomEventSync.recover).toHaveBeenCalledWith(snapshotUrl, 42);
  expect(client.getHighestRoomSeq()).toBe(42);
  expect(projectionSync.reconcileApproved).not.toHaveBeenCalled();
  sockets.at(-1)!.open();
  expect(sockets.at(-1)!.sentFrames()).toContainEqual({ type: "hello", resumeFrom: 42 });
});

it("hands a live RoomEvent gap to RoomEventSync without advancing the client cursor", async () => {
  const socket = new FakeWebSocket();
  const onRoomEvent = vi.fn();
  const projectionSync = { onFrame: vi.fn(), reconcileApproved: vi.fn() };
  const agentStatusSync = { hydrateCurrent: vi.fn() };
  const roomEventSync = { recover: vi.fn(), recoverGap: vi.fn().mockResolvedValue(3) };
  const client = new RealtimeSessionClient({ socketFactory: () => socket, onRoomEvent, onMediaStatus: vi.fn(), onAgentStatus: vi.fn(), onControlFrame: vi.fn(), projectionSync, roomEventSync, agentStatusSync });
  client.connect(new URL(routes.rooms.websocket(ROOM_ID), "wss://classroom.test").toString());
  socket.open();
  socket.receive(realtimeFrameJson({ type: "event", event: roomEvent({ roomSeq: 1 }) }));
  socket.receive(realtimeFrameJson({ type: "event", event: roomEvent({ roomSeq: 3 }) }));
  expect(client.getHighestRoomSeq()).toBe(1);
  expect(onRoomEvent.mock.calls.map(([event]) => event.roomSeq)).toEqual([1]);
  expect(roomEventSync.recoverGap).toHaveBeenCalledWith(1, 3);
  await vi.runAllTimersAsync();
  expect(client.getHighestRoomSeq()).toBe(3);
});

it("rejects raw provider deltas because they are absent from the generated realtime union", () => {
  expect(() => realtimeContract.parseRealtimeFrame(JSON.stringify({ type: "provider_delta", provider: "hidden", text: "raw token" }))).toThrow();
  expect(screen.queryByText("raw token")).not.toBeInTheDocument();
});

it("routes TTL-scoped presence typing and degraded frames outside the ledger", async () => {
  const onEphemeralSignal = vi.fn();
  const onDegraded = vi.fn();
  const client = realtimeClient({ onEphemeralSignal, onDegraded });
  client.socket.receive(realtimeFrameJson({ type: "presence", actorId: ACTOR_B, state: "active", expiresAt: "2026-08-28T09:18:30+08:00" }));
  client.socket.receive(realtimeFrameJson({ type: "typing", actorId: ACTOR_B, active: true, expiresAt: "2026-08-28T09:18:05+08:00" }));
  client.socket.receive(realtimeFrameJson({ type: "degraded", scope: "analytics", code: "PROJECTION_BACKLOG", updatedAt: "2026-08-28T09:18:00+08:00", retryAfterMs: 2000 }));
  expect(onEphemeralSignal).toHaveBeenCalledTimes(2);
  expect(onDegraded).toHaveBeenCalledWith(expect.objectContaining({ scope: "analytics", code: "PROJECTION_BACKLOG" }));
  expect(onRoomEvent).not.toHaveBeenCalled();
  await clock.advance(5_001);
  expect(ephemeralState.typingActors).not.toContain(ACTOR_B);
});

it("clears only the student analytics key named by a revocation frame", () => {
  const projectionSync = studentProjectionSyncWithBothKeysReady();
  projectionSync.onDegraded({ type: "degraded", scope: "analytics", code: "STUDENT_ANALYTICS_NOT_PROMOTED", projectionKey: "trace.student_bundle", updatedAt: "2026-08-28T09:20:00Z" });
  expect(store.getProjectionCursor("trace.student_bundle")).toBeNull();
  expect(store.getProjectionAvailability("trace.student_bundle")).toBe("not_available_by_policy");
  expect(store.getProjectionCursor("echo.student_approved")).toEqual(expect.objectContaining({ projectionVersion: 13 }));
  expect(store.getSnapshot().ledger.projectionVersion).toBe(42);
});

// apps/web/src/session/room-event-sync.test.ts
it("validates the snapshot_required URL and paginates RoomEvents through the required cursor", async () => {
  gateway.getRoomEventsPage
    .mockResolvedValueOnce({ events: [roomEvent({ roomSeq: 9 }), roomEvent({ roomSeq: 10 })], throughRoomSeq: 10 })
    .mockResolvedValueOnce({ events: [roomEvent({ roomSeq: 11 })], throughRoomSeq: 11 });
  const sync = new RoomEventSync({ roomId: ROOM_ID, apiOrigin, gateway, applyRoomEvent });
  expect(await sync.recover(routes.rooms.events(ROOM_ID, { afterSeq: 8, limit: 2 }), 11)).toBe(11);
  expect(applyRoomEvent.mock.calls.map(([event]) => event.roomSeq)).toEqual([9, 10, 11]);
  expect(gateway.getRoomEventsPage.mock.calls[1][0]).toEqual(new URL(routes.rooms.events(ROOM_ID, { afterSeq: 10, limit: 2 }), apiOrigin));
});

it.each([crossOriginEventsUrl, wrongRoomEventsUrl, wrongPathEventsUrl, limitOver500Url])("rejects an untrusted RoomEvent snapshot URL", async (snapshotUrl) => {
  const sync = new RoomEventSync({ roomId: ROOM_ID, apiOrigin, gateway, applyRoomEvent });
  await expect(sync.recover(snapshotUrl, 42)).rejects.toThrow("room_event_snapshot_url_rejected");
  expect(gateway.getRoomEventsPage).not.toHaveBeenCalled();
});

// apps/web/src/session/projection-sync.test.ts
it("uses patches only for the same epoch and exactly local projectionVersion plus one", async () => {
  const gateway = projectionGateway({ patches: [conceptPatchV5] });
  const sync = new ProjectionSync({ roomId: ROOM_ID, role: "student", apiOrigin, gateway, store });
  store.seedProjection("echo.student_approved", { analysisEpoch: EPOCH_A, projectionVersion: 4, completeThroughRoomSeq: 126 });
  await sync.onFrame(projectionFrame({ projectionKey: "echo.student_approved", analysisEpoch: EPOCH_A, projectionVersion: 5, completeThroughRoomSeq: 128, snapshotUrl: routes.analytics.latest(ROOM_ID, "echo.student_approved") }));
  expect(gateway.getProjectionPatches).toHaveBeenCalledWith(ROOM_ID, "echo.student_approved", EPOCH_A, 4);
  expect(store.applyGeneratedProjection).toHaveBeenCalledWith("echo.student_approved", conceptPatchV5);
  expect(gateway.getProjectionSnapshot).not.toHaveBeenCalled();
});

it.each(["epoch_changed", "version_gap", "http_409", "base_version_mismatch"] as const)("falls back to the validated frame snapshot for %s", async (cause) => {
  const gateway = projectionGatewayForFallback(cause, conceptSnapshotV9);
  const sync = new ProjectionSync({ roomId: ROOM_ID, role: "teacher", apiOrigin, gateway, store });
  await sync.onFrame(teacherProjectionFrame({ cause, snapshotUrl: routes.analytics.latest(ROOM_ID, "echo.teacher_shadow") }));
  expect(gateway.getProjectionSnapshot).toHaveBeenCalledWith(new URL(routes.analytics.latest(ROOM_ID, "echo.teacher_shadow"), apiOrigin), "echo.teacher_shadow");
  expect(store.replaceGeneratedProjection).toHaveBeenCalledWith("echo.teacher_shadow", conceptSnapshotV9);
});

it("rejects cross-origin, wrong-room, wrong-key and role-forbidden snapshot URLs", async () => {
  const sync = new ProjectionSync({ roomId: ROOM_ID, role: "student", apiOrigin, gateway, store });
  for (const frame of [crossOriginFrame, wrongRoomFrame, wrongKeyFrame, teacherOnlyFrame]) await expect(sync.onFrame(frame)).rejects.toThrow("projection_snapshot_url_rejected");
  expect(gateway.getProjectionSnapshot).not.toHaveBeenCalled();
});

it.each([
  ["student", ["echo.student_approved", "trace.student_bundle"]],
  ["teacher", ["echo.teacher_shadow", "trace.teacher_bundle"]],
] as const)("actively reconciles the approved %s projection endpoints after reconnect", async (role, keys) => {
  const sync = new ProjectionSync({ roomId: ROOM_ID, role, apiOrigin, gateway, store });
  await sync.reconcileApproved();
  expect(gateway.getProjectionLatest.mock.calls.map(([, key]) => key)).toEqual(keys);
});
```

- [ ] **Step 2: Run the test and verify the missing client**

Run: `pnpm --filter @learning-orbit/web test -- src/session/realtime-session-client.test.ts src/session/room-event-sync.test.ts src/session/projection-sync.test.ts`

Expected: FAIL because `RealtimeSessionClient`, `RoomEventSync`, `ProjectionSync` and `FakeWebSocket` are missing.

- [ ] **Step 3: Add an injectable WebSocket client**

```ts
// apps/web/src/session/realtime-session-client.ts
import type { AgentStatusFrame, MediaStatusFrame, RealtimeFrame, RoomEventEnvelope } from "../contracts/generated";
import { realtimeContract } from "../contracts/generated";
import type { ProjectionSync } from "./projection-sync";
import type { RoomEventSync } from "./room-event-sync";

type RealtimeClientOptions = {
  socketFactory: (url: string) => WebSocketLike;
  onRoomEvent: (event: RoomEventEnvelope) => void;
  onMediaStatus: (frame: MediaStatusFrame) => void;
  onAgentStatus: (frame: AgentStatusFrame) => void;
  onControlFrame: (frame: Exclude<RealtimeFrame, { type: "event" } | { type: "projection" } | { type: "media_status" } | { type: "agent_status" }>) => void;
  onStatus?: (status: "connecting" | "connected" | "reconnecting") => void;
  projectionSync: Pick<ProjectionSync, "onFrame" | "reconcileApproved">;
  roomEventSync: Pick<RoomEventSync, "recover" | "recoverGap">;
  agentStatusSync: { hydrateCurrent: () => Promise<void> | void };
};

export class RealtimeSessionClient {
  private socket: WebSocketLike | null = null;
  private highestRoomSeq = 0;
  private projectionVersions = new Map<string, number>();
  private url = "";

  constructor(private readonly options: RealtimeClientOptions) {}

  getHighestRoomSeq() { return this.highestRoomSeq; }

  connect(url: string) {
    this.url = url;
    this.options.onStatus?.("connecting");
    this.socket = this.options.socketFactory(url);
    this.socket.addEventListener("open", () => {
      this.options.onStatus?.("connected");
      this.socket!.send(realtimeContract.encodeClientFrame({ type: "hello", resumeFrom: this.highestRoomSeq }));
    });
    this.socket.addEventListener("message", (event) => {
      const frame = realtimeContract.parseRealtimeFrame(String(event.data));
      if (frame.type === "event") {
        if (frame.event.roomSeq <= this.highestRoomSeq) return;
        if (frame.event.roomSeq !== this.highestRoomSeq + 1) {
          void this.options.roomEventSync.recoverGap(this.highestRoomSeq, frame.event.roomSeq).then((throughRoomSeq) => { this.highestRoomSeq = throughRoomSeq; });
          return;
        }
        this.options.onRoomEvent(frame.event);
        this.highestRoomSeq = frame.event.roomSeq;
        return;
      }
      if (frame.type === "projection") {
        const identity = `${frame.projectionKey}\u0000${frame.analysisEpoch}`;
        if (frame.projectionVersion <= (this.projectionVersions.get(identity) ?? 0)) return;
        this.projectionVersions.set(identity, frame.projectionVersion);
        void this.options.projectionSync.onFrame(frame);
        return;
      }
      if (frame.type === "agent_status") {
        this.options.onAgentStatus(frame);
        return;
      }
      if (frame.type === "media_status") {
        this.options.onMediaStatus(frame);
        return;
      }
      if (frame.type === "resume_complete") {
        this.options.onControlFrame(frame);
        void Promise.resolve(this.options.agentStatusSync.hydrateCurrent()).then(() => this.options.projectionSync.reconcileApproved());
        return;
      }
      if (frame.type === "snapshot_required") {
        this.options.onControlFrame(frame);
        void this.options.roomEventSync.recover(frame.snapshotUrl, frame.throughRoomSeq).then((throughRoomSeq) => {
          this.highestRoomSeq = throughRoomSeq;
          this.socket?.close(4001, "room_event_snapshot_applied");
          this.connect(this.url);
        });
        return;
      }
      this.options.onControlFrame(frame);
    });
    this.socket.addEventListener("close", () => this.options.onStatus?.("reconnecting"));
  }

  send(command: unknown) {
    if (!this.socket || this.socket.readyState !== 1) throw new Error("realtime_not_connected");
    this.socket.send(realtimeContract.encodeRoomCommand(command));
  }

  close() { this.socket?.close(1000, "session_exit"); this.socket = null; }
}
```

```ts
// apps/web/src/session/room-event-sync.ts
import type { RoomEventEnvelope } from "../contracts/generated";
import { routeContract as routes } from "../contracts/generated";

export interface RoomEventSyncGateway {
  getRoomEventsPage(url: URL): Promise<RoomEventPage>;
}

export class RoomEventSync {
  constructor(private readonly options: { roomId: string; apiOrigin: URL; gateway: RoomEventSyncGateway; applyRoomEvent: (event: RoomEventEnvelope) => void }) {}

  async recover(snapshotUrl: string, requiredThroughRoomSeq: number) {
    let url = this.validatedEventsUrl(snapshotUrl);
    const limit = Number(url.searchParams.get("limit"));
    let cursor = Number(url.searchParams.get("afterSeq"));
    while (cursor < requiredThroughRoomSeq) {
      const page = await this.options.gateway.getRoomEventsPage(url);
      const events = [...page.events].sort((a, b) => a.roomSeq - b.roomSeq);
      if (!events.length || page.throughRoomSeq <= cursor) throw new Error("room_event_snapshot_no_progress");
      for (const event of events) {
        if (event.roomSeq > cursor && event.roomSeq <= requiredThroughRoomSeq) this.options.applyRoomEvent(event);
      }
      cursor = Math.min(page.throughRoomSeq, requiredThroughRoomSeq);
      url = new URL(routes.rooms.events(this.options.roomId, { afterSeq: cursor, limit }), this.options.apiOrigin);
    }
    return cursor;
  }

  recoverGap(afterSeq: number, throughRoomSeq: number) {
    return this.recover(routes.rooms.events(this.options.roomId, { afterSeq, limit: 500 }), throughRoomSeq);
  }

  private validatedEventsUrl(snapshotUrl: string) {
    const candidate = new URL(snapshotUrl, this.options.apiOrigin);
    const afterSeq = Number(candidate.searchParams.get("afterSeq"));
    const limit = Number(candidate.searchParams.get("limit"));
    const expected = new URL(routes.rooms.events(this.options.roomId, { afterSeq, limit }), this.options.apiOrigin);
    if (!Number.isInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500 || candidate.searchParams.size !== 2 || candidate.origin !== expected.origin || candidate.pathname !== expected.pathname || candidate.search !== expected.search) throw new Error("room_event_snapshot_url_rejected");
    return candidate;
  }
}
```

```ts
// apps/web/src/session/projection-sync.ts
import type { AuthSession, ConceptMapPatch, ConceptMapSnapshot, ProjectionFrame, RealtimeFrame, SnaProjectionBundle } from "../contracts/generated";
import { routeContract as routes } from "../contracts/generated";

const PROJECTION_KEYS_BY_ROLE = {
  student: ["echo.student_approved", "trace.student_bundle"],
  teacher: ["echo.teacher_shadow", "trace.teacher_bundle"],
} as const satisfies Record<AuthSession["role"], readonly ProjectionFrame["projectionKey"][]>;

type ProjectionPayload = ConceptMapPatch | ConceptMapSnapshot | SnaProjectionBundle;
type ProjectionCursor = { analysisEpoch: string; projectionVersion: number; completeThroughRoomSeq: number };
type ProjectionAvailability = "loading" | "ready" | "not_available_by_policy" | "failed";
type ProjectionStore = {
  getProjectionCursor: (projectionKey: ProjectionFrame["projectionKey"]) => ProjectionCursor | null;
  applyGeneratedProjection: (projectionKey: ProjectionFrame["projectionKey"], payload: ProjectionPayload) => void;
  replaceGeneratedProjection: (projectionKey: ProjectionFrame["projectionKey"], payload: ProjectionPayload) => void;
  clearGeneratedProjection: (projectionKey: ProjectionFrame["projectionKey"]) => void;
  setProjectionAvailability: (projectionKey: ProjectionFrame["projectionKey"], state: ProjectionAvailability) => void;
};

export interface ProjectionSyncGateway {
  getProjectionLatest(roomId: string, projectionKey: ProjectionFrame["projectionKey"]): Promise<ProjectionPayload>;
  getProjectionPatches(roomId: string, projectionKey: ProjectionFrame["projectionKey"], query: { analysisEpoch: string; afterProjectionVersion: number }): Promise<readonly ProjectionPayload[]>;
  getProjectionSnapshot(url: URL, projectionKey: ProjectionFrame["projectionKey"]): Promise<ProjectionPayload>;
}

type ProjectionSyncOptions = { roomId: string; role: AuthSession["role"]; apiOrigin: URL; gateway: ProjectionSyncGateway; store: ProjectionStore };
const isHttp409 = (error: unknown) => typeof error === "object" && error !== null && "status" in error && error.status === 409;
const isNotPromoted = (error: unknown) => typeof error === "object" && error !== null && "status" in error && "code" in error && error.status === 403 && error.code === "STUDENT_ANALYTICS_NOT_PROMOTED";
const isProjectionBaselineMismatch = (error: unknown) => error instanceof Error && error.name === "ProjectionBaselineMismatchError";

export class ProjectionSync {
  constructor(private readonly options: ProjectionSyncOptions) {}

  async onFrame(frame: ProjectionFrame) {
    this.assertAllowed(frame.projectionKey);
    const local = this.options.store.getProjectionCursor(frame.projectionKey);
    if (!local || frame.analysisEpoch !== local.analysisEpoch || frame.projectionVersion !== local.projectionVersion + 1) return this.replaceFromFrameSnapshot(frame);
    try {
      const patches = await this.options.gateway.getProjectionPatches(this.options.roomId, frame.projectionKey, { analysisEpoch: frame.analysisEpoch, afterProjectionVersion: local.projectionVersion });
      for (const payload of patches) this.apply(frame.projectionKey, payload);
      const applied = this.options.store.getProjectionCursor(frame.projectionKey);
      if (!applied || applied.analysisEpoch !== frame.analysisEpoch || applied.projectionVersion !== frame.projectionVersion || applied.completeThroughRoomSeq !== frame.completeThroughRoomSeq) return this.replaceFromFrameSnapshot(frame);
    } catch (error) {
      if (this.options.role === "student" && isNotPromoted(error)) {
        this.options.store.clearGeneratedProjection(frame.projectionKey);
        this.options.store.setProjectionAvailability(frame.projectionKey, "not_available_by_policy");
        return;
      }
      if (!isHttp409(error) && !isProjectionBaselineMismatch(error)) throw error;
      await this.replaceFromFrameSnapshot(frame);
    }
  }

  onDegraded(frame: Extract<RealtimeFrame, { type: "degraded" }>) {
    if (frame.scope !== "analytics" || frame.code !== "STUDENT_ANALYTICS_NOT_PROMOTED" || !frame.projectionKey) return;
    this.assertAllowed(frame.projectionKey);
    if (this.options.role !== "student") return;
    this.options.store.clearGeneratedProjection(frame.projectionKey);
    this.options.store.setProjectionAvailability(frame.projectionKey, "not_available_by_policy");
  }

  async reconcileApproved() {
    for (const projectionKey of PROJECTION_KEYS_BY_ROLE[this.options.role]) {
      let latest: ProjectionPayload;
      try {
        latest = await this.options.gateway.getProjectionLatest(this.options.roomId, projectionKey);
        this.options.store.setProjectionAvailability(projectionKey, "ready");
      } catch (error) {
        if (this.options.role === "student" && isNotPromoted(error)) {
          this.options.store.clearGeneratedProjection(projectionKey);
          this.options.store.setProjectionAvailability(projectionKey, "not_available_by_policy");
          continue;
        }
        this.options.store.setProjectionAvailability(projectionKey, "failed");
        throw error;
      }
      const local = this.options.store.getProjectionCursor(projectionKey);
      if (local && local.analysisEpoch === latest.analysisEpoch && latest.projectionVersion > local.projectionVersion) {
        try {
          const patches = await this.options.gateway.getProjectionPatches(this.options.roomId, projectionKey, { analysisEpoch: local.analysisEpoch, afterProjectionVersion: local.projectionVersion });
          for (const payload of patches) this.apply(projectionKey, payload);
          continue;
        } catch (error) {
          if (this.options.role === "student" && isNotPromoted(error)) {
            this.options.store.clearGeneratedProjection(projectionKey);
            this.options.store.setProjectionAvailability(projectionKey, "not_available_by_policy");
            continue;
          }
          if (!isHttp409(error) && !isProjectionBaselineMismatch(error)) throw error;
        }
      }
      this.replace(projectionKey, latest);
    }
  }

  private async replaceFromFrameSnapshot(frame: ProjectionFrame) {
    const url = this.validatedSnapshotUrl(frame);
    try {
      this.replace(frame.projectionKey, await this.options.gateway.getProjectionSnapshot(url, frame.projectionKey));
      this.options.store.setProjectionAvailability(frame.projectionKey, "ready");
    } catch (error) {
      if (this.options.role === "student" && isNotPromoted(error)) {
        this.options.store.clearGeneratedProjection(frame.projectionKey);
        this.options.store.setProjectionAvailability(frame.projectionKey, "not_available_by_policy");
        return;
      }
      throw error;
    }
  }

  private validatedSnapshotUrl(frame: ProjectionFrame) {
    this.assertAllowed(frame.projectionKey);
    const candidate = new URL(frame.snapshotUrl, this.options.apiOrigin);
    const expected = new URL(routes.analytics.latest(this.options.roomId, frame.projectionKey), this.options.apiOrigin);
    if (candidate.origin !== expected.origin || candidate.pathname !== expected.pathname || candidate.search !== expected.search) throw new Error("projection_snapshot_url_rejected");
    return candidate;
  }

  private assertAllowed(projectionKey: ProjectionFrame["projectionKey"]) {
    if (!PROJECTION_KEYS_BY_ROLE[this.options.role].includes(projectionKey as never)) throw new Error("projection_snapshot_url_rejected");
  }

  private apply(key: ProjectionFrame["projectionKey"], payload: ProjectionPayload) {
    this.options.store.applyGeneratedProjection(key, payload);
  }

  private replace(key: ProjectionFrame["projectionKey"], payload: ProjectionPayload) {
    this.options.store.replaceGeneratedProjection(key, payload);
  }
}
```

Use the exact generated parser and narrowing exported by `packages/contracts/src/realtime.ts`; do not declare a local realtime-frame wire type. Freeze the switch contract in tests: `type: "event"` reads only `frame.event`; `type: "projection"` reads top-level `projectionKey`, `analysisEpoch`, `projectionVersion`, `completeThroughRoomSeq` and `snapshotUrl`; `type: "media_status"` carries only generated `mediaId`, public state, bounded failure code and update time to the media cache; `type: "agent_status"` carries generated `roomId`, nullable `agentRunId`, state, `serviceHealth`, `agentEnabled`, bounded failure code and update time to the Agent presentation reducer; generated `presence` and `typing` update only TTL-scoped collaboration indicators; generated `degraded` updates only the named scope's honest status. A targeted analytics `STUDENT_ANALYTICS_NOT_PROMOTED` frame immediately clears the named student projection data/cursor and marks only that panel policy-unavailable; it cannot hide the other key or chat. Reject an Agent/status frame whose room or schema differs from the hydrated session. Welcome, ack, reject, resume_complete and snapshot_required go only to `onControlFrame`. Projection, media-status, agent-status, presence, typing and degraded frames never call `onRoomEvent`, never enter `EventLedger`, never mutate `highestRoomSeq`, and never advance another projection version. A missed media frame is repaired through authenticated `routes.media.get(roomId, mediaId)`. Expired presence means unknown, typing clears after five seconds, and neither is replayed or announced per keystroke. Raw provider/token deltas are absent from the generated union and must fail parsing; chat renders only final generated `message.added` events.

This is the direct evolution of Gate 1's only production transport, not a second client. Preserve its pending-command map, same-`commandId` resend after lost ack/reconnect, ack/reject settlement, heartbeat/liveness timeout, ordered resume cursor, explicit close and bounded retry timers. Add the new frame branches around those invariants. `ephemeral-collaboration.ts` owns client-side monotonic `clientSeq`, the matching presence/typing send-rate limits and injected-clock expiry; it never writes local storage. Visibility/focus sends active/away at the bounded rate, composer changes send typing true/false, and disconnect renders unknown rather than offline. Degraded status is keyed by scope and cannot contain provider payload or student content. Migrate every Plan 01 `room-socket` test unchanged first, then add media/Agent/projection/ephemeral/degraded cases; the old file and test path must not remain after the move. A conformance test scans imports and fails if any production module creates a WebSocket outside this client.

Add bounded reconnect scheduling with delays `[250, 500, 1000, 2000, 5000]` and cancel the timer in `close()`. On every open, first send the generated hello frame `{ type: "hello", resumeFrom: highestRoomSeq }`; process welcome and ordered event frames, and do not reconcile secondary state until generated `resume_complete` confirms the chat ledger cursor. Then hydrate the student-safe current Agent state through `routes.agent.current(roomId)` and reconcile projections. For `snapshot_required`, validate the frame URL against same-origin `routes.rooms.events(roomId, { afterSeq, limit })`, require `1 <= limit <= 500`, paginate until `throughRoomSeq`, advance only by applied generated `RoomEventEnvelope.roomSeq`, then reconnect and send hello with the recovered cursor. Across both roles the four possible projection keys are `echo.student_approved`, `trace.student_bundle`, `echo.teacher_shadow` and `trace.teacher_bundle`; a student may request only the first pair, and a teacher may request only the second pair. The two student keys are independently policy gated. Exact `403 STUDENT_ANALYTICS_NOT_PROMOTED` marks only that panel `not_available_by_policy`, leaves its cursor absent, and does not block chat or the other approved panel; every other error remains a real failure. A later allowed pointer or explicit retry hydrates the newly promoted panel from latest before marking it ready. Reconciliation queries HTTP latest and, when applicable, patch endpoints instead of assuming projection frames will be replayed. The Agent current-state response exposes only generated safe `AgentRun`, service health and `agentEnabled`, never prompt/model/provider/cost details.

For a projection frame in the same `analysisEpoch` with `projectionVersion === local + 1`, request `routes.analytics.patches(roomId, projectionKey, {analysisEpoch,afterProjectionVersion:localProjectionVersion})` and apply only generated `ConceptMapPatch` or `SnaProjectionBundle` values. Epoch changes, version gaps, HTTP 409, reducer baseline mismatch, or a patch result that does not reach the frame's exact version/cursor must use that frame's `snapshotUrl`. Before any snapshot request, compare its origin, pathname and query to the URL built by `routes.analytics.latest(roomId, projectionKey)` and enforce the role allowlist; reject cross-origin, wrong-room, wrong-key and arbitrary same-origin paths without issuing a request.

- [ ] **Step 4: Verify connection lifecycle tests**

Run: `pnpm --filter @learning-orbit/web test -- src/session/realtime-session-client.test.ts src/session/room-event-sync.test.ts src/session/projection-sync.test.ts`

Expected: all migrated Gate 1 pending/ack/reject/lost-ack/resend/heartbeat/resume tests plus generated frame parsing, independent RoomEvent/projection/media/Agent routing, live gap recovery without cursor advance, bounded pagination, no-ledger status/projection routing, analytics fallback, hostile URL rejection, role allowlists, reconciliation and explicit close tests pass with fake timers.

- [ ] **Step 5: Commit realtime transport**

```bash
git add apps/web/src/session/realtime-session-client.ts apps/web/src/session/realtime-session-client.test.ts apps/web/src/session/room-event-sync.ts apps/web/src/session/room-event-sync.test.ts apps/web/src/session/projection-sync.ts apps/web/src/session/projection-sync.test.ts apps/web/src/session/ephemeral-collaboration.ts apps/web/src/session/ephemeral-collaboration.test.ts apps/web/src/testing/fake-websocket.ts
git commit -m "feat(web): sync independent analytics frames"
```

### Task 6: Coordinate atomic chat, concept and SNA projections

**Files:**
- Create: `learning-orbit/apps/web/src/session/projection-coordinator.ts`
- Create: `learning-orbit/apps/web/src/session/projection-coordinator.test.ts`

- [ ] **Step 1: Write failing completeness and false-ready tests**

```ts
// apps/web/src/session/projection-coordinator.test.ts
it("[LO-HTML-10] publishes one coherent chat concept and SNA batch", () => {
  const publish = vi.fn();
  const coordinator = new ProjectionCoordinator(publish);
  coordinator.stage("chatLedger", { projectionVersion: 41, completeThroughRoomSeq: 128, value: ledgerBatch });
  coordinator.stage("concept", { projectionVersion: 12, completeThroughRoomSeq: 128, value: conceptBatch });
  expect(publish).not.toHaveBeenCalled();
  coordinator.stage("sna", { projectionVersion: 8, completeThroughRoomSeq: 127, value: snaBatch });
  expect(publish).not.toHaveBeenCalled();
  coordinator.stage("sna", { projectionVersion: 9, completeThroughRoomSeq: 128, value: snaBatch });
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({
    status: "ready",
    completeThroughRoomSeq: 128,
    projectionVersions: { chatLedger: 41, concept: 12, sna: 9 },
  }));
  expect(formatProjectionReadyStatus(publish.mock.calls[0][0])).toBe("已同步至房間序號 128（聊天投影 41、概念投影 12、SNA 投影 9）");
});

it("keeps chat and an independently promoted panel ready without inventing a cursor", () => {
  const publish = vi.fn();
  const coordinator = new ProjectionCoordinator(publish);
  coordinator.setAvailability("sna", "not_available_by_policy");
  coordinator.stage("chatLedger", { projectionVersion: 42, completeThroughRoomSeq: 129, value: ledgerBatch });
  coordinator.stage("concept", { projectionVersion: 13, completeThroughRoomSeq: 129, value: conceptBatch });
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({
    status: "ready", unavailableByPolicy: ["sna"],
    projectionVersions: { chatLedger: 42, concept: 13 }, sna: null,
  }));
  expect(publish.mock.calls[0][0].projectionVersions).not.toHaveProperty("sna");
});
```

- [ ] **Step 2: Verify the coordinator is absent**

Run: `pnpm --filter @learning-orbit/web test -- src/session/projection-coordinator.test.ts`

Expected: FAIL because `ProjectionCoordinator` is missing.

- [ ] **Step 3: Implement one pending slot per projection and room sequence**

```ts
// apps/web/src/session/projection-coordinator.ts
type ProjectionName = "chatLedger" | "concept" | "sna";
type Staged<T> = { projectionVersion: number; completeThroughRoomSeq: number; value: T };
type CoordinatedBatch = {
  status: "ready";
  completeThroughRoomSeq: number;
  projectionVersions: Partial<Record<"chatLedger" | "concept" | "sna", number>> & { chatLedger: number };
  unavailableByPolicy: Array<"concept" | "sna">;
  chatLedger: unknown;
  concept: unknown | null;
  sna: unknown | null;
};

export const formatProjectionReadyStatus = (batch: CoordinatedBatch) => {
  const parts = [`聊天投影 ${batch.projectionVersions.chatLedger}`];
  if (batch.projectionVersions.concept !== undefined) parts.push(`概念投影 ${batch.projectionVersions.concept}`);
  if (batch.projectionVersions.sna !== undefined) parts.push(`SNA 投影 ${batch.projectionVersions.sna}`);
  return `已同步至房間序號 ${batch.completeThroughRoomSeq}（${parts.join("、")}）`;
};

export class ProjectionCoordinator {
  private pending = new Map<number, Partial<Record<ProjectionName, Staged<unknown>>>>();
  private enabled = new Set<ProjectionName>(["chatLedger", "concept", "sna"]);
  constructor(private readonly publish: (batch: CoordinatedBatch) => void) {}

  setAvailability(name: Exclude<ProjectionName, "chatLedger">, state: "ready" | "not_available_by_policy") {
    if (state === "ready") this.enabled.add(name); else this.enabled.delete(name);
    for (const [cursor, slot] of this.pending) {
      if (state === "not_available_by_policy") delete slot[name];
      this.tryPublish(cursor, slot);
    }
  }

  stage(name: ProjectionName, staged: Staged<unknown>) {
    if (!this.enabled.has(name)) return;
    const slot = this.pending.get(staged.completeThroughRoomSeq) ?? {};
    slot[name] = staged;
    this.pending.set(staged.completeThroughRoomSeq, slot);
    this.tryPublish(staged.completeThroughRoomSeq, slot);
  }

  private tryPublish(cursor: number, slot: Partial<Record<ProjectionName, Staged<unknown>>>) {
    const required = [...this.enabled];
    const values = required.map((name) => slot[name]);
    if (values.some((value) => !value)) return;
    if (new Set(values.map((value) => value?.completeThroughRoomSeq)).size !== 1) return;
    if (values.some((value) => !Number.isInteger(value!.projectionVersion))) return;
    const projectionVersions = Object.fromEntries(required.map((name) => [name, slot[name]!.projectionVersion])) as CoordinatedBatch["projectionVersions"];
    this.publish({
      status: "ready",
      completeThroughRoomSeq: cursor,
      projectionVersions,
      unavailableByPolicy: (["concept", "sna"] as const).filter((name) => !this.enabled.has(name)),
      chatLedger: slot.chatLedger!.value,
      concept: this.enabled.has("concept") ? slot.concept!.value : null,
      sna: this.enabled.has("sna") ? slot.sna!.value : null,
    });
    this.pending.delete(cursor);
  }
}
```

Expose `partial`, `stale`, `recomputing`, `failed`, `not_available_by_policy`, and `ready` status text to the store. Never show “同步完成” for a partial slot. A policy-unavailable panel renders “本次課堂未開放此分析視圖” with a retry/check-policy control and no placeholder nodes, metrics or synthetic cursor. Chat and every separately promoted panel can reach a truthful ready state. When a later frame makes a panel available, call `setAvailability(name,"ready")`, hydrate latest, and require its real cursor before including it in a coordinated batch.

- [ ] **Step 4: Run atomicity, stale and failure tests**

Run: `pnpm --filter @learning-orbit/web test -- src/session/projection-coordinator.test.ts`

Expected: all coordinator tests pass; mixed numeric `completeThroughRoomSeq` values do not publish; EventLedger contributes its local chat projection version plus room-sequence cursor, while enabled chat/concept/SNA projection versions remain independent and publish only when all enabled numeric room-sequence cursors are equal. Policy-unavailable panels contribute neither a fake version nor a blocking cursor.

- [ ] **Step 5: Commit the coordinator**

```bash
git add apps/web/src/session/projection-coordinator.ts apps/web/src/session/projection-coordinator.test.ts
git commit -m "feat(web): coordinate atomic learning projections"
```

### Task 7: Build seat-code join, server-assigned identity wiring and AppShell

**Files:**
- Create: `learning-orbit/apps/web/src/session/session-gateway.ts`
- Create: `learning-orbit/apps/web/src/session/fetch-session-gateway.ts`
- Create: `learning-orbit/apps/web/src/auth/join-session.ts`
- Create: `learning-orbit/apps/web/src/auth/JoinSessionForm.tsx`
- Create: `learning-orbit/apps/web/src/auth/JoinSessionForm.test.tsx`
- Create: `learning-orbit/apps/web/src/auth/JoinSessionForm.module.css`
- Create: `learning-orbit/apps/web/src/shell/AppShell.tsx`
- Create: `learning-orbit/apps/web/src/shell/AppShell.test.tsx`
- Create: `learning-orbit/apps/web/src/shell/AppShell.module.css`
- Create: `learning-orbit/apps/web/src/shell/SessionHeader.tsx`
- Create: `learning-orbit/apps/web/src/shell/ParticipantActivity.tsx`
- Create: `learning-orbit/apps/web/src/shell/SessionHeader.test.tsx`
- Create: `learning-orbit/apps/web/src/session/session-clock.ts`
- Create: `learning-orbit/apps/web/src/session/session-clock.test.ts`
- Modify: `learning-orbit/apps/web/app/page.tsx`
- Create: `learning-orbit/apps/web/app/session/[roomId]/page.tsx`
- Create: `learning-orbit/apps/web/app/session/[roomId]/SessionWorkspace.tsx`

- [ ] **Step 1: Write failing two-field join and shell tests**

```tsx
import { ACTOR_A, NOVA_ACTOR_ID, ROOM_CODE, ROOM_ID, ROOM_MEMBER_A, SEAT_CODE_A } from "../testing/contract-fixtures";

it("submits only roomCode and seatCode, then displays the server-assigned identity", async () => {
  gateway.joinRoom.mockResolvedValue({
    roomMemberId: ROOM_MEMBER_A,
    actorId: ACTOR_A,
    pseudonym: "探索者 A",
  });
  gateway.getAuthSession.mockResolvedValue({ ...studentSessionBootstrap, role: "student", roomId: ROOM_ID, actorId: ACTOR_A, pseudonym: "探索者 A", nova: { actorId: NOVA_ACTOR_ID, actorKind: "agent", actorRole: "socratic_facilitator", displayName: "Nova Agent" } });
  render(<JoinSessionForm gateway={gateway} onHydrated={onHydrated} onNavigate={onNavigate} />);
  await user.type(screen.getByLabelText("房間代碼"), " eco s2a ");
  await user.type(screen.getByLabelText("座位代碼"), " seat2 abcde ");
  expect(screen.queryByLabelText(/顯示名稱|化名|角色/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "加入共學課堂" }));
  expect(gateway.joinRoom).toHaveBeenCalledWith({ roomCode: ROOM_CODE, seatCode: SEAT_CODE_A });
  expect(Object.keys(gateway.joinRoom.mock.calls[0][0]).sort()).toEqual(["roomCode", "seatCode"]);
  expect(gateway.joinRoom.mock.results[0].value).resolves.not.toHaveProperty("roomId");
  expect(gateway.joinRoom.mock.results[0].value).resolves.not.toHaveProperty("realtimeTicket");
  expect(gateway.getAuthSession).toHaveBeenCalledTimes(1);
  expect(onHydrated).toHaveBeenCalledWith(expect.objectContaining({ role: "student", roomId: ROOM_ID, actorId: ACTOR_A, pseudonym: "探索者 A", nova: expect.objectContaining({ actorId: NOVA_ACTOR_ID, displayName: "Nova Agent" }) }));
  expect(onNavigate).toHaveBeenCalledWith(`/session/${ROOM_ID}`);
});

it("uses one non-enumerating recovery message for malformed room and seat codes", async () => {
  gateway.joinRoom.mockRejectedValue(new Error("join_rejected"));
  render(<JoinSessionForm gateway={gateway} onHydrated={onHydrated} onNavigate={onNavigate} />);
  await user.type(screen.getByLabelText("房間代碼"), "ABC");
  await user.type(screen.getByLabelText("座位代碼"), "BAD");
  await user.click(screen.getByRole("button", { name: "加入共學課堂" }));
  expect(screen.getByRole("alert")).toHaveTextContent("無法加入課堂；請向教師確認兩個代碼後重試");
  expect(screen.queryByText(/房間代碼錯誤|座位代碼錯誤/)).not.toBeInTheDocument();
});

it("[LO-HTML-03] exposes chat concept and SNA regions with live session disclosure", () => {
  render(<AppShell session={pilotSession} connectionStatus="connected" />);
  expect(screen.getByRole("region", { name: "共學對話" })).toBeVisible();
  expect(screen.getByRole("region", { name: "概念圖 · 論證軌跡" })).toBeVisible();
  expect(screen.getByRole("region", { name: "互動網絡 · SNA" })).toBeVisible();
  expect(screen.getByText("已連線 · 受控課堂試點")).toBeVisible();
});

it("[LO-HTML-19] uses authored SVG rather than emoji for structural icons", () => {
  const { container } = render(<AppShell session={pilotSession} connectionStatus="connected" />);
  expect(container.querySelectorAll("svg[data-structural-icon]").length).toBeGreaterThan(0);
  expect(container.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
});

it("derives the fixed 45-minute progress from server time without pause extension", () => {
  const clock = createSessionClock({ serverTime: "2026-08-28T09:15:00Z", receivedAtMonotonicMs: 1_000 });
  expect(selectSessionProgress(openRoom, clock.nowAt(1_000))).toMatchObject({ elapsedSeconds: 900, remainingSeconds: 1800, ratio: 1 / 3 });
  expect(selectSessionProgress({ ...openRoom, status: "paused" }, clock.nowAt(601_000))).toMatchObject({ elapsedSeconds: 1500, remainingSeconds: 1200 });
  expect(openRoom.closesAt).toBe("2026-08-28T09:45:00Z");
});

it("shows ephemeral activity without claiming a real online count", () => {
  render(<ParticipantActivity roster={roomRoster(roomBootstrap)} activity={{ [ACTOR_B]: { presence: "active", typing: true } }} />);
  expect(screen.getByText("探索者 B 正在輸入")).toBeVisible();
  expect(screen.queryByText(/\d+ 人在線|離線/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run and verify missing components**

Run: `pnpm --filter @learning-orbit/web test -- src/auth/JoinSessionForm.test.tsx src/shell/AppShell.test.tsx`

Expected: FAIL because the form, gateway and shell are absent.

- [ ] **Step 3: Add a server-owned role boundary and semantic shell**

```ts
// apps/web/src/session/session-gateway.ts
import type { AgentCurrentState, AgentRunAccepted, AgentSettingsInput, AgentSettingsResponse, AnalyticsReviewCommand, ArtifactPageQuery, AuthSession, CancelAgentRunAccepted, CompleteMediaUploadResponse, ConceptTimelineQuery, ConceptTimelineWindow, CreateMediaUploadInput, CreateRoomRequest, CreateRoomResponse, DeleteRoomAccepted, DeleteRoomRequest, DeletionStatus, DerivedTextArtifactPage, JoinRoomRequest, JoinRoomResponse, MediaAttachmentView, MediaDownloadGrant, MediaUploadGrant, ProjectionFrame, RequestAgentRunInput, RoomCommand, RoomDetails, RoomEventEnvelope, RoomEventPage, TeacherMagicLinkAccepted, TeacherMagicLinkRequest } from "../contracts/generated";
import type { ProjectionSyncGateway } from "./projection-sync";
import type { RoomEventSyncGateway } from "./room-event-sync";

export interface SessionGateway extends ProjectionSyncGateway, RoomEventSyncGateway {
  requestTeacherMagicLink(input: TeacherMagicLinkRequest): Promise<TeacherMagicLinkAccepted>;
  createRoom(input: CreateRoomRequest): Promise<CreateRoomResponse>;
  joinRoom(input: JoinRoomRequest): Promise<JoinRoomResponse>;
  getAuthSession(): Promise<AuthSession>;
  getRoom(roomId: string): Promise<RoomDetails>;
  getRoomEvents(roomId: string, cursor: { afterSeq: number; limit: number }): Promise<RoomEventPage>;
  createMediaUpload(roomId: string, input: CreateMediaUploadInput): Promise<MediaUploadGrant>;
  completeMediaUpload(roomId: string, mediaId: string): Promise<CompleteMediaUploadResponse>;
  getMedia(roomId: string, mediaId: string): Promise<MediaAttachmentView>;
  getMediaDownloadGrant(roomId: string, mediaId: string): Promise<MediaDownloadGrant>;
  exportRoom(roomId: string, format: "json" | "csv"): Promise<ExportDownload>;
  requestRoomDeletion(roomId: string, input: DeleteRoomRequest): Promise<DeleteRoomAccepted>;
  getDeletionStatus(deletionJobId: string): Promise<DeletionStatus>;
  getRoomDeletion(roomId: string): Promise<DeleteRoomAccepted | DeletionStatus | null>;
  requestAgent(roomId: string, input: RequestAgentRunInput): Promise<AgentRunAccepted>;
  cancelAgent(roomId: string, runId: string): Promise<CancelAgentRunAccepted>;
  setAgentSettings(roomId: string, input: AgentSettingsInput): Promise<AgentSettingsResponse>;
  getCurrentAgent(roomId: string): Promise<AgentCurrentState>;
  getConceptTimeline(roomId: string, projectionKey: "echo.student_approved" | "echo.teacher_shadow", query: ConceptTimelineQuery): Promise<ConceptTimelineWindow>;
  getDerivedTextArtifacts(roomId: string, query: ArtifactPageQuery): Promise<DerivedTextArtifactPage>;
  submitAnalyticsReview(roomId: string, input: AnalyticsReviewCommand): Promise<RoomEventEnvelope>;
}

export type ExportDownload = Readonly<{ blob: Blob; fileName: string }>;

export type RoomCommandIntent =
  | { type: "room.open" | "room.pause" | "room.resume" | "room.close" }
  | { type: "message.add"; text: string; replyTo: string | null; mentions: string[]; mediaIds: string[] }
  | { type: "message.revise"; messageId: string; text: string; replyTo: string | null; mentions: string[]; baseRevision: number }
  | { type: "message.retract"; messageId: string; baseRevision: number };

export interface SessionCommandTransport { send(command: RoomCommand): string; }
export interface SessionCommandBus { send(intent: RoomCommandIntent): string; }

export function makeSessionCommandBus(input: { roomId: string; clock: () => Date; uuid: () => string; transport: SessionCommandTransport }): SessionCommandBus {
  return { send(intent) {
    const common = { commandId: input.uuid(), roomId: input.roomId, clientTime: input.clock().toISOString() };
    const command = intent.type.startsWith("room.")
      ? { ...common, type: intent.type, payload: {} }
      : intent.type === "message.add"
        ? { ...common, type: intent.type, payload: { text: intent.text, replyTo: intent.replyTo, mentions: intent.mentions, mediaIds: intent.mediaIds } }
        : intent.type === "message.revise"
          ? { ...common, type: intent.type, baseRevision: intent.baseRevision, payload: { messageId: intent.messageId, text: intent.text, replyTo: intent.replyTo, mentions: intent.mentions } }
          : { ...common, type: intent.type, baseRevision: intent.baseRevision, payload: { messageId: intent.messageId } };
    return input.transport.send(validateGeneratedRoomCommand(command));
  }};
}
```

```ts
// apps/web/src/session/fetch-session-gateway.ts
import type { ProjectionFrame } from "../contracts/generated";
import { routeContract as routes } from "../contracts/generated";

export class FetchSessionGateway implements SessionGateway {
  constructor(private readonly apiOrigin: URL) {}
  private url(path: string) { return new URL(path, this.apiOrigin); }
  joinRoom(input: JoinRoomRequest): Promise<JoinRoomResponse> { return this.post(routes.rooms.join(), input); }
  getAuthSession(): Promise<AuthSession> { return this.get(routes.auth.session()); }
  getRoom(roomId: string) { return this.get(routes.rooms.get(roomId)); }
  getRoomEvents(roomId: string, cursor: { afterSeq: number; limit: number }) { return this.get(routes.rooms.events(roomId, cursor)); }
  async getRoomEventsPage(url: URL) { if (url.origin !== this.apiOrigin.origin) throw new Error("room_event_snapshot_url_rejected"); return parseGeneratedResponse(await fetch(url, { credentials: "include" }), { schema: "room-event-page.v1" }); }
  createMediaUpload(roomId: string, input: CreateMediaUploadInput) { return this.post(routes.media.upload(roomId), input); }
  completeMediaUpload(roomId: string, mediaId: string) { return this.post(routes.media.complete(roomId, mediaId), {}); }
  getMedia(roomId: string, mediaId: string) { return this.get(routes.media.get(roomId, mediaId)); }
  getMediaDownloadGrant(roomId: string, mediaId: string) { return this.get(routes.media.download(roomId, mediaId)); }
  exportRoom(roomId: string, format: "json" | "csv") { return this.getBlobDownload(routes.rooms.export(roomId, format), `learning-orbit-room-export.${format}`); }
  requestRoomDeletion(roomId: string, input: DeleteRoomRequest) { return this.remove(routes.rooms.delete(roomId), input); }
  getDeletionStatus(deletionJobId: string) { return this.get(routes.deletions.get(deletionJobId)); }
  getRoomDeletion(roomId: string) { return this.get(routes.deletions.forRoom(roomId)); }
  requestAgent(roomId: string, input: RequestAgentRunInput) { return this.post(routes.agent.request(roomId), input); }
  cancelAgent(roomId: string, runId: string) { return this.post(routes.agent.cancel(roomId, runId), {}); }
  setAgentSettings(roomId: string, input: AgentSettingsInput) { return this.put(routes.agent.settings(roomId), input); }
  getCurrentAgent(roomId: string) { return this.get(routes.agent.current(roomId)); }
  getConceptTimeline(roomId: string, projectionKey: "echo.student_approved" | "echo.teacher_shadow", query: ConceptTimelineQuery) { return this.get(routes.analytics.timeline(roomId, projectionKey, query)); }
  getDerivedTextArtifacts(roomId: string, query: ArtifactPageQuery) { return this.get(routes.analytics.artifacts(roomId, query)); }
  submitAnalyticsReview(roomId: string, input: AnalyticsReviewCommand) { return this.post(routes.analytics.reviews(roomId), input); }
  requestTeacherMagicLink(input: TeacherMagicLinkRequest) { return this.post(routes.auth.teacherMagicLink(), input); }
  createRoom(input: CreateRoomRequest) { return this.post(routes.rooms.create(), input); }
  getProjectionLatest(roomId: string, projectionKey: ProjectionFrame["projectionKey"]) { return this.getGeneratedProjection(routes.analytics.latest(roomId, projectionKey), projectionKey); }
  getProjectionPatches(roomId: string, projectionKey: ProjectionFrame["projectionKey"], query: { analysisEpoch: string; afterProjectionVersion: number }) { return this.getGeneratedProjectionList(routes.analytics.patches(roomId, projectionKey, query), projectionKey); }
  async getProjectionSnapshot(url: URL, projectionKey: ProjectionFrame["projectionKey"]) { if (url.origin !== this.apiOrigin.origin) throw new Error("projection_snapshot_url_rejected"); return parseGeneratedResponse(await fetch(url, { credentials: "include" }), { projectionKey, cardinality: "one" }); }
  private async getGeneratedProjection(path: string, projectionKey: ProjectionFrame["projectionKey"]) { return parseGeneratedResponse(await fetch(this.url(path), { credentials: "include" }), { projectionKey, cardinality: "one" }); }
  private async getGeneratedProjectionList(path: string, projectionKey: ProjectionFrame["projectionKey"]) { return parseGeneratedResponse(await fetch(this.url(path), { credentials: "include" }), { projectionKey, cardinality: "many" }); }
  private async get(path: string) { return parseGeneratedResponse(await fetch(this.url(path), { credentials: "include" })); }
  private async post(path: string, body: unknown) { return parseGeneratedResponse(await fetch(this.url(path), { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })); }
  private async put(path: string, body: unknown) { return parseGeneratedResponse(await fetch(this.url(path), { method: "PUT", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })); }
  private async remove(path: string, body: unknown) { return parseGeneratedResponse(await fetch(this.url(path), { method: "DELETE", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })); }
  private async getBlobDownload(path: string, fallback: string): Promise<ExportDownload> { const response = await fetch(this.url(path), { credentials: "include", cache: "no-store" }); if (!response.ok) throw new Error(`http_${response.status}`); return { blob: await response.blob(), fileName: parseSafeAttachmentFileName(response.headers.get("content-disposition"), fallback) }; }
}
```

```ts
// apps/web/src/auth/join-session.ts
import type { JoinRoomRequest } from "../contracts/generated";

export function createJoinRoomRequest(roomCode: string, seatCode: string): JoinRoomRequest {
  return { roomCode: roomCode.replace(/\s+/g, "").toUpperCase(), seatCode: seatCode.replace(/\s+/g, "").toUpperCase() };
}
```

```tsx
// apps/web/src/auth/JoinSessionForm.tsx
export function JoinSessionForm({ gateway, onHydrated, onNavigate }: JoinSessionFormProps) {
  const [roomCode, setRoomCode] = useState("");
  const [seatCode, setSeatCode] = useState("");
  const [status, setStatus] = useState("輸入教師提供的房間代碼與座位代碼");
  return <form onSubmit={async (event) => {
    event.preventDefault();
    const joined = await gateway.joinRoom(createJoinRoomRequest(roomCode, seatCode));
    const session = await gateway.getAuthSession();
    if (session.actorId !== joined.actorId || session.pseudonym !== joined.pseudonym) throw new Error("join_session_identity_mismatch");
    setStatus(`已由伺服器分配顯示名稱：${session.pseudonym}`);
    onHydrated(session);
    onNavigate(`/session/${session.roomId}`);
  }}>
    <label htmlFor="room-code">房間代碼</label>
    <input id="room-code" name="roomCode" value={roomCode} onChange={(event) => setRoomCode(event.target.value)} autoComplete="off" spellCheck={false} required />
    <label htmlFor="seat-code">座位代碼</label>
    <input id="seat-code" name="seatCode" value={seatCode} onChange={(event) => setSeatCode(event.target.value)} autoComplete="off" spellCheck={false} required />
    <button type="submit">加入共學課堂</button>
    <p role="status" aria-live="polite">{status}</p>
  </form>;
}
```

After `routes.rooms.join()` succeeds, the server sets the opaque HttpOnly authentication cookie and returns only `{ roomMemberId, actorId, pseudonym }`. Immediately call `routes.auth.session()` with `GET /v1/auth/session`; only that generated student branch may supply `role`, `roomId`, `actorId`, `pseudonym` and the server-owned `nova { actorId, actorKind, actorRole, displayName }`. Then fetch generated `RoomDetails` and build a local roster from `room.participants + room.nova`; do not invent a `members` wire field. Navigate to `/session/${roomId}` only after this hydration. Create the WebSocket URL only with `routes.rooms.websocket(roomId)` (`/v1/rooms/:roomId/realtime`); browser cookie authentication is automatic, and no ticket or auth query parameter exists. Normalize whitespace and lowercase before submit, then let the generated request/parser enforce `roomCode` as `^[A-Z2-9]{6}$` and `seatCode` as ten characters from the same alphabet. Any rejection uses the same combined recovery message and never reveals which code matched.

```tsx
// apps/web/src/shell/AppShell.tsx
export function AppShell({ session, connectionStatus, children }: AppShellProps) {
  return <>
    <a className={styles.skipLink} href="#workspace">跳到共學工作區</a>
    <SessionHeader session={session} connectionStatus={connectionStatus} />
    <main id="workspace" className={styles.workspace} tabIndex={-1}>{children}</main>
  </>;
}
```

`FetchSessionGateway` must import every REST URL builder from `packages/contracts/src/routes.ts`; `joinRoom` calls `routes.rooms.join()` with a generated `JoinRoomRequest` containing exactly `roomCode` and `seatCode`, and `getAuthSession` calls `routes.auth.session()`. The client must not send or synthesize `pseudonym`, `role`, `actorKind` or `roomId`. Set `credentials: "include"`; never read, persist or construct the opaque cookie. `RealtimeSessionClient` imports its generated frame helpers from `packages/contracts/src/realtime.ts`. Components emit only the closed local `RoomCommandIntent`; `makeSessionCommandBus` injects the authenticated route room, a UUID and clock, maps to the generated payload shape, validates the complete `RoomCommand`, and gives that immutable command to the one realtime transport. Lost-ack/reconnect retry resends that same stored command and `commandId`; it never calls the factory again. Tests reject missing base revisions, stray wire fields, a component-supplied room/actor/clock/command ID and a retry with a changed ID.

`SessionHeader` renders the generated topic, the four pseudonymous students and Nova, and a native `role="progressbar"` for the fixed 45-minute session. Before `room.opened`, it says “尚未開始” and has no fabricated percentage. After opening, `session-clock.ts` estimates current server time from the last generated welcome/heartbeat `serverTime` plus monotonic elapsed time, clamps progress to 0–100%, and derives remaining time only from immutable `startsAt`, `closesAt` and `durationSeconds`; room pause never freezes or extends the countdown. A missed heartbeat changes connection copy to degraded/unknown but never rewrites the deadline. `ParticipantActivity` displays only unexpired pseudonymous active/typing signals, avoids a claimed online/offline count, does not put per-keystroke changes in an assertive live region, and clears on expiry/disconnect. Generated `degraded` frames map to bounded product copy such as “分析更新較慢；聊天仍可使用” rather than “live” success.

- [ ] **Step 4: Run join, shell and route tests**

Run: `pnpm --filter @learning-orbit/web test -- src/auth/JoinSessionForm.test.tsx src/shell/AppShell.test.tsx src/shell/SessionHeader.test.tsx src/session/session-clock.test.ts`

Expected: tests pass; keyboard submit works; invalid room/seat responses render an inline recovery instruction, focus it, and never prompt the student to choose a pseudonym or role; countdown uses server time and never extends on pause; ephemeral activity expires without false online/offline claims.

- [ ] **Step 5: Commit auth and shell**

```bash
git add apps/web/app apps/web/src/auth apps/web/src/shell apps/web/src/session/session-clock.ts apps/web/src/session/session-clock.test.ts apps/web/src/session/session-gateway.ts apps/web/src/session/fetch-session-gateway.ts
git commit -m "feat(web): add authorized classroom join and shell"
```

### Task 8: Store graph/list, SNA scope, and SNA time-window preferences in the URL

**Files:**
- Create: `learning-orbit/apps/web/src/preferences/view-preferences.ts`
- Create: `learning-orbit/apps/web/src/preferences/view-preferences.test.ts`
- Create: `learning-orbit/apps/web/src/preferences/use-view-preferences.ts`

- [ ] **Step 1: Write failing URL/default-precedence tests**

```ts
it("uses explicit URL preferences before responsive defaults", () => {
  expect(readViewPreferences(new URLSearchParams("concept=graph&sna=list&snaScope=human_only&snaWindow=session_45m"), true)).toEqual({ concept: "graph", sna: "list", snaScope: "human_only", snaWindow: "session_45m" });
  expect(readViewPreferences(new URLSearchParams(), true)).toEqual({ concept: "list", sna: "list", snaScope: "observed", snaWindow: "recent_10m" });
});
```

- [ ] **Step 2: Run and verify the parser is missing**

Run: `pnpm --filter @learning-orbit/web test -- src/preferences/view-preferences.test.ts`

Expected: FAIL because `readViewPreferences` is undefined.

- [ ] **Step 3: Implement validated query parsing and replacement**

```ts
export type ViewPreferences = { concept: "graph" | "list"; sna: "graph" | "list"; snaScope: "observed" | "human_only" | "lineage_adjusted"; snaWindow: "recent_10m" | "session_45m" };

export function readViewPreferences(params: URLSearchParams, mobile: boolean): ViewPreferences {
  const concept = params.get("concept");
  const sna = params.get("sna");
  const scope = params.get("snaScope");
  const window = params.get("snaWindow");
  return {
    concept: concept === "graph" || concept === "list" ? concept : mobile ? "list" : "graph",
    sna: sna === "graph" || sna === "list" ? sna : mobile ? "list" : "graph",
    snaScope: scope === "human_only" || scope === "lineage_adjusted" ? scope : "observed",
    snaWindow: window === "session_45m" ? "session_45m" : "recent_10m",
  };
}

export function writeViewPreferences(url: URL, value: ViewPreferences) {
  url.searchParams.set("concept", value.concept);
  url.searchParams.set("sna", value.sna);
  url.searchParams.set("snaScope", value.snaScope);
  url.searchParams.set("snaWindow", value.snaWindow);
  history.replaceState(history.state, "", url);
}
```

The hook must subscribe to `popstate` and `matchMedia("(max-width: 767px)")`. Once a URL value exists, viewport changes must not override it.

- [ ] **Step 4: Run preference tests**

Run: `pnpm --filter @learning-orbit/web test -- src/preferences/view-preferences.test.ts`

Expected: parsing, invalid-value fallback, popstate and mobile-default tests pass.

- [ ] **Step 5: Commit URL preferences**

```bash
git add apps/web/src/preferences
git commit -m "feat(web): persist analysis views in URL"
```

### Task 9: Implement chat, reply, mention, revise and retract UI

**Files:**
- Create: `learning-orbit/apps/web/src/chat/ChatPanel.tsx`
- Create: `learning-orbit/apps/web/src/chat/MessageList.tsx`
- Create: `learning-orbit/apps/web/src/chat/MessageCard.tsx`
- Create: `learning-orbit/apps/web/src/chat/Composer.tsx`
- Create: `learning-orbit/apps/web/src/chat/Composer.test.tsx`
- Create: `learning-orbit/apps/web/src/chat/ReplyBanner.tsx`
- Create: `learning-orbit/apps/web/src/chat/MentionPicker.tsx`
- Create: `learning-orbit/apps/web/src/chat/InquiryPromptChips.tsx`
- Create: `learning-orbit/apps/web/src/chat/InquiryPromptChips.test.tsx`
- Create: `learning-orbit/apps/web/src/chat/ChatPanel.module.css`

`roomRoster(room: RoomDetails)` is a local view selector that returns the four generated `room.participants` plus one Nova entry mapped from generated `room.nova`; it never serializes, invents `members`, or changes actor IDs.

- [ ] **Step 1: Write failing compose, reply, mention and edit tests**

```tsx
import { ACTOR_B, EVENT_008, MESSAGE_001, MESSAGE_008, displayEventLabel } from "../testing/contract-fixtures";

it("[LO-HTML-04] supports compose reply media and explicit unsupported states", async () => {
  render(<Composer participants={roomRoster(roomBootstrap)} roomState="open" replyTo={MESSAGE_001} draftMediaIds={[]} onSend={onSend} onClearReply={onClearReply} />);
  await user.click(screen.getByRole("button", { name: "提及 探索者 B" }));
  await user.type(screen.getByLabelText("輸入訊息"), "需要更多直接證據");
  await user.click(screen.getByRole("button", { name: "發送訊息" }));
  expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ type: "message.add", text: "@探索者 B 需要更多直接證據", mediaIds: [], replyTo: MESSAGE_001, mentions: [ACTOR_B] }));
});

it("mentions the server-owned Nova actor without creating or hardcoding an actor ID", async () => {
  const nova = roomRoster(roomBootstrap).find((member) => member.actorId === authSession.nova.actorId)!;
  render(<Composer participants={roomRoster(roomBootstrap)} roomState="open" replyTo={null} draftMediaIds={[]} onSend={onSend} onClearReply={onClearReply} />);
  await user.click(screen.getByRole("button", { name: `提及 ${nova.pseudonym}` }));
  await user.type(screen.getByLabelText("輸入訊息"), "請整理目前證據");
  await user.click(screen.getByRole("button", { name: "發送訊息" }));
  expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ type: "message.add", mentions: [authSession.nova.actorId] }));
  expect(nova).toEqual(expect.objectContaining({ actorKind: "agent", actorRole: expect.any(String) }));
});

it.each([["paused", "課堂已暫停；訊息暫時不能發送"], ["closed", "課堂已關閉；你仍可閱讀已授權內容"]] as const)("shows an honest %s composer state", (roomState, copy) => {
  render(<Composer participants={roomRoster(roomBootstrap)} roomState={roomState} replyTo={null} draftMediaIds={[]} onSend={onSend} onClearReply={onClearReply} />);
  expect(screen.getByRole("status")).toHaveTextContent(copy);
  expect(screen.getByRole("button", { name: "發送訊息" })).toBeDisabled();
});

it("sends revise and retract commands without mutating the ledger optimistically", async () => {
  render(<MessageCard event={ownMessage} canModerate={false} onCommand={onCommand} />);
  await user.click(screen.getByRole("button", { name: `修訂${displayEventLabel(EVENT_008)}` }));
  await user.clear(screen.getByLabelText("修訂內容"));
  await user.type(screen.getByLabelText("修訂內容"), "修正後的觀察");
  await user.click(screen.getByRole("button", { name: "送出修訂" }));
  expect(onCommand).toHaveBeenCalledWith({ type: "message.revise", messageId: MESSAGE_008, text: "修正後的觀察", replyTo: ownMessage.replyTo, mentions: ownMessage.mentions, baseRevision: ownMessage.revision });
  expect(onCommand.mock.calls[0][0]).not.toHaveProperty("mediaIds");
});

it("lets a teacher retract but never revise a student's original message", () => {
  render(<MessageCard event={studentMessage} viewerRole="teacher" viewerActorId={teacherRoomContext.authSession.actorId} onCommand={onCommand} />);
  expect(screen.getByRole("button", { name: `撤回${displayEventLabel(EVENT_008)}` })).toBeVisible();
  expect(screen.queryByRole("button", { name: `修訂${displayEventLabel(EVENT_008)}` })).not.toBeInTheDocument();
});

it("does not render the student composer in the teacher supervision view", () => {
  render(<ChatPanel role="teacher" ledger={ledger} roster={roomRoster(roomBootstrap)} commandBus={commandBus} />);
  expect(screen.queryByLabelText("輸入訊息")).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "共學對話" })).toBeVisible();
});

it("inserts an inquiry prompt without sending or claiming an analytics update", async () => {
  render(<Composer participants={roomRoster(roomBootstrap)} roomState="open" replyTo={null} draftMediaIds={[]} onSend={onSend} onClearReply={onClearReply} onTypingChange={onTypingChange} />);
  await user.click(screen.getByRole("button", { name: "使用提示：追問物質循環" }));
  expect(screen.getByLabelText("輸入訊息")).toHaveValue("我想追問：分解者怎樣讓物質回到環境？");
  expect(onSend).not.toHaveBeenCalled();
  expect(screen.getByText("提示只協助組織問題；概念圖是否更新由伺服器分析與證據規則決定。")).toBeVisible();
});
```

- [ ] **Step 2: Run and observe missing chat modules**

Run: `pnpm --filter @learning-orbit/web test -- src/chat/Composer.test.tsx`

Expected: FAIL because chat components do not exist.

- [ ] **Step 3: Implement command-only composer and message actions**

```tsx
export function Composer({ participants, roomState, replyTo, draftMediaIds, onSend, onClearReply, onTypingChange }: ComposerProps) {
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const submit = () => {
    const value = text.trim();
    if ((!value && draftMediaIds.length === 0) || draftMediaIds.length > 4 || roomState !== "open") return;
    onSend({ type: "message.add", text: value, mediaIds: draftMediaIds, replyTo: replyTo || null, mentions });
    setText("");
    setMentions([]);
    onTypingChange(false);
    onClearReply();
  };
  return <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <InquiryPromptChips onInsert={(prompt) => { setText((current) => `${current}${current ? " " : ""}${prompt}`); onTypingChange(true); }} />
    <p role="note">提示只協助組織問題；概念圖是否更新由伺服器分析與證據規則決定。</p>
    <MentionPicker participants={participants} onMention={(participant) => { setText((current) => `${current}@${participant.pseudonym} `); setMentions((current) => [...new Set([...current, participant.actorId])]); onTypingChange(true); }} />
    {replyTo ? <ReplyBanner eventId={replyTo} onCancel={onClearReply} /> : null}
    <label htmlFor="message-composer">輸入訊息</label>
    <textarea id="message-composer" name="message" value={text} onChange={(event) => { setText(event.target.value); onTypingChange(event.target.value.length > 0); }} onBlur={() => onTypingChange(false)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); onTypingChange(false); } }} />
    <button type="submit" disabled={roomState !== "open"}>發送訊息</button>
    {roomState === "paused" ? <span role="status">課堂已暫停；訊息暫時不能發送</span> : null}
    {roomState === "closed" ? <span role="status">課堂已關閉；你仍可閱讀已授權內容</span> : null}
  </form>;
}
```

Only generated, server-confirmed `RoomEventEnvelope` values enter the ledger. `ChatMessageView` is a local selector output and must never be serialized as a wire event. The four preset inquiry chips are fixed local Traditional Chinese drafting aids (observe evidence, question material cycling, connect a peer view, surface a challenge); they only insert editable text and never call analytics, send a message or promise a graph change. Participant and Nova mention choices come only from generated `RoomDetails.participants` plus `RoomDetails.nova`; cross-check the student session's `nova.actorId`, never create `nova_actor_id` or `members` wire fields locally. A generated `message.add` carries `mediaIds: UUID[]` with at most four entries and is valid when text or at least one media ID is present. A revise command changes text only: it never sends attachment fields, and the server-confirmed revised event copies the prior `mediaIds`. Show pending command status separately. A student author may revise or retract only their own message. A teacher supervising the fixed four-student-plus-Nova room may read and retract any room message but may not revise a student's original words, and the teacher view renders no ordinary chat composer. Require confirmation before retract and expose an undo only when the server contract supplies a reversible window. `onTypingChange` feeds the rate-limited ephemeral sender only; it never becomes message content or permanent analytics evidence.

- [ ] **Step 4: Run chat tests**

Run: `pnpm --filter @learning-orbit/web test -- src/chat`

Expected: compose, Enter/Shift+Enter, reply navigation, mention insertion, ownership, revision, retraction and focus-restoration tests pass.

- [ ] **Step 5: Commit chat UI**

```bash
git add apps/web/src/chat
git commit -m "feat(web): add event-backed classroom chat"
```

### Task 10: Implement accessible image and owned audio media flows

**Files:**
- Create: `learning-orbit/apps/web/src/media/media-command.ts`
- Create: `learning-orbit/apps/web/src/media/media-command.test.ts`
- Modify: `learning-orbit/apps/web/src/media/image-state.ts`
- Modify: `learning-orbit/apps/web/src/media/image-state.test.ts`
- Modify: `learning-orbit/apps/web/src/media/ImageAttachment.tsx`
- Modify: `learning-orbit/apps/web/src/media/ImageAttachment.test.tsx`
- Modify: `learning-orbit/apps/web/src/media/audio-state.ts`
- Modify: `learning-orbit/apps/web/src/media/audio-state.test.ts`
- Modify: `learning-orbit/apps/web/src/media/useAudioRecorder.ts`
- Modify: `learning-orbit/apps/web/src/media/AudioAttachment.tsx`
- Modify: `learning-orbit/apps/web/src/media/AudioAttachment.test.tsx`
- Modify: `learning-orbit/apps/web/src/media/MediaAttachmentView.tsx`
- Create: `learning-orbit/apps/web/src/media/Media.module.css`

- [ ] **Step 1: Write failing media-in-reply and recorder-race tests**

```ts
import { MEDIA_AUDIO_ID, MEDIA_IMAGE_2, MEDIA_IMAGE_3, MEDIA_IMAGE_4, MEDIA_IMAGE_ID, MESSAGE_001, ROOM_ID } from "../testing/contract-fixtures";

it("includes uploaded image and audio IDs in generated message.add while preserving reply", () => {
  expect(buildMessageAddWithMedia({ text: "池塘觀察", mediaIds: [MEDIA_IMAGE_ID], replyTo: MESSAGE_001, mentions: [] })).toEqual({ type: "message.add", text: "池塘觀察", mediaIds: [MEDIA_IMAGE_ID], replyTo: MESSAGE_001, mentions: [] });
  expect(buildMessageAddWithMedia({ text: "", mediaIds: [MEDIA_AUDIO_ID], replyTo: MESSAGE_001, mentions: [] })).toEqual({ type: "message.add", text: "", mediaIds: [MEDIA_AUDIO_ID], replyTo: MESSAGE_001, mentions: [] });
  expect(() => buildMessageAddWithMedia({ text: "", mediaIds: [], replyTo: null, mentions: [] })).toThrow("message_text_or_media_required");
  expect(() => buildMessageAddWithMedia({ text: "too many", mediaIds: [MEDIA_IMAGE_ID, MEDIA_AUDIO_ID, MEDIA_IMAGE_2, MEDIA_IMAGE_3, MEDIA_IMAGE_4], replyTo: null, mentions: [] })).toThrow("message_media_limit_exceeded");
});

it("hydrates generated MediaAttachmentView values on refresh", async () => {
  gateway.getMedia.mockResolvedValueOnce(imageAttachmentView).mockResolvedValueOnce(audioAttachmentView);
  expect(await hydrateMediaAttachments(gateway, ROOM_ID, [MEDIA_IMAGE_ID, MEDIA_AUDIO_ID])).toEqual([imageAttachmentView, audioAttachmentView]);
  expect(gateway.getMedia).toHaveBeenNthCalledWith(1, ROOM_ID, MEDIA_IMAGE_ID);
  expect(gateway.getMedia).toHaveBeenNthCalledWith(2, ROOM_ID, MEDIA_AUDIO_ID);
});

it("[LO-HTML-13] owns recorder sessions and rejects stale start-stop completions", async () => {
  const controller = createRecorderController(fakeMediaDevices);
  const first = controller.start();
  controller.reset();
  await first;
  expect(controller.snapshot().phase).toBe("idle");
  expect(fakeMediaDevices.lastStream.getTracks()[0].stop).toHaveBeenCalled();
});
```

```tsx
it("[LO-HTML-05] opens the image picker from a keyboard-operable button", async () => {
  render(<ImageAttachment replyTo={MESSAGE_001} gateway={gateway} />);
  const button = screen.getByRole("button", { name: "選擇本地圖片" });
  button.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByLabelText("本地圖片檔案")).toHaveAttribute("accept", "image/*");
});
```

- [ ] **Step 2: Run and verify missing media state**

Run: `pnpm --filter @learning-orbit/web test -- src/media`

Expected: FAIL because the shared command integration and final visual/accessibility behavior are absent; Plan 02 reducer/controller tests remain green.

- [ ] **Step 3: Add explicit upload and recorder state machines**

```ts
export function buildMessageAddWithMedia(input: MessageAddDraft): RoomCommand {
  const text = input.text.trim();
  if (!text && input.mediaIds.length === 0) throw new Error("message_text_or_media_required");
  if (input.mediaIds.length > 4) throw new Error("message_media_limit_exceeded");
  return { type: "message.add", text, mediaIds: [...new Set(input.mediaIds)], replyTo: input.replyTo, mentions: [...new Set(input.mentions)] };
}
```

```ts
// Reuse Plan 02's AudioRecorderController/createRecorderController and
// imageReducer/audioReducer. Do not introduce a second recorder or upload state.
```

Validate image MIME, decoded dimensions and the server-frozen size ceiling before upload. Require non-whitespace alt text in the generated media-upload metadata. Parse the full generated `MediaUploadGrant`, including expiry. After `routes.media.complete(roomId, mediaId)` returns generated uploaded/processing/ready state, place the UUID into the composer draft; send it only through generated `message.add.mediaIds` and keep `replyTo` until that command is acknowledged, then clear it exactly once. Never send a separate attachment chat command or a local attachment payload. A generated text-free `media_status` frame updates only an attachment already referenced by a confirmed message; no optimistic UI invents readiness, and the frame never enters the event ledger. On refresh or a missed frame, resolve every confirmed message media UUID with `routes.media.get(roomId, mediaId)` and render only generated `MediaAttachmentView`; do not define an attachment wire interface in `apps/web`. On explicit view/play activation, fetch and parse generated `MediaDownloadGrant`, fetch the signed URL immediately into a Blob, attach only the local Object URL to image/audio, and revoke it on replacement/unmount; the signed URL never enters DOM, state persistence or logs. A revised message receives server-copied prior `mediaIds` and cannot replace them. For audio, expose unsupported, denied, interrupted, stopped, upload-failed and retry states; never fabricate a transcript.

- [ ] **Step 4: Run media tests**

Run: `pnpm --filter @learning-orbit/web test -- src/media`

Expected: Plan 02 and Plan 05 tests run together; text-or-media validation, four-media limit, media-in-reply, generated refresh/download grants, immutable revise attachments, alt-text, upload/outcome retry, unsupported browser, permission denial, stale session, URL revocation and keyboard tests pass through one production component/controller path.

- [ ] **Step 5: Commit media UI**

```bash
git add apps/web/src/media
git commit -m "feat(web): add reply-safe classroom media"
```

### Task 11: Render explicit Agent lifecycle and provenance

**Files:**
- Create: `learning-orbit/apps/web/src/agent/AgentStatus.tsx`
- Create: `learning-orbit/apps/web/src/agent/AgentStatus.test.tsx`
- Create: `learning-orbit/apps/web/src/agent/agent-presentation.ts`
- Create: `learning-orbit/apps/web/src/agent/agent-status-reducer.ts`
- Create: `learning-orbit/apps/web/src/agent/agent-trigger-controller.ts`
- Create: `learning-orbit/apps/web/src/agent/agent-trigger-controller.test.ts`
- Create: `learning-orbit/apps/web/src/agent/AgentDisclosure.tsx`
- Create: `learning-orbit/apps/web/src/agent/AgentStatus.module.css`

- [ ] **Step 1: Write failing Agent state tests**

```tsx
import { AGENT_MESSAGE_ID, EVENT_007, EVENT_008, RUN_ID, displayEventLabel } from "../testing/contract-fixtures";

it.each([
  ["queued", "healthy", "thinking", "Nova Agent 正在整理證據"],
  ["running", "healthy", "thinking", "Nova Agent 正在整理證據"],
  ["streaming", "healthy", "streaming", "Nova Agent 正在回應"],
  ["completed", "healthy", "idle", "Nova Agent 已待命"],
  ["blocked_by_policy", "healthy", "held", "Nova Agent 回應因課堂政策暫緩；同學仍可繼續討論"],
  ["cancelled", "healthy", "idle", "Nova Agent 已待命"],
  ["failed", "healthy", "unavailable", "Nova Agent 目前不可用；訊息不會遺失"],
  ["running", "unavailable", "unavailable", "Nova Agent 目前不可用；訊息不會遺失"],
] as const)("maps generated run state %s and health %s to %s", (runState, serviceHealth, presentation, copy) => {
  expect(selectAgentPresentation(runState, serviceHealth)).toBe(presentation);
  render(<AgentStatus runState={runState} serviceHealth={serviceHealth} />);
  expect(screen.getByRole("status")).toHaveTextContent(copy);
});

it("discloses only generated safe Agent provenance from final message.added", () => {
  const event = roomEventEnvelope({ type: "message.added", revision: 1, actorKind: "agent", actorRole: "socratic_facilitator", payload: { messageId: AGENT_MESSAGE_ID, text: "整理後的最終回應", mediaIds: [], agentRunId: RUN_ID, sourceEventIds: [EVENT_007, EVENT_008], warningCodes: ["evidence_incomplete"] } });
  render(<AgentDisclosure event={event} />);
  expect(screen.getByText(`來源事件：${displayEventLabel(EVENT_007)}、${displayEventLabel(EVENT_008)}`)).toBeVisible();
  expect(screen.queryByText(RUN_ID)).not.toBeInTheDocument();
  expect(screen.queryByText(/provider|model|prompt|token|cost/i)).not.toBeInTheDocument();
});

it("requests Nova only after the mentioning student message is committed", async () => {
  triggerController.observe(committedStudentMessage({ eventId: EVENT_007, mentions: [NOVA_ACTOR_ID] }));
  triggerController.observe(committedStudentMessage({ eventId: EVENT_007, mentions: [NOVA_ACTOR_ID] }));
  expect(gateway.requestAgent).toHaveBeenCalledTimes(1);
  expect(gateway.requestAgent).toHaveBeenCalledWith(ROOM_ID, { triggerEventId: EVENT_007 });
});
```

- [ ] **Step 2: Run and verify missing Agent components**

Run: `pnpm --filter @learning-orbit/web test -- src/agent`

Expected: FAIL because `AgentStatus` is missing.

- [ ] **Step 3: Add server-driven Agent status and message disclosure**

```tsx
// apps/web/src/agent/agent-presentation.ts
import type { AgentCurrentState } from "../contracts/generated";

export type AgentPresentation = "idle" | "thinking" | "streaming" | "held" | "unavailable";
type SafeAgentRunState = NonNullable<AgentCurrentState["run"]>["state"];
type AgentServiceHealth = AgentCurrentState["serviceHealth"];

export function selectAgentPresentation(runState: SafeAgentRunState | "idle", serviceHealth: AgentServiceHealth): AgentPresentation {
  if (runState === "failed" || serviceHealth === "unavailable") return "unavailable";
  if (runState === "blocked_by_policy" || serviceHealth === "degraded") return "held";
  if (runState === "streaming") return "streaming";
  if (runState === "queued" || runState === "running") return "thinking";
  return "idle";
}
```

```tsx
// apps/web/src/agent/AgentStatus.tsx
import type { AgentCurrentState } from "../contracts/generated";
import { selectAgentPresentation, type AgentPresentation } from "./agent-presentation";

export function AgentStatus({ runState, serviceHealth }: { runState: NonNullable<AgentCurrentState["run"]>["state"] | "idle"; serviceHealth: AgentCurrentState["serviceHealth"] }) {
  const status = selectAgentPresentation(runState, serviceHealth);
  const copy: Record<AgentPresentation, string> = {
    idle: "Nova Agent 已待命",
    thinking: "Nova Agent 正在整理證據",
    streaming: "Nova Agent 正在回應",
    held: "Nova Agent 回應因課堂政策暫緩；同學仍可繼續討論",
    unavailable: "Nova Agent 目前不可用；訊息不會遺失",
  };
  return <span className={styles[status]} role="status" aria-live="polite">{copy[status]}</span>;
}
```

```tsx
// apps/web/src/agent/AgentDisclosure.tsx
export function AgentDisclosure({ event }: { event: RoomEventEnvelope }) {
  const core = parseCoreRoomEvent(event);
  if (!core || core.type !== "message.added" || core.actorKind !== "agent" || core.actorRole !== "socratic_facilitator") return null;
  const sourceLabels = (core.payload.sourceEventIds ?? []).map(displayEventLabel);
  return <aside aria-label="Nova 回應來源">
    <p>此訊息由 Nova Agent 提供。</p>
    {sourceLabels.length ? <p>來源事件：{sourceLabels.join("、")}</p> : <p>未提供可顯示的來源事件。</p>}
    {(core.payload.warningCodes ?? []).map((code) => <p key={code}>警示：{selectWarningCopy(code)}</p>)}
  </aside>;
}
```

`agent-status-reducer.ts` accepts generated `agent_status` frames and the generated student-safe response from `routes.agent.current(roomId)`; it changes only Agent presentation state. `agent-trigger-controller.ts` observes only committed, parsed core student `message.added` events, verifies the current actor and generated `session.nova.actorId` mention, then sends generated `{triggerEventId}` once; duplicate replay is locally deduped and the server remains idempotent. It never triggers from optimistic text, Agent output or a bare mention string. `AgentDisclosure` first calls shared `parseCoreRoomEvent`, then accepts only its generated final `message.added` branch and reads top-level `actorKind`/`actorRole` plus optional payload `agentRunId`, `sourceEventIds`, `warningCodes`. It never casts a generic payload or defines a local Agent-message wire interface. It must not show or infer provider, model, prompt, token, cost or hidden policy details. `idle`, `thinking`, `held` and `unavailable` are local presentation values, never generated wire states. Mentioning Nova does not guarantee a response; only generated current/status state plus service health changes presentation.

- [ ] **Step 4: Run Agent tests**

Run: `pnpm --filter @learning-orbit/web test -- src/agent`

Expected: all seven generated wire states, service-health precedence, provenance, retry and no-fabricated-response tests pass; `completed` and `cancelled` map to idle, `queued` and `running` map to thinking, policy block maps to held, and failed maps to unavailable.

- [ ] **Step 5: Commit Agent status UI**

```bash
git add apps/web/src/agent
git commit -m "feat(web): disclose Agent lifecycle and provenance"
```

### Task 12: Implement the complete generated ConceptMapPatch reducer and replay cursor

**Files:**
- Create: `learning-orbit/apps/web/src/concept/concept-reducer.ts`
- Create: `learning-orbit/apps/web/src/concept/concept-reducer.test.ts`
- Create: `learning-orbit/apps/web/src/concept/concept-selectors.ts`
- Create: `learning-orbit/apps/web/src/concept/ConceptTimeline.tsx`
- Modify: `learning-orbit/apps/web/src/session/session-gateway.ts`
- Modify: `learning-orbit/apps/web/src/session/fetch-session-gateway.ts`

- [ ] **Step 1: Write failing full-patch and graph/list parity tests**

```ts
import { CONCEPT_EDGE_ID, EVENT_001, EVENT_007 } from "../testing/contract-fixtures";

it("[LO-HTML-11] replays exact multi-source concept provenance", () => {
  const state = replayConceptPatches(emptyConceptState(), [p001, p007]);
  const edge = state.edges.get(CONCEPT_EDGE_ID)!;
  expect(edge.evidenceRefs.map(({ eventId }) => eventId)).toEqual([EVENT_001, EVENT_007]);
  expect(edge.activityScore).toBe(p007.edgesUpdated[0].activityScore);
  expect(edge.evidenceStatus).toBe(p007.edgesUpdated[0].evidenceStatus);
  expect(edge.reviewStatus).toBe(p007.edgesUpdated[0].reviewStatus);
  expect(edge.displayStatus).toBe(p007.edgesUpdated[0].displayStatus);
  expect(edge.channels).toEqual(p007.edgesUpdated[0].channels);
});

it("uses one visible edge selector for graph and list at every timeline cursor", () => {
  const state = replayConceptPatches(emptyConceptState(), sevenPatches);
  expect(selectConceptRows(state, 2).map((row) => row.edgeId)).toEqual(selectConceptGraphEdges(state, 2).map((edge) => edge.edgeId));
});

it("does not apply a future hide to an earlier timeline cursor", () => {
  const state = hydrateConceptTimeline(windowWithEdgeHiddenAtPatch7);
  expect(selectVisibleConceptEdges(state, 6).map((edge) => edge.edgeId)).toContain(CONCEPT_EDGE_ID);
  expect(selectVisibleConceptEdges(state, 7).map((edge) => edge.edgeId)).not.toContain(CONCEPT_EDGE_ID);
});

it("uses the generated timeline route and renders loading truncated and failed states honestly", async () => {
  gateway.getConceptTimeline.mockResolvedValue({ ...timelineWindow, truncatedBeforeVersion: 4 });
  render(<ConceptTimeline roomId={ROOM_ID} analysisEpoch={EPOCH_A} gateway={gateway} />);
  expect(screen.getByRole("status")).toHaveTextContent("正在載入概念圖歷程");
  await screen.findByText("顯示最近 200 次更新");
  expect(gateway.getConceptTimeline).toHaveBeenCalledWith(ROOM_ID, "echo.student_approved", { analysisEpoch: EPOCH_A, limit: 200 });
  gateway.getConceptTimeline.mockRejectedValueOnce(new Error("network"));
  await user.click(screen.getByRole("button", { name: "重新載入歷程" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("概念圖歷程目前無法載入；即時概念圖仍可使用");
});
```

- [ ] **Step 2: Run and verify missing reducer failures**

Run: `pnpm --filter @learning-orbit/web test -- src/concept/concept-reducer.test.ts`

Expected: FAIL because reducer and selectors are absent.

- [ ] **Step 3: Implement every generated patch collection**

```ts
import type { ConceptMapPatch } from "../contracts/generated";

export function reduceConceptPatch(state: ConceptState, patch: ConceptMapPatch): ConceptState {
  if (patch.baseVersion !== state.projectionVersion) return { ...state, status: "stale", expectedBaseVersion: state.projectionVersion };
  if (patch.projectionVersion <= state.projectionVersion) return state;
  if (patch.projectionVersion !== state.projectionVersion + 1) return { ...state, status: "stale", expectedProjectionVersion: state.projectionVersion + 1 };
  const nodes = new Map(state.nodes);
  const edges = new Map(state.edges);
  patch.nodesAdded.forEach((node) => nodes.set(node.nodeId, node));
  patch.nodesUpdated.forEach((node) => nodes.set(node.nodeId, { ...nodes.get(node.nodeId), ...node }));
  patch.nodesHidden.forEach((nodeId) => nodes.set(nodeId, { ...nodes.get(nodeId)!, hidden: true }));
  patch.edgesAdded.forEach((edge) => edges.set(edge.edgeId, { ...edge, evidenceRefs: edge.evidenceRefs.map((ref) => ({ ...ref })), channels: { ...edge.channels } }));
  patch.edgesUpdated.forEach((edge) => edges.set(edge.edgeId, { ...edges.get(edge.edgeId), ...edge, evidenceRefs: edge.evidenceRefs.map((ref) => ({ ...ref })), channels: { ...edge.channels } }));
  patch.edgesHidden.forEach((edgeId) => edges.set(edgeId, { ...edges.get(edgeId)!, hidden: true }));
  const positions = new Map(state.positions);
  patch.positionUpdates.forEach((position) => positions.set(position.nodeId, position));
  return { ...state, baseVersion: patch.baseVersion, projectionVersion: patch.projectionVersion, completeThroughRoomSeq: patch.completeThroughRoomSeq, nodes, edges, positions, status: "ready", history: [...state.history, patch] };
}

export const selectConceptAtCursor = (state: ConceptState, cursor: number) =>
  replayConceptPatches(state.timelineBase, state.history.slice(0, cursor));
export const selectVisibleConceptEdges = (state: ConceptState, cursor: number) =>
  [...selectConceptAtCursor(state, cursor).edges.values()].filter((edge) => !edge.hidden);
```

The timeline uses the immutable, ordered generated `ConceptTimelineWindow` from the generated `routes.analytics.timeline(roomId, echoProjectionKey, {analysisEpoch,limit:200})` builder through `SessionGateway.getConceptTimeline`: a validated base snapshot plus a contiguous patch suffix ending at the current head. The gateway parser rejects a projection key/room/epoch mismatch and never accepts an untyped generic response. On every cursor selection, rebuild nodes, edges, hidden flags and positions from that base and only the prefix, so a future hide never changes an earlier frame. The endpoint returns at most 200 patches; if older history exists, `truncatedBeforeVersion` is non-null and UI says “顯示最近 200 次更新” rather than pretending to replay the whole epoch. Loading reserves the panel, failure keeps the current live graph and exposes retry, pause cancels its timer, and reset returns to the window base without mutating the live projection. Room-event resume and analytics latest/patch reconciliation remain independent transport operations; under reduced motion playback advances only on explicit “下一事件”.

- [ ] **Step 4: Run reducer and timer tests**

Run: `pnpm --filter @learning-orbit/web test -- src/concept/concept-reducer.test.ts`

Expected: add/update/hide/position, base/projection-version checks, numeric room-sequence cursor, object evidence refs, activity/evidence/review/display/channel preservation, replay provenance, pause and graph/list parity tests pass.

- [ ] **Step 5: Commit concept state**

```bash
git add apps/web/src/concept/concept-reducer.ts apps/web/src/concept/concept-reducer.test.ts apps/web/src/concept/concept-selectors.ts apps/web/src/concept/ConceptTimeline.tsx apps/web/src/session/session-gateway.ts apps/web/src/session/fetch-session-gateway.ts
git commit -m "feat(web): add complete concept patch projection"
```

### Task 13: Render concept graph, list and inspector from one projection

**Files:**
- Create: `learning-orbit/apps/web/src/concept/ConceptPanel.tsx`
- Create: `learning-orbit/apps/web/src/concept/ConceptPanel.test.tsx`
- Create: `learning-orbit/apps/web/src/concept/ConceptGraph.tsx`
- Create: `learning-orbit/apps/web/src/concept/ConceptList.tsx`
- Create: `learning-orbit/apps/web/src/concept/ConceptInspector.tsx`
- Create: `learning-orbit/apps/web/src/concept/ConceptPanel.module.css`

- [ ] **Step 1: Write failing semantic and keyboard tests**

```tsx
import { EVENT_001, EVENT_007, displayEventLabel } from "../testing/contract-fixtures";

it("[LO-HTML-06] exposes focus question relationship states evidence and timeline controls", async () => {
  render(<ConceptPanel state={conceptState} preferences={graphPreferences} />);
  expect(screen.getByText("能量如何在生態系統中流動，而物質又如何循環？")).toBeVisible();
  const edge = screen.getByRole("button", { name: "太陽提供能量給生產者，已確認" });
  edge.focus();
  await user.keyboard("{Enter}");
  const details = screen.getByRole("status", { name: "概念關係詳情" });
  expect(details).toHaveTextContent(`${displayEventLabel(EVENT_001)}、${displayEventLabel(EVENT_007)}`);
  for (const label of ["活動分數", "證據狀態", "審核狀態", "顯示狀態", "分析通道"]) expect(details).toHaveTextContent(label);
});

it("makes nodes and edges mouse/keyboard equivalent with non-color status encoding", async () => {
  render(<ConceptPanel state={disputedConceptState} preferences={graphPreferences} />);
  const node = screen.getByRole("button", { name: "概念：生產者，已確認" });
  expect(node).toHaveAttribute("data-hit-target", "true");
  expect(node).toHaveStyle({ minWidth: "44px", minHeight: "44px" });
  node.focus();
  await user.keyboard(" ");
  expect(screen.getByRole("status", { name: "概念節點詳情" })).toHaveTextContent("相關來源事件");
  const disputed = screen.getByTestId("concept-edge-disputed");
  expect(disputed.querySelectorAll("path[data-status-track]")).toHaveLength(2);
  expect(disputed.querySelector("path[marker-end]")).toBeTruthy();
  expect(disputed).toHaveTextContent("±");
  expect(screen.getByRole("button", { name: /支持與質疑並存/ })).toHaveStyle({ minWidth: "44px", minHeight: "44px" });
  await user.click(node);
  expect(node).toHaveAttribute("aria-pressed", "true");
});
```

- [ ] **Step 2: Run and verify missing concept views**

Run: `pnpm --filter @learning-orbit/web test -- src/concept/ConceptPanel.test.tsx`

Expected: FAIL because `ConceptPanel` is absent.

- [ ] **Step 3: Add authored SVG and equivalent list controls**

```tsx
export function ConceptGraph({ edges, nodes, selectedTarget, onSelectEdge, onSelectNode }: ConceptGraphProps) {
  const statusMark = { confirmed: "✓", provisional: "?", disputed: "±", inactive: "暫" } as const;
  const at = (x: number, y: number) => ({ left: `${(x / 700) * 100}%`, top: `${(y / 340) * 100}%`, minWidth: "44px", minHeight: "44px", transform: "translate(-50%, -50%)" });
  return <section role="group" aria-labelledby="concept-title" aria-describedby="concept-desc">
    <h3 id="concept-title" className={styles.srOnly}>生態系統能量流與物質循環概念圖</h3>
    <p id="concept-desc" className={styles.srOnly}>Tab 會移到疊在圖上的原生按鈕；方向、狀態與爭議也可由命題列表讀取。</p>
    <div className={styles.graphCanvas}>
      <svg viewBox="0 0 700 340" aria-hidden="true" focusable="false" className={styles.visualSvg}>
        <defs>{edges.map((edge) => <marker key={edge.edgeId} id={`concept-arrow-${edge.edgeId}`} orient="auto"><path d="M0,0 L8,4 L0,8 Z" /></marker>)}</defs>
        {edges.map((edge) => <g key={edge.edgeId} data-testid={`concept-edge-${edge.displayStatus}`} data-evidence-status={edge.evidenceStatus} data-review-status={edge.reviewStatus}>
          {edge.statusTracks.map((track, index) => <path key={index} d={track.path} data-status-track="true" className={styles[edge.displayStatus]} strokeDasharray={edge.displayStatus === "provisional" ? "7 5" : undefined} markerEnd={index === edge.statusTracks.length - 1 ? `url(#concept-arrow-${edge.edgeId})` : undefined} />)}
          <text>{edge.predicate}</text><g transform={`translate(${edge.badge.x} ${edge.badge.y})`}><circle r="10" /><text>{statusMark[edge.displayStatus]}</text></g>
        </g>)}
        {nodes.map((node) => <g key={node.nodeId} transform={`translate(${node.x} ${node.y})`}><rect width="74" height="52" x="-37" y="-26" rx="14" /><text>{node.label}</text></g>)}
      </svg>
      <div className={styles.graphControls}>
        {edges.map((edge) => <button key={edge.edgeId} type="button" className={styles.overlayHitTarget} style={at(edge.badge.x, edge.badge.y)} data-hit-target="true" aria-label={edge.accessibleName} aria-pressed={selectedTarget?.kind === "edge" && selectedTarget.id === edge.edgeId} onClick={() => onSelectEdge(edge.edgeId)}><span className={styles.srOnly}>{edge.predicate}，{statusMark[edge.displayStatus]}</span></button>)}
        {nodes.map((node) => <button key={node.nodeId} type="button" className={styles.overlayHitTarget} style={at(node.x, node.y)} data-hit-target="true" aria-label={node.accessibleName} aria-pressed={selectedTarget?.kind === "node" && selectedTarget.id === node.nodeId} onClick={() => onSelectNode(node.nodeId)}><span className={styles.srOnly}>{node.label}</span></button>)}
      </div>
    </div>
  </section>;
}
```

The authored SVG is visual-only (`aria-hidden="true"`); it is never an accessibility container with nested interactive descendants. `graphCanvas` has the same `700 / 340` aspect ratio and relative positioning, while `graphControls` overlays native HTML buttons at the same normalized anchors. Each button is at least 44×44 CSS pixels, has visible focus, carries the selected state and works natively with pointer, Enter and Space. The separate proposition list is an equivalent semantic view backed by the same selectors, not a repair for an inaccessible SVG.

Use generated `displayStatus` for CSS line styles; do not infer it from `activityScore`, `evidenceStatus` or `reviewStatus`. Confirmed is solid plus ✓, provisional is dashed plus ?, disputed is two offset tracks plus ±, and inactive is faded plus 暫; every last track has a directional marker, and graph/list tests assert the same state label. Color is supplementary only. Graph, list and inspector receive the same generated edge/node selector outputs. The list and edge inspector render `activityScore`, `evidenceStatus`, `reviewStatus`, `displayStatus`, `channels`, and human-readable labels selected from `evidenceRefs.map(({ eventId }) => eventId)`; keep UUIDs as internal provenance keys and do not introduce an aggregate scalar. The node inspector shows generated node statuses and derives its “相關來源事件” only from the union of currently visible incident-edge evidence refs at that same timeline cursor—never by inventing node evidence.

- [ ] **Step 4: Run concept component tests**

Run: `pnpm --filter @learning-orbit/web test -- src/concept/ConceptPanel.test.tsx`

Expected: graph/list parity, arrow/line/badge/track state encoding, separate 44px node and edge hit targets, unique names, mouse plus Enter/Space parity, node/edge inspector provenance, timeline controls and keyboard tests pass.

- [ ] **Step 5: Commit concept views**

```bash
git add apps/web/src/concept/ConceptPanel.tsx apps/web/src/concept/ConceptPanel.test.tsx apps/web/src/concept/ConceptGraph.tsx apps/web/src/concept/ConceptList.tsx apps/web/src/concept/ConceptInspector.tsx apps/web/src/concept/ConceptPanel.module.css
git commit -m "feat(web): render accessible concept views"
```

### Task 14: Implement the TRACE SNA projection bundle with immutable server metrics

**Files:**
- Create: `learning-orbit/apps/web/src/sna/sna-reducer.ts`
- Create: `learning-orbit/apps/web/src/sna/sna-reducer.test.ts`
- Create: `learning-orbit/apps/web/src/sna/sna-selectors.ts`
- Create: `learning-orbit/apps/web/src/sna/SnaMetrics.tsx`

- [ ] **Step 1: Write failing bundle-shape and view-switch metric consistency tests**

```ts
it("keeps both generated time windows and all three views stable across switching", () => {
  expect(Object.keys(traceProjectionBundle.payload.windows).sort()).toEqual(["recent_10m", "session_45m"]);
  for (const window of Object.values(traceProjectionBundle.payload.windows)) {
    expect(Object.keys(window.views).sort()).toEqual(["human_only", "lineage_adjusted", "observed"]);
    for (const view of Object.values(window.views)) {
      expect(view).not.toHaveProperty("projectionVersion");
      expect(view).not.toHaveProperty("baseVersion");
      expect(view).not.toHaveProperty("completeThroughRoomSeq");
    }
  }
  const state = reduceSnaProjectionBundle(emptySnaState(), traceProjectionBundle);
  expect(state.baseVersion).toBe(traceProjectionBundle.baseVersion);
  expect(state.projectionVersion).toBe(traceProjectionBundle.projectionVersion);
  expect(state.completeThroughRoomSeq).toBe(traceProjectionBundle.completeThroughRoomSeq);
  const observedBefore = selectSnaView(state, "recent_10m", "observed").metrics;
  selectSnaView(state, "recent_10m", "human_only");
  selectSnaView(state, "session_45m", "lineage_adjusted");
  expect(selectSnaView(state, "recent_10m", "observed").metrics).toEqual(observedBefore);
  expect(observedBefore).toEqual(traceProjectionBundle.payload.windows.recent_10m.views.observed.metrics);
  expect(selectSnaWindow(state, "session_45m").windowStartEventTime).toBe(traceProjectionBundle.payload.windows.session_45m.windowStartEventTime);
});
```

- [ ] **Step 2: Run and verify missing SNA reducer**

Run: `pnpm --filter @learning-orbit/web test -- src/sna/sna-reducer.test.ts`

Expected: FAIL because the generated `SnaProjectionBundle` reducer and selector do not exist.

- [ ] **Step 3: Store all generated payload views under the bundle cursor**

```ts
import type { SnaProjectionBundle } from "../contracts/generated";

const SNA_VIEW_NAMES = ["observed", "human_only", "lineage_adjusted"] as const;
const SNA_WINDOW_NAMES = ["recent_10m", "session_45m"] as const;
type SnaWindowName = typeof SNA_WINDOW_NAMES[number];

export function reduceSnaProjectionBundle(state: SnaState, bundle: SnaProjectionBundle): SnaState {
  if (bundle.baseVersion !== state.projectionVersion) return { ...state, status: "stale", expectedBaseVersion: state.projectionVersion };
  if (bundle.projectionVersion <= state.projectionVersion) return state;
  if (bundle.projectionVersion !== state.projectionVersion + 1) return { ...state, status: "stale", expectedProjectionVersion: state.projectionVersion + 1 };
  const windows = new Map(SNA_WINDOW_NAMES.map((windowName) => [windowName, {
    ...bundle.payload.windows[windowName],
    views: new Map(SNA_VIEW_NAMES.map((view) => [view, bundle.payload.windows[windowName].views[view]])),
  }]));
  return { baseVersion: bundle.baseVersion, projectionVersion: bundle.projectionVersion, completeThroughRoomSeq: bundle.completeThroughRoomSeq, windows, status: "ready" };
}

export function selectSnaWindow(state: SnaState, windowName: SnaWindowName) {
  const selected = state.windows.get(windowName);
  if (!selected) throw new Error(`sna_window_missing:${windowName}`);
  return selected;
}

export function selectSnaView(state: SnaState, windowName: SnaWindowName, view: SnaViewName) {
  const selected = selectSnaWindow(state, windowName).views.get(view);
  if (!selected) throw new Error(`sna_view_missing:${view}`);
  return selected;
}
```

The browser never filters events or recomputes a rolling network. It switches only between the two server-generated windows and displays their exact start/end bounds. Do not derive percentages in React and do not keep `SNA_VIEW_METRICS` constants. Format server ratios with `Intl.NumberFormat("zh-Hant", { style: "percent", maximumFractionDigits: 0 })` and label them group-level only.

- [ ] **Step 4: Run SNA state tests**

Run: `pnpm --filter @learning-orbit/web test -- src/sna/sna-reducer.test.ts`

Expected: generated bundle type, shared base/projection version, numeric room-sequence cursor, exactly two bounded windows with exactly observed/human-only/lineage-adjusted views, repeated window/view switching and metric immutability tests pass.

- [ ] **Step 5: Commit SNA state**

```bash
git add apps/web/src/sna/sna-reducer.ts apps/web/src/sna/sna-reducer.test.ts apps/web/src/sna/sna-selectors.ts apps/web/src/sna/SnaMetrics.tsx
git commit -m "feat(web): consume TRACE SNA projection bundle"
```

### Task 15: Implement SVG SNA, list, inspector and screen-pixel port geometry

**Files:**
- Create: `learning-orbit/apps/web/src/sna/sna-view-adapter.ts`
- Create: `learning-orbit/apps/web/src/sna/sna-view-adapter.test.ts`
- Create: `learning-orbit/apps/web/src/sna/port-allocator.ts`
- Create: `learning-orbit/apps/web/src/sna/port-allocator.test.ts`
- Create: `learning-orbit/apps/web/src/sna/SnaPanel.tsx`
- Create: `learning-orbit/apps/web/src/sna/SnaPanel.test.tsx`
- Create: `learning-orbit/apps/web/src/sna/SnaGraph.tsx`
- Create: `learning-orbit/apps/web/src/sna/SnaList.tsx`
- Create: `learning-orbit/apps/web/src/sna/SnaInspector.tsx`
- Create: `learning-orbit/apps/web/src/sna/sna-live-controller.ts`
- Create: `learning-orbit/apps/web/src/sna/sna-live-controller.test.ts`
- Create: `learning-orbit/apps/web/src/sna/SnaPanel.module.css`

- [ ] **Step 1: Write failing reciprocal-edge and accessible-view tests**

```ts
import { ACTOR_A, ACTOR_B, EVENT_006, displayEventLabel } from "../testing/contract-fixtures";
import { TRACE_STUDENT_INTERPRETATION_ZH_HANT } from "@learning-orbit/contracts";
const screenDistance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

it.each([
  ["desktop", new DOMMatrix([1.5, 0, 0, 1.5, 24, 18])],
  ["mobile", new DOMMatrix([0.72, 0, 0, 0.72, 8, 12])],
] as const)("allocates complete reciprocal paths at least eight final screen pixels apart on %s", (_name, screenCtm) => {
  const [forward, reverse] = allocateScreenEdges(nodes, [edge(ACTOR_A, ACTOR_B), edge(ACTOR_B, ACTOR_A)], screenCtm);
  expect(screenDistance(forward.screen.sourcePort, reverse.screen.targetPort)).toBeGreaterThanOrEqual(8);
  expect(screenDistance(forward.screen.sourceFan, reverse.screen.targetFan)).toBeGreaterThanOrEqual(8);
  expect(screenDistance(forward.screen.targetFan, reverse.screen.sourceFan)).toBeGreaterThanOrEqual(8);
  expect(screenDistance(forward.screen.targetPort, reverse.screen.sourcePort)).toBeGreaterThanOrEqual(8);
  expect(forward.path).not.toBe(reverse.path);
  expect(forward.markerEndId).not.toBe(reverse.markerEndId);
  expect(forward.sourcePortId).not.toBe(reverse.targetPortId);
  expect(forward.targetPortId).not.toBe(reverse.sourcePortId);
  for (const t of [0.25, 0.5, 0.75]) {
    expect(screenDistance(sampleScreenPath(forward, t), sampleScreenPath(reverse, 1 - t))).toBeGreaterThanOrEqual(8);
  }
});

it("allocates multiple finite self-loops with distinct paths and incident ports", () => {
  const input = ["self-1", "self-2", "self-3"].map((edgeId) => ({ ...edge(ACTOR_A, ACTOR_A), edgeId }));
  const loops = allocateScreenEdges(nodes, input, new DOMMatrix());
  expect(new Set(loops.map((loop) => loop.path)).size).toBe(3);
  const ports = loops.flatMap((loop) => [loop.screen.sourcePort, loop.screen.targetPort]);
  for (const loop of loops) {
    expect(loop.path).not.toMatch(/NaN|Infinity/);
    expect(loop.sourcePortId).not.toBe(loop.targetPortId);
    expect(loop.path).toContain(" C ");
  }
  for (let left = 0; left < ports.length; left += 1) for (let right = left + 1; right < ports.length; right += 1) {
    expect(screenDistance(ports[left], ports[right])).toBeGreaterThanOrEqual(8);
  }
});

it("fails before port clamping then reflows a dense self-loop node", () => {
  const input = Array.from({ length: 6 }, (_, index) => ({ ...edge(ACTOR_A, ACTOR_A), edgeId: `dense-${index}` }));
  const ctm = new DOMMatrix([0.45, 0, 0, 0.45, 0, 0]);
  expect(() => allocateScreenEdges(nodes, input, ctm)).toThrow("SNA_PORT_CAPACITY");
  const fitted = fitNodesForPortCapacity(nodes, input, ctm);
  const loops = allocateScreenEdges(fitted.nodes, input, fitted.screenCtm);
  expect(new Set(loops.map((loop) => loop.path)).size).toBe(input.length);
});

it.each(["desktop", "mobile"] as const)("reflows a dense non-self star onto real connection boundaries on %s", (viewport) => {
  const fixture = denseStarFixture(viewport, { centerEdges: 14 });
  expect(() => allocateScreenEdges(fixture.nodes, fixture.edges, fixture.screenCtm)).toThrow("SNA_PORT_CAPACITY");
  const fitted = fitNodesForPortCapacity(fixture.nodes, fixture.edges, fixture.screenCtm);
  const allocated = allocateScreenEdges(fitted.nodes, fixture.edges, fitted.screenCtm);
  assertEveryIncidentPortPairAtLeast(allocated, 8);
  assertEveryPortOnItsConnectionBoundary(allocated, fitted.nodes, fitted.screenCtm, 0.001);
});

it("allocates mixed self-loop reciprocal and star incidences through one port solver", () => {
  const fixture = mixedIncidenceFixture();
  const fitted = fitNodesForPortCapacity(fixture.nodes, fixture.edges, fixture.screenCtm);
  const allocated = allocateScreenEdges(fitted.nodes, fixture.edges, fitted.screenCtm);
  assertEveryIncidentPortPairAtLeast(allocated, 8);
  assertEveryPortOnItsConnectionBoundary(allocated, fitted.nodes, fitted.screenCtm, 0.001);
  expect(new Set(allocated.map((item) => item.path)).size).toBe(allocated.length);
});
```

```tsx
it("[LO-HTML-07] exposes three SNA views group metrics geometry and limitation text", () => {
  render(<SnaPanel state={snaState} preferences={preferences} />);
  expect(screen.getByRole("button", { name: "全體互動" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "最近 10 分鐘" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "整場 45 分鐘" })).toBeVisible();
  expect(screen.getByText(/時間窗口：/)).toHaveTextContent(`${recentWindow.windowStartEventTime}–${recentWindow.windowEndEventTime}`);
  expect(screen.getAllByText(TRACE_STUDENT_INTERPRETATION_ZH_HANT).length).toBeGreaterThanOrEqual(2);
});

it("pauses only SNA presentation and resumes to the latest validated state", async () => {
  const controller = new SnaLiveController(snaStateV9);
  render(<SnaPanel controller={controller} preferences={preferences} />);
  await user.click(screen.getByRole("button", { name: "暫停 SNA 更新" }));
  controller.onValidatedLiveState(snaStateV10);
  controller.onValidatedLiveState(snaStateV11);
  expect(controller.getDisplayed().projectionVersion).toBe(9);
  expect(screen.getByRole("status", { name: "SNA 更新狀態" })).toHaveTextContent("背景仍在同步；互動圖暫停於版本 9；有 2 次已驗證更新待顯示");
  await user.click(screen.getByRole("button", { name: "繼續 SNA 更新" }));
  expect(controller.getDisplayed().projectionVersion).toBe(11);
  expect(controller.getDisplayed()).toBe(snaStateV11);
  expect(chatLedger.projectionVersion).toBe(42);
  expect(conceptState.projectionVersion).toBe(13);
});

it("[LO-HTML-12] announces SNA changes and gives every edge a unique accessible name", () => {
  render(<SnaPanel state={snaState} preferences={preferences} />);
  const names = screen.getAllByTestId("sna-edge").map((node) => node.getAttribute("aria-label"));
  expect(new Set(names).size).toBe(names.length);
  expect(screen.getByRole("status", { name: "SNA 更新狀態" })).toBeInTheDocument();
});

it("never exposes teacher evidence IDs from trace.student_bundle", () => {
  render(<SnaPanel role="student" state={studentSnaState} preferences={preferences} />);
  expect(screen.getByText(/方向|層級|群體指標|警示/)).toBeVisible();
  expect(screen.queryByText(/權重/)).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain(EVENT_006);
  expect(screen.queryByText(/來源事件|證據 ID/)).not.toBeInTheDocument();
});

it("allows the authorized teacher inspector to label bundle evidence", () => {
  render(<SnaPanel role="teacher" state={teacherSnaState} preferences={preferences} />);
  expect(screen.getByText(`來源事件：${displayEventLabel(EVENT_006)}`)).toBeVisible();
});

it("opens the same SNA node inspector by mouse Enter and Space", async () => {
  render(<SnaPanel role="student" state={studentSnaState} preferences={preferences} />);
  const student = screen.getByRole("button", { name: "同學節點：探索者 A，圓形" });
  expect(student).toHaveAttribute("data-hit-target", "true");
  expect(student).toHaveStyle({ minWidth: "44px", minHeight: "44px" });
  student.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("status", { name: "互動節點詳情" })).toHaveTextContent("探索者 A");
  const nova = screen.getByRole("button", { name: "Agent 節點：Nova Agent，六邊形" });
  await user.click(nova);
  expect(screen.getByRole("status", { name: "互動節點詳情" })).toHaveTextContent("Agent（六邊形）");
  await user.keyboard(" ");
});
```

- [ ] **Step 2: Run and verify geometry/view failures**

Run: `pnpm --filter @learning-orbit/web test -- src/sna/port-allocator.test.ts src/sna/SnaPanel.test.tsx`

Expected: FAIL because allocator and components do not exist.

- [ ] **Step 3: Add pure port allocation and authored SVG rendering**

`sna-view-adapter.ts` is the only bridge from the mutually exclusive generated teacher/student wire branches to geometry. It returns new immutable view objects and never adds fields to the wire value:

```ts
export type SnaNodeView = Readonly<{ nodeId: string; label: string; kind: "learner" | "agent" | "room"; x: number; y: number; width: number; height: number }>;
export type SnaEdgeView = Readonly<{ edgeId: string; source: string; target: string; layer: string; teacherWeight?: number; teacherEvidenceLabels?: readonly string[] }>;
const safeDomKey = (value: string) => [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const adaptNodes = (wireNodes: readonly { nodeId: string; label: string; kind: "learner" | "agent" | "room" }[]) => {
  const ordered = [...wireNodes].sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label) || a.nodeId.localeCompare(b.nodeId));
  return ordered.map((node, index) => ({ ...stablePilotAnchor(node, index, ordered.length), nodeId: node.nodeId, label: node.label, kind: node.kind, width: 72, height: 52 }));
};

export function adaptSnaView(bundle: SnaProjectionBundle, windowName: SnaWindowName, viewName: SnaViewName): { nodes: readonly SnaNodeView[]; edges: readonly SnaEdgeView[] } {
  if (bundle.projectionKey === "trace.teacher_bundle") {
    const wire = bundle.payload.windows[windowName].views[viewName];
    const edges = wire.edges.map((edge) => ({ edgeId: edge.edgeId, source: edge.sourceId, target: edge.targetId, layer: edge.layer, teacherWeight: edge.weight, teacherEvidenceLabels: edge.evidenceRefs.map((ref) => displayEventLabel(ref.eventId)) }));
    return { nodes: Object.freeze(adaptNodes(wire.nodes)), edges: Object.freeze(edges) };
  }
  const wire = bundle.payload.windows[windowName].views[viewName];
  const occurrence = new Map<string, number>();
  const edges = wire.edges.map((edge) => {
    const key = `${windowName}\u0000${viewName}\u0000${edge.sourceNodeId}\u0000${edge.targetNodeId}\u0000${edge.layer}`;
    const ordinal = occurrence.get(key) ?? 0;
    occurrence.set(key, ordinal + 1);
    return { edgeId: `student-ui-${safeDomKey(key)}-${ordinal}`, source: edge.sourceNodeId, target: edge.targetNodeId, layer: edge.layer };
  });
  return { nodes: Object.freeze(adaptNodes(wire.nodes)), edges: Object.freeze(edges) };
}
```

The adapter narrows on the generated projection-key discriminator before reading branch-only fields. The NUL-delimited tuple is only hash/encoding input; `safeDomKey` emits lowercase hex, so student edge IDs match `^[A-Za-z0-9_-]+$`, remain safe in HTML/SVG IDs, marker URLs and selectors, and never leave the browser. Student output contains no weight, channels or evidence. `stablePilotAnchor` uses fixed normalized anchors for the four sorted pseudonymous learners, Nova and the optional virtual room, then scales through the SVG viewBox; existing nodes never drift when edges update. Tests deep-freeze the generated bundle, adapt both windows × all three views, prove no mutation, assert safe/unique DOM IDs and live marker references, prove the student view lacks `teacherWeight`/evidence, and prove teacher-only fields stay teacher-only.

```ts
const SCREEN_PORT_SEPARATION = 8;
const SCREEN_FAN_LENGTH = 12;
const SCREEN_CURVE_SEPARATION = 16;

type ScreenBoundary = Readonly<{ center: DOMPoint; radiusX: number; radiusY: number }>;
type ScreenEndpoint = Readonly<{ edgeId: string; peerId: string; end: "source" | "target" }>;
const distance = (a: Pick<DOMPoint, "x" | "y">, b: Pick<DOMPoint, "x" | "y">) => Math.hypot(a.x - b.x, a.y - b.y);
const unorderedPairKey = (a: string, b: string) => [a, b].sort().join("\u0000");

function indexScreenIncidence(edges: readonly SnaEdgeView[]) {
  const result = new Map<string, ScreenEndpoint[]>();
  const add = (nodeId: string, endpoint: ScreenEndpoint) => result.set(nodeId, [...(result.get(nodeId) ?? []), endpoint]);
  for (const edge of edges) {
    add(edge.source, { edgeId: edge.edgeId, peerId: edge.target, end: "source" });
    add(edge.target, { edgeId: edge.edgeId, peerId: edge.source, end: "target" });
  }
  for (const endpoints of result.values()) endpoints.sort((a, b) => a.peerId.localeCompare(b.peerId) || a.end.localeCompare(b.end) || a.edgeId.localeCompare(b.edgeId));
  return result;
}

function groupByUnorderedNodePair(edges: readonly SnaEdgeView[]) {
  const result = new Map<string, SnaEdgeView[]>();
  for (const edge of edges) {
    const key = unorderedPairKey(edge.source, edge.target);
    result.set(key, [...(result.get(key) ?? []), edge]);
  }
  for (const group of result.values()) group.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.edgeId.localeCompare(b.edgeId));
  return result;
}

function toScreenBoundary(node: SnaNodeView, matrix: DOMMatrixReadOnly): ScreenBoundary {
  const center = new DOMPoint(node.x, node.y).matrixTransform(matrix);
  const right = new DOMPoint(node.x + node.width / 2, node.y).matrixTransform(matrix);
  const bottom = new DOMPoint(node.x, node.y + node.height / 2).matrixTransform(matrix);
  return { center, radiusX: Math.max(1, distance(center, right)), radiusY: Math.max(1, distance(center, bottom)) };
}

const endpointKey = (nodeId: string, endpoint: ScreenEndpoint) => `${nodeId}\u0000${endpoint.edgeId}\u0000${endpoint.end}`;
const angleDistance = (left: number, right: number) => Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));

function boundaryPoint(boundary: ScreenBoundary, angle: number): DOMPoint {
  return new DOMPoint(
    boundary.center.x + boundary.radiusX * Math.cos(angle),
    boundary.center.y + boundary.radiusY * Math.sin(angle),
  );
}

function preferredEndpointAngle(
  nodeId: string,
  endpoint: ScreenEndpoint,
  edgesById: ReadonlyMap<string, SnaEdgeView>,
  byNode: ReadonlyMap<string, ScreenBoundary>,
  pairGroups: ReadonlyMap<string, readonly SnaEdgeView[]>,
): number {
  const edge = edgesById.get(endpoint.edgeId)!;
  if (edge.source === edge.target) {
    const loops = pairGroups.get(unorderedPairKey(edge.source, edge.target))!;
    const rank = loops.findIndex((candidate) => candidate.edgeId === edge.edgeId) - (loops.length - 1) / 2;
    return -Math.PI / 2 + rank * 0.08 + (endpoint.end === "source" ? -0.35 : 0.35);
  }
  const center = byNode.get(nodeId)!.center;
  const peer = byNode.get(endpoint.peerId)!.center;
  return Math.atan2(peer.y - center.y, peer.x - center.x);
}

function allocateAllScreenPorts(
  incidence: ReadonlyMap<string, readonly ScreenEndpoint[]>,
  edgesById: ReadonlyMap<string, SnaEdgeView>,
  byNode: ReadonlyMap<string, ScreenBoundary>,
  pairGroups: ReadonlyMap<string, readonly SnaEdgeView[]>,
): ReadonlyMap<string, DOMPoint> {
  const result = new Map<string, DOMPoint>();
  for (const [nodeId, endpoints] of incidence) {
    const boundary = byNode.get(nodeId)!;
    const candidates = Array.from({ length: 720 }, (_, index) => ({
      index,
      angle: -Math.PI + index * (2 * Math.PI / 720),
      point: boundaryPoint(boundary, -Math.PI + index * (2 * Math.PI / 720)),
    }));
    const ordered = endpoints.map((endpoint) => ({
      endpoint,
      preferred: preferredEndpointAngle(nodeId, endpoint, edgesById, byNode, pairGroups),
    })).sort((left, right) => left.preferred - right.preferred || endpointKey(nodeId, left.endpoint).localeCompare(endpointKey(nodeId, right.endpoint)));
    const assigned: DOMPoint[] = [];
    for (const item of ordered) {
      const candidate = candidates
        .filter(({ point }) => assigned.every((prior) => distance(point, prior) >= SCREEN_PORT_SEPARATION))
        .sort((left, right) => angleDistance(left.angle, item.preferred) - angleDistance(right.angle, item.preferred) || left.index - right.index)[0];
      if (!candidate) throw new PortCapacityError("SNA_PORT_CAPACITY");
      assigned.push(candidate.point);
      result.set(endpointKey(nodeId, item.endpoint), candidate.point);
    }
    for (let left = 0; left < assigned.length; left += 1) for (let right = left + 1; right < assigned.length; right += 1) {
      if (distance(assigned[left], assigned[right]) < SCREEN_PORT_SEPARATION) throw new PortCapacityError("SNA_PORT_CAPACITY");
    }
  }
  return result;
}

function svgPoint(point: DOMPoint, inverse: DOMMatrixReadOnly) {
  const transformed = point.matrixTransform(inverse);
  return `${transformed.x} ${transformed.y}`;
}

export function allocateScreenEdges(nodes: readonly SnaNodeView[], edges: readonly SnaEdgeView[], matrix: DOMMatrixReadOnly): AllocatedEdge[] {
  const byNode = new Map(nodes.map((node) => [node.nodeId, toScreenBoundary(node, matrix)]));
  const incidence = indexScreenIncidence(edges); // Sort by peerId, endpoint role, then edgeId.
  const pairGroups = groupByUnorderedNodePair(edges); // Each group is sorted by source, target, edgeId.
  const edgesById = new Map(edges.map((edge) => [edge.edgeId, edge]));
  const ports = allocateAllScreenPorts(incidence, edgesById, byNode, pairGroups);
  const inverse = matrix.inverse();
  return edges.map((item) => {
    const sourcePort = ports.get(endpointKey(item.source, { edgeId: item.edgeId, peerId: item.target, end: "source" }))!;
    const targetPort = ports.get(endpointKey(item.target, { edgeId: item.edgeId, peerId: item.source, end: "target" }))!;
    if (item.source === item.target) {
      const loops = pairGroups.get(unorderedPairKey(item.source, item.target))!;
      const loopIndex = loops.findIndex((candidate) => candidate.edgeId === item.edgeId);
      const sourceFan = new DOMPoint(sourcePort.x - SCREEN_FAN_LENGTH, sourcePort.y - SCREEN_FAN_LENGTH);
      const targetFan = new DOMPoint(targetPort.x + SCREEN_FAN_LENGTH, targetPort.y - SCREEN_FAN_LENGTH);
      const loopRise = SCREEN_CURVE_SEPARATION * (loopIndex + 1);
      const control1 = new DOMPoint(sourceFan.x - loopRise, sourceFan.y - loopRise);
      const control2 = new DOMPoint(targetFan.x + loopRise, targetFan.y - loopRise);
      return { ...item, sourcePortId: `${item.source}:${item.edgeId}:source`, targetPortId: `${item.target}:${item.edgeId}:target`, markerEndId: `arrow-${item.edgeId}`, pathKind: "cubic" as const, path: `M ${svgPoint(sourcePort, inverse)} L ${svgPoint(sourceFan, inverse)} C ${svgPoint(control1, inverse)} ${svgPoint(control2, inverse)} ${svgPoint(targetFan, inverse)} L ${svgPoint(targetPort, inverse)}`, screen: { sourcePort, sourceFan, control1, control2, targetFan, targetPort } };
    }
    const length = distance(sourcePort, targetPort) || 1;
    const direction = { x: (targetPort.x - sourcePort.x) / length, y: (targetPort.y - sourcePort.y) / length };
    const sourceFan = new DOMPoint(sourcePort.x + direction.x * SCREEN_FAN_LENGTH, sourcePort.y + direction.y * SCREEN_FAN_LENGTH);
    const targetFan = new DOMPoint(targetPort.x - direction.x * SCREEN_FAN_LENGTH, targetPort.y - direction.y * SCREEN_FAN_LENGTH);
    const pair = pairGroups.get(unorderedPairKey(item.source, item.target))!;
    const pairRank = pair.findIndex((candidate) => candidate.edgeId === item.edgeId) - (pair.length - 1) / 2;
    const [canonicalSourceId, canonicalTargetId] = [item.source, item.target].sort();
    const canonicalSource = byNode.get(canonicalSourceId)!.center;
    const canonicalTarget = byNode.get(canonicalTargetId)!.center;
    const canonicalLength = distance(canonicalSource, canonicalTarget) || 1;
    const canonicalNormal = { x: -(canonicalTarget.y - canonicalSource.y) / canonicalLength, y: (canonicalTarget.x - canonicalSource.x) / canonicalLength };
    const control = new DOMPoint((sourceFan.x + targetFan.x) / 2 + canonicalNormal.x * pairRank * SCREEN_CURVE_SEPARATION, (sourceFan.y + targetFan.y) / 2 + canonicalNormal.y * pairRank * SCREEN_CURVE_SEPARATION);
    return {
      ...item,
      sourcePortId: `${item.source}:${item.edgeId}:source`,
      targetPortId: `${item.target}:${item.edgeId}:target`,
      markerEndId: `arrow-${item.edgeId}`,
      pathKind: "quadratic" as const,
      path: `M ${svgPoint(sourcePort, inverse)} L ${svgPoint(sourceFan, inverse)} Q ${svgPoint(control, inverse)} ${svgPoint(targetFan, inverse)} L ${svgPoint(targetPort, inverse)}`,
      screen: { sourcePort, sourceFan, control, targetFan, targetPort },
    };
  });
}
```

`indexScreenIncidence` expands every edge—self-loop and ordinary—into source and target endpoint records. `allocateAllScreenPorts` is the single node-level solver for the complete incident set: it derives a preferred direction from the peer (or stable left/right loop angles), chooses deterministic samples on the exact final-screen connection ellipse, and accepts a sample only when it stays at least 8px from every already assigned port. A final all-pairs check is mandatory. It never computes an ellipse intersection and then shifts the point off the boundary. The graph renders that neutral connection ellipse as a subtle port ring around the inner identity shape; learners remain circles, Nova remains a clearly labeled hexagon, and the virtual room remains a rounded square, while every line endpoint visibly lands on the common ring.

If any self-loop, reciprocal, parallel or star endpoint cannot be placed, the solver throws `SNA_PORT_CAPACITY` before creating a path. `SnaGraph` catches only that stable code, calls `fitNodesForPortCapacity` to enlarge the same rendered port ring/node footprint and pannable canvas in an immutable layout, waits for the next non-null CTM, and retries. Desktop/mobile tests cover dense non-self stars and mixed self-loop+reciprocal incidence, assert every port satisfies the ellipse equation within tolerance, every incident pair remains at least 8 final screen pixels apart, and exercise fail→reflow→retry. `groupByUnorderedNodePair` still uses one normal vector computed from the lexically ordered node pair, so reversing direction cannot put tracks on the same curve; tests sample full screen-space curves at endpoints, fan points, 25%, 50% and 75%. `SnaGraph` recalculates on `ResizeObserver`, viewBox changes and application zoom. Ports, 12px fan-outs and curve separation are computed in final screen space, then transformed through the inverse CTM solely for the SVG `d` attribute. It never uses D3.

The SNA visual SVG is `aria-hidden="true"` and `focusable="false"`. As in the concept panel, a same-coordinate HTML control plane overlays native 44×44 minimum buttons for every node and edge (`data-testid="sna-edge"` on edge buttons); those buttons carry unique accessible names, pressed state, visible focus and native pointer/Enter/Space behavior. The SVG paths, markers, shapes and labels are visual only, so no interactive role is nested under an SVG `role="img"`. Render human nodes as circles with a visible “同學” cue, the server-owned Nova Agent node as a hexagon with “Agent”, and the optional virtual room as a rounded square labeled “全室廣播”; shape and text, not color alone, identify kind. Render reciprocal edges in a distinct style, lineage edges dashed, and give every visible edge a matching overlay hit button. Each arrowhead marker and endpoint port has a unique per-edge ID. `SnaList` is a fully semantic equivalent backed by the same adapted view.

`SnaGraph`, `SnaList`, `SnaMetrics` and `SnaInspector` consume the same adapted selected window/view. The two time buttons write `snaWindow=recent_10m|session_45m` through the validated preference module, display the generated start/end bounds, and switch graph, list, metrics and inspector atomically; the browser never filters events or relabels one window as another. A student `trace.student_bundle` contains no evidence identifiers or edge weights, so student list/inspector output is restricted to node kind, structure, layer, direction, group metrics and warnings. The panel and list both expose the exact canonical `TRACE_STUDENT_INTERPRETATION_ZH_HANT` sentence, and each metric group repeats it through `GroupMetricDisclosure`. Only an authorized teacher projection may supply weight/channels/evidence identifiers, which the adapter and teacher inspector turn into display labels without exposing UUIDs as visible text. Node selection is mouse/keyboard equivalent in graph and list; the inspector explains kind and incident observed directions without ranking or personal scoring.

`SnaLiveController` owns presentation pause only. ProjectionSync and the canonical SNA reducer continue validating every server bundle while paused; the controller holds the last displayed immutable state and counts newer validated versions. The panel says “背景仍在同步；互動圖暫停於版本 N；有 M 次已驗證更新待顯示”, so a global “已同步” badge can never imply that the visible SNA is current. Resume replaces the displayed reference with the current latest validated state once—never replays unvalidated wire data, invents a version, pauses chat/concept, or changes the selected time window. A stale/failed live state leaves the last-good graph visible with honest copy and retry; closing/reopening the page starts from an authenticated current snapshot, not persisted local scientific state. Reduced motion does not auto-resume. The status announcement is batched once per displayed update or pause/resume action.

- [ ] **Step 4: Run geometry and component tests**

Run: `pnpm --filter @learning-orbit/web test -- src/sna/sna-view-adapter.test.ts src/sna/sna-live-controller.test.ts src/sna/port-allocator.test.ts src/sna/SnaPanel.test.tsx`

Expected: desktop and mobile matrices preserve at least 8 final screen pixels along reciprocal/parallel paths, fan-outs and all incident ports; dense non-self stars and mixed self-loop/reciprocal graphs fail capacity before path creation, reflow, then place every port on its rendered connection boundary; multiple self-loops have finite unique paths; full directed paths, arrowheads and endpoint IDs differ; visual SVGs stay hidden from accessibility APIs while native overlay controls and lists remain equivalent; immutable role adapters, two-window/three-view atomic switching, presentation pause/resume, graph/list, node mouse/keyboard inspection, role-scoped fields, unique-name, status and full canonical limitation tests pass.

- [ ] **Step 5: Commit SNA rendering**

```bash
git add apps/web/src/sna
git commit -m "feat(web): render screen-correct SNA views"
```

### Task 16: Build the role-gated teacher review console

**Files:**
- Create: `learning-orbit/apps/web/app/teacher/page.tsx`
- Create: `learning-orbit/apps/web/app/session/[roomId]/teacher/page.tsx`
- Create: `learning-orbit/apps/web/src/teacher/TeacherConsole.tsx`
- Create: `learning-orbit/apps/web/src/teacher/TeacherConsole.test.tsx`
- Create: `learning-orbit/apps/web/src/teacher/teacher-room-context.ts`
- Create: `learning-orbit/apps/web/src/teacher/teacher-room-context.test.ts`
- Create: `learning-orbit/apps/web/src/teacher/TeacherAuthPanel.tsx`
- Create: `learning-orbit/apps/web/src/teacher/RoomAccessCodes.tsx`
- Create: `learning-orbit/apps/web/src/teacher/RoomLifecycleControls.tsx`
- Create: `learning-orbit/apps/web/src/teacher/AgentPolicyControls.tsx`
- Create: `learning-orbit/apps/web/src/teacher/ReviewQueue.tsx`
- Create: `learning-orbit/apps/web/src/teacher/CorrectionForm.tsx`
- Create: `learning-orbit/apps/web/src/teacher/ExportControls.tsx`
- Create: `learning-orbit/apps/web/src/teacher/DeleteSessionDialog.tsx`
- Create: `learning-orbit/apps/web/src/teacher/DeletionRecoveryPage.tsx`
- Create: `learning-orbit/apps/web/src/teacher/DeletionRecoveryPage.test.tsx`
- Create: `learning-orbit/apps/web/src/teacher/use-deletion-saga.ts`
- Create: `learning-orbit/apps/web/src/teacher/TeacherConsole.module.css`

The generated teacher `AuthSession` intentionally has no `roomId`. The route layer first obtains and narrows `AuthSession`, then calls content-free `getRoomDeletion(roomId)` before attempting `getRoom`: if a job/receipt exists, it constructs `DeletionRecoveryContext = {teacherSession,roomId,deletion}` and renders `DeletionRecoveryPage` without loading `RoomDetails`; only when no job exists may it fetch room content. That ordering makes running/dead/completed reload recovery possible after ordinary room reads correctly become 410. The normal route then holds a local `SessionRoomContext = { authSession: AuthSession; roomId: string; room: RoomDetails }`, applies `requireTeacherRoomContext`, and only then constructs the narrower non-serializable `TeacherRoomContext = { authSession: Extract<AuthSession, {role:"teacher"}>; roomId: string; room: RoomDetails }`. `TeacherConsole` accepts only `TeacherRoomContext`, so an impossible student branch cannot be smuggled into its props. `/teacher` hosts magic-link request and room creation. `/session/[roomId]/teacher` takes `roomId` only from the route and never adds it to `AuthSession` or trusts query/local storage.

- [ ] **Step 1: Write failing role, correction, export and deletion tests**

```tsx
import {
  ACTOR_A, ACTOR_B, ACTOR_C, ACTOR_D, DELETION_JOB_ID, EPOCH_A, EVENT_006, EVENT_007, PROJECTION_TARGET_ID, REVIEW_CAUSATION_ID,
  ROOM_CODE, ROOM_ID, ROOM_MEMBER_A, ROOM_MEMBER_B, ROOM_MEMBER_C, ROOM_MEMBER_D,
  SEAT_CODE_A, SEAT_CODE_B, SEAT_CODE_C, SEAT_CODE_D, SOURCE_ARTIFACT_ID, displayEventLabel,
} from "../testing/contract-fixtures";

it("rejects a student session at the route boundary before constructing TeacherRoomContext", () => {
  expect(() => requireTeacherRoomContext({ authSession: studentAuthSession, roomId: ROOM_ID, room: roomBootstrap })).toThrowError("TEACHER_ROUTE_REQUIRED");
  expect(TeacherConsole).not.toHaveBeenCalled();
});

it("submits a generated replace_relation correction for a provenance-bearing teacher edge", async () => {
  const recorded = analyticsCorrectionRecordedEnvelope({ causationId: REVIEW_CAUSATION_ID, roomSeq: 129 });
  gateway.submitAnalyticsReview.mockResolvedValue(recorded);
  render(<TeacherConsole context={teacherRoomContext} gateway={gateway} commandBus={commandBus} />);
  await user.click(screen.getByRole("button", { name: `修正${displayEventLabel(EVENT_006)}擷取的概念關係` }));
  await user.type(screen.getByLabelText("修正理由"), "來源內容只能支持暫定關係");
  await user.click(screen.getByRole("button", { name: "提交修正" }));
  expect(gateway.submitAnalyticsReview).toHaveBeenCalledWith(teacherRoomContext.roomId, {
    targetProjectionEdgeId: PROJECTION_TARGET_ID,
    correctionKind: "replace_relation",
    replacement: replaceRelationFixture,
    reason: "來源內容只能支持暫定關係",
    expectedAnalysisEpoch: EPOCH_A,
    expectedProjectionVersion: 12,
  });
  const submitted = gateway.submitAnalyticsReview.mock.calls[0][1];
  for (const forbidden of ["action", "projectionKey", "targetKind", "evidenceRefs", "expectedVersion"]) expect(submitted).not.toHaveProperty(forbidden);
  expect(commandBus.send).not.toHaveBeenCalled();
  expect(recorded).toMatchObject({ type: "analytics.correction.recorded.v1", causationId: REVIEW_CAUSATION_ID, roomSeq: 129 });
  expect(screen.getByRole("status", { name: "審閱狀態" })).toHaveTextContent("審閱已記錄，等待分析重建／投影更新");
});

it("submits the generated review variant without correction-only fields", async () => {
  gateway.submitAnalyticsReview.mockResolvedValue(analyticsReviewRecordedEnvelope({ causationId: EVENT_007, roomSeq: 130 }));
  render(<TeacherConsole context={teacherRoomContext} gateway={gateway} commandBus={commandBus} />);
  await user.click(screen.getByRole("button", { name: "通過投影審閱" }));
  expect(gateway.submitAnalyticsReview).toHaveBeenCalledWith(teacherRoomContext.roomId, {
    targetType: "projection",
    targetId: PROJECTION_TARGET_ID,
    decision: "approve",
    rationale: "證據與關係呈現一致",
    expectedAnalysisEpoch: EPOCH_A,
    expectedProjectionVersion: 12,
  });
});

it("pages teacher-only DerivedTextArtifact targets with the shared route builder", async () => {
  gateway.getDerivedTextArtifacts
    .mockResolvedValueOnce(derivedTextArtifactPage1)
    .mockResolvedValueOnce(derivedTextArtifactPage2);
  render(<TeacherConsole context={teacherRoomContext} gateway={gateway} commandBus={commandBus} />);
  expect(gateway.getDerivedTextArtifacts).toHaveBeenNthCalledWith(1, ROOM_ID, { reviewStatus: PENDING_REVIEW_STATUS, afterArtifactId: undefined, includeHistory: false, limit: 50 });
  await user.click(screen.getByRole("button", { name: "載入更多待審閱產物" }));
  expect(gateway.getDerivedTextArtifacts).toHaveBeenNthCalledWith(2, ROOM_ID, { reviewStatus: PENDING_REVIEW_STATUS, afterArtifactId: SOURCE_ARTIFACT_ID, includeHistory: false, limit: 50 });
  expect(gateway.getDerivedTextArtifacts.mock.calls.every(([, query]) => query.limit <= 100)).toBe(true);
});

it.each(["teacher@approved.school", "unknown@example.test"])("returns the same non-enumerating magic-link copy for %s", async (email) => {
  gateway.requestTeacherMagicLink.mockResolvedValue({ accepted: true });
  render(<TeacherAuthPanel gateway={gateway} />);
  await user.type(screen.getByLabelText("教師電郵"), email);
  await user.click(screen.getByRole("button", { name: "傳送登入連結" }));
  expect(screen.getByRole("status")).toHaveTextContent("如該電郵獲授權，登入連結將寄到信箱");
  expect(screen.queryByRole("link", { name: /登入/ })).not.toBeInTheDocument();
});

it("creates the server-fixed 45-minute ecosystem room and reveals access codes once", async () => {
  const created = createRoomResponseFixture({
    room: { roomId: ROOM_ID, roomCode: ROOM_CODE, status: "scheduled", durationSeconds: 2700 },
    seatInvites: [
      { roomMemberId: ROOM_MEMBER_A, actorId: ACTOR_A, pseudonym: "探索者 A", code: SEAT_CODE_A },
      { roomMemberId: ROOM_MEMBER_B, actorId: ACTOR_B, pseudonym: "探索者 B", code: SEAT_CODE_B },
      { roomMemberId: ROOM_MEMBER_C, actorId: ACTOR_C, pseudonym: "探索者 C", code: SEAT_CODE_C },
      { roomMemberId: ROOM_MEMBER_D, actorId: ACTOR_D, pseudonym: "探索者 D", code: SEAT_CODE_D },
    ],
  });
  gateway.createRoom.mockResolvedValue(created);
  render(<TeacherConsole context={teacherRoomContext} gateway={gateway} commandBus={commandBus} />);
  expect(screen.queryByLabelText(/分鐘|時長/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "建立 45 分鐘生態探究課堂" }));
  expect(gateway.createRoom).toHaveBeenCalledWith({ topic: "生態系統探究" });
  expect(created.room).toMatchObject({ roomId: ROOM_ID, roomCode: ROOM_CODE, status: "scheduled", durationSeconds: 2700 });
  expect(created.room).not.toHaveProperty("startsAt");
  expect(created.room).not.toHaveProperty("closesAt");
  expect(screen.getByText(ROOM_CODE)).toBeVisible();
  for (const invite of created.seatInvites) {
    expect(screen.getByText(invite.pseudonym)).toBeVisible();
    expect(screen.getByText(invite.code)).toBeVisible();
  }
  expect(screen.getByRole("button", { name: "複製課堂代碼" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "列印座位卡" })).toBeEnabled();
  expect(screen.getByText("代碼只在本次建立回應顯示；不要截圖、記錄到日誌或貼到公開頻道")).toBeVisible();
  expect(screen.queryByText(/固定結束時間/)).not.toBeInTheDocument();
});

it("derives startsAt and closesAt only from room.open acknowledgment and never extends closesAt while paused", async () => {
  const { rerender } = render(<RoomLifecycleControls room={scheduledRoom} currentAgent={agentCurrentState} commandBus={commandBus} gateway={gateway} />);
  expect(screen.queryByText(/固定結束時間/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "開放課堂" }));
  expect(commandBus.send).toHaveBeenCalledWith({ type: "room.open" });
  expect(screen.queryByText(/固定結束時間/)).not.toBeInTheDocument();
  rerender(<RoomLifecycleControls room={openRoom} currentAgent={agentCurrentState} commandBus={commandBus} gateway={gateway} />);
  expect(screen.getByText(formatClosesAt(openRoom.closesAt!))).toBeVisible();
  await user.click(screen.getByRole("button", { name: "暫停課堂" }));
  expect(commandBus.send).toHaveBeenCalledWith({ type: "room.pause" });
  rerender(<RoomLifecycleControls room={{ ...openRoom, status: "paused" }} currentAgent={agentCurrentState} commandBus={commandBus} gateway={gateway} />);
  expect(screen.getByText(formatClosesAt(openRoom.closesAt!))).toBeVisible();
  expect(commandBus.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "agent.enable" }));
  expect(commandBus.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "agent.disable" }));
});

it("uses the sanitized server filename for export and revokes the local object URL", async () => {
  const blob = new Blob(["synthetic"], { type: "text/csv" });
  gateway.exportRoom.mockResolvedValue({ blob, fileName: "learning-orbit-ecosystem.csv" });
  render(<ExportControls roomId={ROOM_ID} gateway={gateway} />);
  await user.click(screen.getByRole("button", { name: "匯出 CSV" }));
  expect(gateway.exportRoom).toHaveBeenCalledWith(ROOM_ID, "csv");
  expect(clickedDownload).toMatchObject({ download: "learning-orbit-ecosystem.csv", href: expect.stringMatching(/^blob:/) });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(clickedDownload.href);
  expect(logger).not.toHaveBeenCalledWith(expect.stringContaining("synthetic"));
});

it("does not claim deletion until the generated content-free receipt arrives", async () => {
  gateway.getRoomDeletion.mockResolvedValue(null);
  gateway.requestRoomDeletion.mockResolvedValue(deleteRoomAcceptedFixture({ deletionJobId: DELETION_JOB_ID, status: "queued" }));
  gateway.getDeletionStatus
    .mockResolvedValueOnce(deletionStatusFixture("running"))
    .mockResolvedValueOnce(deletionStatusFixture("retryable"))
    .mockResolvedValueOnce(completedDeletionStatusFixture());
  render(<DeleteSessionDialog roomId={ROOM_ID} gateway={gateway} />);
  await waitFor(() => expect(gateway.getRoomDeletion).toHaveBeenCalledWith(ROOM_ID));
  await user.type(screen.getByLabelText(`輸入 DELETE ${ROOM_ID}`), `DELETE ${ROOM_ID}`);
  await user.click(screen.getByRole("button", { name: "確認刪除" }));
  expect(gateway.requestRoomDeletion).toHaveBeenCalledWith(ROOM_ID, { confirmation: `DELETE ${ROOM_ID}` });
  expect(screen.getByRole("button", { name: "確認刪除" })).toBeDisabled();
  expect(screen.queryByText("課堂已刪除")).not.toBeInTheDocument();
  await vi.runAllTimersAsync();
  expect(gateway.getDeletionStatus).toHaveBeenCalledWith(DELETION_JOB_ID);
  expect(screen.getByRole("status", { name: "刪除狀態" })).toHaveTextContent("刪除收據已確認");
  expect(screen.queryByText(/訊息內容|媒體內容|匯出內容/)).not.toBeInTheDocument();
});

it("resumes an existing deletion poll and reports dead without a false success", async () => {
  gateway.getRoomDeletion.mockResolvedValue(deleteRoomAcceptedFixture({ deletionJobId: DELETION_JOB_ID, status: "queued" }));
  gateway.getDeletionStatus.mockResolvedValue(deletionStatusFixture("dead"));
  render(<DeleteSessionDialog roomId={ROOM_ID} gateway={gateway} />);
  await vi.runOnlyPendingTimersAsync();
  expect(gateway.requestRoomDeletion).not.toHaveBeenCalled();
  expect(gateway.getRoomDeletion).toHaveBeenCalledWith(ROOM_ID);
  expect(gateway.getDeletionStatus).toHaveBeenCalledWith(DELETION_JOB_ID);
  expect(screen.getByRole("alert")).toHaveTextContent("刪除工作未完成；請保留工作編號並聯絡管理員");
  expect(screen.queryByText("課堂已刪除")).not.toBeInTheDocument();
});

it.each(["running", "dead", "completed"] as const)("reloads %s deletion without reading RoomDetails", async (status) => {
  gateway.getAuthSession.mockResolvedValue(teacherAuthSession);
  gateway.getRoomDeletion.mockResolvedValue(status === "completed" ? completedDeletionStatusFixture() : deletionStatusFixture(status));
  render(await loadTeacherRoute({ roomId: ROOM_ID, gateway }));
  expect(gateway.getRoomDeletion).toHaveBeenCalledBefore(gateway.getRoom as never);
  expect(gateway.getRoom).not.toHaveBeenCalled();
  expect(screen.getByRole(status === "dead" ? "alert" : "status", { name: "刪除狀態" })).toBeVisible();
  expect(screen.queryByRole("region", { name: "共學對話" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run and verify missing console failures**

Run: `pnpm --filter @learning-orbit/web test -- src/teacher/TeacherConsole.test.tsx src/teacher/teacher-room-context.test.ts src/teacher/DeletionRecoveryPage.test.tsx`

Expected: FAIL because teacher components are absent.

- [ ] **Step 3: Implement auditable, non-optimistic analytics reviews**

```tsx
export function TeacherAuthPanel({ gateway }: { gateway: SessionGateway }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("");
  return <form onSubmit={async (event) => { event.preventDefault(); await gateway.requestTeacherMagicLink({ email }); setStatus("如該電郵獲授權，登入連結將寄到信箱"); }}>
    <label htmlFor="teacher-email">教師電郵</label>
    <input id="teacher-email" name="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
    <button type="submit">傳送登入連結</button>
    <p role="status" aria-live="polite">{status}</p>
  </form>;
}
```

`requestTeacherMagicLink` POSTs generated `{ email }` to `/v1/auth/teacher/magic-link` and parses only the generic `202` shape `{ accepted: true }`; all syntactically valid allowed/unknown addresses show the same copy. Native input plus the generated request validator blocks malformed syntax before submit, while the server's bounded malformed response still reveals no allowlist result. The client never receives or renders a `loginUrl`, code or state. The emailed server link is consumed by normal browser navigation; the server sets the HttpOnly cookie and responds `303 /teacher`. On `/teacher`, call `getAuthSession()` to hydrate the role and room context—there is no client-side consume request.

```tsx
export function RoomAccessCodes({ created }: { created: CreateRoomResponse }) {
  return <section aria-labelledby="access-codes-title">
    <h2 id="access-codes-title">一次性課堂代碼</h2>
    <p>{created.room.roomCode}</p>
    <ol>{created.seatInvites.map((invite) => <li key={invite.roomMemberId}><span>{invite.pseudonym}</span><code>{invite.code}</code></li>)}</ol>
    <button type="button" onClick={() => navigator.clipboard.writeText([created.room.roomCode, ...created.seatInvites.map((invite) => `${invite.pseudonym}\t${invite.code}`)].join("\n"))}>複製課堂代碼</button>
    <button type="button" onClick={() => window.print()}>列印座位卡</button>
    <p role="note">代碼只在本次建立回應顯示；不要截圖、記錄到日誌或貼到公開頻道</p>
  </section>;
}
```

```tsx
export function RoomLifecycleControls({ room, currentAgent, commandBus, gateway }: RoomLifecycleControlsProps) {
  const send = (type: "room.open" | "room.pause" | "room.resume" | "room.close") => commandBus.send({ type });
  return <section aria-label="課堂控制">
    {room.startsAt && room.closesAt ? <p>固定結束時間：<time dateTime={room.closesAt}>{formatClosesAt(room.closesAt)}</time></p> : <p role="status">課堂尚未開放；開放後由伺服器設定 45 分鐘結束時間</p>}
    {room.status === "scheduled" ? <button type="button" onClick={() => send("room.open")}>開放課堂</button> : null}
    {room.status === "open" ? <button type="button" onClick={() => send("room.pause")}>暫停課堂</button> : null}
    {room.status === "paused" ? <button type="button" onClick={() => send("room.resume")}>繼續課堂</button> : null}
    {room.status !== "closed" ? <button type="button" onClick={() => send("room.close")}>關閉課堂</button> : null}
    {currentAgent.run && ["queued", "running", "streaming"].includes(currentAgent.run.state) ? <button type="button" onClick={() => gateway.cancelAgent(room.roomId, currentAgent.run!.agentRunId)}>取消 Nova 回應</button> : null}
  </section>;
}
```

Room creation sends `{ topic: "生態系統探究" }` without a duration field. Parse the generated `CreateRoomResponse` without redefining it: its nested `room` supplies `roomId`, `roomCode`, `status: "scheduled"`, `durationSeconds: 2700` and the generated Nova configuration fields, while `seatInvites` supplies four generated `{ roomMemberId, actorId, pseudonym, code }` entries. Never flatten the nested response into top-level shortcuts or synthesize `closesAt`. `RoomAccessCodes` exists only in the in-memory success result, offers keyboard-operable copy/print, and is not logged or rehydrated after dismissal. Only a generated `room.open` acknowledgment/event may add `startsAt` and `closesAt`.

Lifecycle controls show a pending indicator immediately but do not change `room.status`, active run state, `startsAt` or `closesAt` until the generated server acknowledgment/event is applied. The only statuses are `scheduled | open | paused | closed`; pause never recomputes or extends `closesAt`. A closed room disables student composition but keeps authorized teacher read, export and delete controls. `room.open`, `room.pause`, `room.resume` and `room.close` remain generated Plan 01 RoomCommands. Nova enable/disable must not be added to that union or sent as a literal command: `AgentPolicyControls` binds only the exact generated Plan 04 REST route helpers after they exist in `packages/contracts/src/routes.ts`, and Gate 5 stops at the prerequisite check if they are absent. Cancellation already uses `routes.agent.cancel(roomId, runId)` and updates only after its server response.

```tsx
export function DeleteSessionDialog({ roomId, gateway }: DeleteSessionDialogProps) {
  const [confirmation, setConfirmation] = useState("");
  const expected = `DELETE ${roomId}`;
  const deletion = useDeletionSaga({ roomId, gateway });
  return <dialog aria-labelledby="delete-session-title" open>
    <h2 id="delete-session-title">刪除課堂記錄</h2>
    <p>提交後會建立非同步刪除工作；只有收到無內容刪除收據才算完成。</p>
    <label htmlFor="delete-confirmation">輸入 {expected}</label>
    <input id="delete-confirmation" name="deleteConfirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" />
    <button type="button" disabled={confirmation !== expected || deletion.busy} onClick={() => deletion.request(confirmation)}>確認刪除</button>
    <p role={deletion.status === "dead" ? "alert" : "status"} aria-label="刪除狀態" aria-live="polite">{deletion.copy}</p>
  </dialog>;
}
```

The review queue shows generated review targets, algorithm warning codes, `analysisEpoch`, `projectionVersion` and numeric `completeThroughRoomSeq`. Import `DerivedTextArtifactPage` from `packages/contracts/src/generated/derived-text-artifact-page.v1.ts` (through the documented `src/index.ts` re-export when present). Fetch teacher-only artifact targets only with `routes.analytics.artifacts(roomId, { reviewStatus, afterArtifactId, includeHistory: false, limit })`, which builds `GET /v1/rooms/:roomId/analytics/artifacts`; never declare a local page type or concatenate this URL. A separately labelled audit-history control may set `includeHistory: true`, but the ordinary queue never does. Preserve the server’s stable `(created_at, artifact_id)` cursor order, use the default page size 50, never request more than 100, and append only after a generated page validates. This page contains `DerivedTextArtifact` review targets only; concept-edge targets remain in `echo.teacher_shadow`.

`CorrectionForm` is a discriminated generated `AnalyticsReviewCommand` editor, not a local wire model. The review variant contains only `targetType`, UUID `targetId`, `decision`, `rationale`, UUID `expectedAnalysisEpoch` and `expectedProjectionVersion`. The seven correction branches use their exact generated targets: `replace_text` uses `targetArtifactId`; evidence-span and relationship corrections use `targetProjectionEdgeId`; alias merge/split use `targetCanonicalNodeId`; undo uses `targetCorrectionEventId`; retract uses `targetType + targetId`. Each branch renders only its generated typed `target`/`replacement` fields plus `reason`, `expectedAnalysisEpoch` and `expectedProjectionVersion`, and tests reject mixed-branch fields. For a concept relationship correction, require selection of a provenance-bearing UUIDv5 edge from `echo.teacher_shadow` and submit `correctionKind: "replace_relation"`; do not substitute a source artifact ID for that edge target.

Both variants POST through `gateway.submitAnalyticsReview(roomId, input)` and the single `routes.analytics.reviews(roomId)` endpoint. Parse the first `201` or idempotent retry `200` body as a generated `RoomEventEnvelope`, require `type` to be `analytics.review.recorded.v1` or `analytics.correction.recorded.v1` as appropriate, require its payload to be exactly the content-free generated `{changeKind}` notice, and accept only the server-derived deterministic review `causationId`; do not equate it with a source evidence event. The command's rationale, replacement and target/evidence IDs must not reappear in EventLedger, WebSocket inspection, DOM or logs. Applying the returned notice through the normal ledger path deduplicates retries. The immediate UI copy is only “審閱已記錄，等待分析重建／投影更新”; it must not predict an analysis epoch or future projection version. Concept evidence and `DerivedTextArtifact` fidelity corrections share this endpoint and neither is a RoomCommand.

`ExportControls` passes the selected `json | csv` format to `routes.rooms.export(roomId, format)` through the injected gateway; it never appends `?format=` in a component or gateway. `FetchSessionGateway` parses the server `Content-Disposition` using a strict attachment/UTF-8 filename parser, strips path/control characters, requires a bounded safe basename, and falls back to `learning-orbit-room-export.json|csv`; it returns local `{blob,fileName}` rather than discarding response headers. The component creates one object URL, clicks a transient download anchor with that filename, revokes the URL in `finally`, uses `cache:"no-store"`, and logs neither bytes nor filename/content. On teacher-route initialization, `useDeletionSaga` first calls teacher-only `routes.deletions.forRoom(roomId)` through `getRoomDeletion(roomId)`; an existing generated accepted/status result resumes polling and prevents another DELETE. A fresh request sends generated `DeleteRoomRequest { confirmation: "DELETE ${roomId}" }` once through `routes.rooms.delete(roomId)`, parses `202 DeleteRoomAccepted`, then polls only `routes.deletions.get(deletionJobId)` into generated `DeletionStatus`. Queued, running and retryable states keep duplicate submission disabled; retryable copy says the server will continue retrying. A dead job shows a recoverable escalation message. Only the completed branch’s content-free `DeletionReceipt` changes copy to “刪除收據已確認”; no earlier state says the room or data is deleted, and receipt UI never contains classroom content.

Plan 05 verifies export and deletion role gates, component states, exact generated route calls and saga transitions against injected ports. The actual export bytes and deletion service lifecycle depend on Plan 06 Task 4 and are accepted only at Gate 6; Gate 5 must not claim that real server data was exported or deleted.

- [ ] **Step 4: Run teacher console tests**

Run: `pnpm --filter @learning-orbit/web test -- src/teacher/TeacherConsole.test.tsx`

Expected: route-layer role guard, exact review/correction generated-union fields, recorded-event type/causation, correction rejection, non-enumerating magic-link copy, scheduled create shape, post-open timing, lifecycle acknowledgments, sanitized export filename/ObjectURL cleanup, queued/running/retryable/dead/completed deletion UI, content-free reload recovery without `RoomDetails`, receipt-only completion, typed confirmation, server failure and focus return tests pass.

- [ ] **Step 5: Commit teacher console**

```bash
git add -- apps/web/app/teacher 'apps/web/app/session/[roomId]/teacher' apps/web/src/teacher
git commit -m "feat(web): add audited teacher review console"
```

### Task 17: Enforce the student pseudonym and group-only interpretation view

**Files:**
- Create: `learning-orbit/apps/web/src/student/PseudonymRoster.tsx`
- Create: `learning-orbit/apps/web/src/student/PseudonymRoster.test.tsx`
- Create: `learning-orbit/apps/web/src/student/GroupMetricDisclosure.tsx`
- Create: `learning-orbit/apps/web/src/student/StudentPrivacyNotice.tsx`

- [ ] **Step 1: Write failing pseudonym and no-ranking tests**

```tsx
import { ACTOR_A, NOVA_ACTOR_ID } from "../testing/contract-fixtures";
import { TRACE_STUDENT_INTERPRETATION_ZH_HANT } from "@learning-orbit/contracts";

it("shows pseudonyms without stable participant identifiers or personal ranking", () => {
  render(<PseudonymRoster participants={[{ actorId: ACTOR_A, pseudonym: "探索者 A", actorKind: "human" }, { actorId: NOVA_ACTOR_ID, pseudonym: "Nova Agent", actorKind: "agent" }]} />);
  expect(screen.getByText("探索者 A")).toBeVisible();
  expect(screen.getByText("Nova Agent")).toBeVisible();
  expect(document.body.textContent).not.toContain(ACTOR_A);
  expect(screen.queryByText(/排名|第 1 名|能力分/)).not.toBeInTheDocument();
});

it("repeats the complete canonical SNA claim ceiling beside metrics", () => {
  render(<GroupMetricDisclosure interpretation={TRACE_STUDENT_INTERPRETATION_ZH_HANT} metrics={safeGroupMetrics} />);
  expect(screen.getByText(TRACE_STUDENT_INTERPRETATION_ZH_HANT)).toBeVisible();
  for (const phrase of ["系統觀測到的近期互動事件", "友情", "地位", "能力", "貢獻價值", "學習成績", "心理關係", "Agent 因果效果"]) {
    expect(screen.getByText(TRACE_STUDENT_INTERPRETATION_ZH_HANT)).toHaveTextContent(phrase);
  }
});
```

- [ ] **Step 2: Run and verify missing student components**

Run: `pnpm --filter @learning-orbit/web test -- src/student/PseudonymRoster.test.tsx`

Expected: FAIL because `PseudonymRoster` is absent.

- [ ] **Step 3: Render only server-approved display fields**

```tsx
export function PseudonymRoster({ participants }: { participants: readonly ParticipantView[] }) {
  return <nav aria-label="課堂參與者"><ul>{participants.map((participant) => <li key={participant.actorId}><span aria-hidden="true">{participant.pseudonym.slice(0, 1)}</span><span>{participant.pseudonym}</span>{participant.actorKind === "agent" ? <span>Agent</span> : null}</li>)}</ul></nav>;
}
```

`SnaPanel`, the semantic `SnaList`, `StudentPrivacyNotice` and every `GroupMetricDisclosure` render the generated student bundle's `payload.interpretation` and require it to equal the exported `TRACE_STUDENT_INTERPRETATION_ZH_HANT` constant: “此圖呈現系統觀測到的近期互動事件，不等同友情、地位、能力、貢獻價值、學習成績、心理關係或 Agent 因果效果。” They do not shorten, paraphrase or hide it behind color/tooltips. Do not put participant IDs, email, legal name, raw authorization claims or individual centrality in DOM attributes, URLs or downloadable student output.

- [ ] **Step 4: Run privacy-facing component tests**

Run: `pnpm --filter @learning-orbit/web test -- src/student/PseudonymRoster.test.tsx`

Expected: pseudonym, Agent distinction, long-name wrapping, no-ID/no-ranking and exact full-claim-ceiling assertions pass.

- [ ] **Step 5: Commit the student view**

```bash
git add apps/web/src/student
git commit -m "feat(web): enforce pseudonym group-only student view"
```

### Task 18: Add accessibility, reduced-motion and five-viewport Playwright coverage

**Files:**
- Modify: `learning-orbit/apps/web/package.json`
- Verify unchanged: `learning-orbit/pnpm-lock.yaml`
- Modify: `learning-orbit/scripts/assert-root-scripts.mjs`
- Create: `learning-orbit/apps/web/playwright.config.ts`
- Create: `learning-orbit/apps/web/e2e/viewports.spec.ts`
- Create: `learning-orbit/apps/web/e2e/accessibility.spec.ts`
- Create: `learning-orbit/apps/web/e2e/network-policy.spec.ts`
- Create: `learning-orbit/apps/web/e2e/private-storage-integration.spec.ts`
- Create: `learning-orbit/apps/web/e2e/support/signed-media-grant-tracker.ts`
- Create: `learning-orbit/apps/web/e2e/layout-stability.spec.ts`
- Create: `learning-orbit/apps/web/src/styles/visual-tokens.test.ts`
- Create: `learning-orbit/apps/web/src/testing/style-audit.ts`
- Modify: `learning-orbit/apps/web/app/globals.css`
- Modify: all `learning-orbit/apps/web/src/**/*.module.css` files listed in the file map

- [ ] **Step 1: Write failing viewport, motion, axe and network tests**

```ts
// apps/web/e2e/viewports.spec.ts
import { TRACE_STUDENT_INTERPRETATION_ZH_HANT } from "@learning-orbit/contracts";

const viewports = [
  { name: "phone-320", width: 320, height: 568 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "laptop-1024", width: 1024, height: 768 },
  { name: "desktop-1440", width: 1440, height: 900 },
] as const;

for (const viewport of viewports) {
  test(`${viewport.name} keeps all three regions reachable`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openSeededStudentSession(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.getByRole("complementary", { name: "SNA 限制聲明" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "SNA 限制聲明" })).toContainText(TRACE_STUDENT_INTERPRETATION_ZH_HANT);
    const boxes = await Promise.all(["共學對話", "概念圖 · 論證軌跡", "互動網絡 · SNA"].map(async (name) => (await page.getByRole("region", { name }).boundingBox())!));
    const [chat, concept, sna] = boxes;
    if (viewport.width >= 1120) {
      expect(Math.abs(chat.width - concept.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(concept.height - sna.height)).toBeLessThanOrEqual(1);
      expect(chat.x).toBeLessThan(concept.x);
      expect(Math.abs(concept.x - sna.x)).toBeLessThanOrEqual(1);
      expect(concept.y).toBeLessThan(sna.y);
    } else if (viewport.width >= 768) {
      expect(chat.y).toBeLessThan(concept.y);
      expect(Math.abs(concept.y - sna.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(concept.width - sna.width)).toBeLessThanOrEqual(1);
      expect(chat.width).toBeGreaterThan(concept.width);
    } else {
      expect(chat.y).toBeLessThan(concept.y);
      expect(concept.y).toBeLessThan(sna.y);
      expect(Math.max(chat.x, concept.x, sna.x) - Math.min(chat.x, concept.x, sna.x)).toBeLessThanOrEqual(1);
    }
  });
}

test("[LO-HTML-08] keeps mobile SNA view tabs within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openSeededStudentSession(page);
  const tabs = await page.getByRole("group", { name: "SNA 分析視圖" }).boundingBox();
  expect(tabs!.x + tabs!.width).toBeLessThanOrEqual(320);
});

test("[LO-HTML-09] preserves 44 pixel targets and mobile list defaults", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSeededStudentSession(page);
  await expect(page.getByRole("button", { name: "概念清單" })).toHaveAttribute("aria-pressed", "true");
  for (const box of await page.locator("button,[role=button]").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()))) expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
});

test("[LO-HTML-15] keeps the SNA limitation reachable in fixed-height layouts", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededStudentSession(page);
  const panel = page.getByRole("region", { name: "互動網絡 · SNA" });
  await panel.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect(page.getByRole("complementary", { name: "SNA 限制聲明" })).toBeInViewport();
  await expect(page.getByRole("complementary", { name: "SNA 限制聲明" })).toContainText(TRACE_STUDENT_INTERPRETATION_ZH_HANT);
});
```

```ts
// apps/web/e2e/network-policy.spec.ts
test("[LO-HTML-02] allows only approved app API WebSocket and signed media transfer boundaries", async ({ page, baseURL }) => {
  const tracker = installSignedMediaGrantTracker(page, {
    appOrigin: new URL(baseURL!).origin,
    apiOrigin: process.env.E2E_API_ORIGIN!, wsOrigin: process.env.E2E_WS_ORIGIN!,
    privateStorageOrigin: process.env.E2E_PRIVATE_STORAGE_ORIGIN!,
  });
  await openSeededStudentSession(page);
  await uploadFixtureThroughServerIssuedGrant(page, "ecosystem-observation.png");
  await page.getByRole("button", { name: "查看池塘食物網觀察" }).click();
  await expect(page.getByRole("img", { name: "池塘食物網觀察" })).toBeVisible();
  expect(tracker.violations()).toEqual([]);
  expect(tracker.storageTransfers()).toEqual([
    expect.objectContaining({ method: "PUT", grantSource: "media.upload", issuedBeforeRequest: true }),
    expect.objectContaining({ method: "GET", grantSource: "media.download", issuedBeforeRequest: true, userActivatedBeforeRequest: true }),
  ]);
  expect(tracker.storageTransfers().some(({ kind }) => kind === "list" || kind === "anonymous" || kind === "static_asset")).toBe(false);
});
```

```ts
// apps/web/e2e/accessibility.spec.ts
test("[LO-HTML-18] passes accessibility reduced-motion and breakpoint checks", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openSeededStudentSession(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "播放事件時間軸" }).click();
  await page.waitForTimeout(900);
  await expect(page.getByText("事件 0 / 7")).toBeVisible();
  await expect(page.getByRole("button", { name: "下一事件" })).toBeVisible();
});
```

```ts
// apps/web/e2e/layout-stability.spec.ts
test("keeps async classroom surfaces below the CLS engineering threshold", async ({ page }) => {
  await page.addInitScript(() => {
    const metricWindow = window as typeof window & { __learningOrbitCls: number };
    metricWindow.__learningOrbitCls = 0;
    new PerformanceObserver((entries) => {
      for (const entry of entries.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
        if (!shift.hadRecentInput) metricWindow.__learningOrbitCls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  const release = await holdSeededResponses(page, ["media", "agent-current", "echo-latest", "trace-latest"]);
  await openSeededStudentSession(page);
  await expect(page.locator('[data-async-slot="attachment"]')).toHaveAttribute("aria-busy", "true");
  await expect(page.locator('[data-async-slot="agent-status"]')).toHaveAttribute("aria-busy", "true");
  await expect(page.locator('[data-async-slot="concept"]')).toHaveAttribute("aria-busy", "true");
  await expect(page.locator('[data-async-slot="sna"]')).toHaveAttribute("aria-busy", "true");
  await release();
  await page.waitForLoadState("networkidle");
  const cls = await page.evaluate(() => (window as typeof window & { __learningOrbitCls: number }).__learningOrbitCls);
  expect(cls).toBeLessThan(0.1);
});
```

```ts
// apps/web/src/styles/visual-tokens.test.ts
import { allComponentStyles, approvedTextContrastPairs, componentStyleFiles, contrastRatio } from "../testing/style-audit";

it("freezes approved tokens and prevents raw hex values in components", () => {
  const globals = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  for (const value of ["#1F7A3B", "#58CC02", "#0B6E99", "#F4B942", "#E95D64", "#F7FBF4", "#173A2A"]) expect(globals).toContain(value);
  for (const value of ["--motion-fast: 180ms", "--motion-standard: 240ms"]) expect(globals).toContain(value);
  for (const file of componentStyleFiles()) expect(readFileSync(file, "utf8")).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  expect(allComponentStyles()).not.toMatch(/(?:^|[;{])\s*color\s*:\s*var\(--lime-500\)/m);
  expect(allComponentStyles()).not.toMatch(/(?:transition-property|transition)\s*:[^;]*(?:width|height|grid-template)/i);
  expect(allComponentStyles()).not.toMatch(/(?:animation|transition)(?:-duration)?\s*:[^;]*\b(?!180|240)[1-9]\d*ms/i);
});

it.each(approvedTextContrastPairs)("keeps %s text at WCAG AA contrast", (_name, foreground, background) => {
  expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
});
```

`style-audit.ts` recursively enumerates only `apps/web/src/**/*.module.css`, reads them in stable path order, converts six-digit hex to relative luminance, and exports these exact text pairs: ink/surface (`#173A2A` on `#F7FBF4`), green/surface (`#1F7A3B` on `#F7FBF4`) and blue/surface (`#0B6E99` on `#F7FBF4`). Amber, coral and lime remain non-text semantic/decorative tokens unless a separately tested AA pair is added.

- [ ] **Step 2: Run Playwright and verify red assertions**

Run: `pnpm --filter @learning-orbit/web test -- src/styles/visual-tokens.test.ts && RUN_PRIVATE_STORAGE_E2E=1 pnpm --filter @learning-orbit/web test:e2e -- e2e/viewports.spec.ts e2e/accessibility.spec.ts e2e/network-policy.spec.ts e2e/private-storage-integration.spec.ts e2e/layout-stability.spec.ts`

Expected: FAIL on missing responsive layout, reduced-motion manual stepping, network allowlist, real MinIO CORS/Blob playback, token enforcement, reserved async surfaces, CLS instrumentation and accessibility details. The private-storage test must fail—not skip—when its explicit gate flag is set but MinIO/server configuration is absent.

- [ ] **Step 3: Implement the verified visual/accessibility contract**

Add exactly `"test:e2e": "playwright test"` to `apps/web/package.json`; do not install or repin Playwright. Extend the package-manifest assertion to require that exact web script, and verify the existing lock and Chromium revision before the first call. A missing or different script fails the task instead of being silently replaced by `pnpm exec`.

```css
/* apps/web/app/globals.css */
:root {
  --target-min: 44px; --graph-hit-target: 44px;
  --green-700: #1F7A3B; --lime-500: #58CC02; --blue-700: #0B6E99;
  --amber-500: #F4B942; --coral-500: #E95D64; --surface: #F7FBF4; --ink: #173A2A;
  --space-1: 8px; --radius-card: 18px; --radius-panel: 24px;
  --shadow-low: 0 4px 14px rgb(23 58 42 / 10%);
  --font-rounded: ui-rounded, "SF Pro Rounded", "Heiti TC", "PingFang TC", system-ui, sans-serif;
  --motion-fast: 180ms; --motion-standard: 240ms; --ease-standard: cubic-bezier(0.2, 0, 0, 1);
  color-scheme: light;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; min-width: 0; overflow-x: hidden; color: var(--ink); background: var(--surface); font: 400 16px/1.5 var(--font-rounded); }
button, input, textarea { font: inherit; }
button, [role="button"] { min-height: var(--target-min); touch-action: manipulation; }
:focus-visible { outline: 3px solid var(--blue-700); outline-offset: 3px; box-shadow: 0 0 0 5px var(--amber-500); }
[data-async-slot="attachment"] { min-block-size: 120px; }
[data-async-slot="agent-status"] { min-block-size: 52px; }
[data-async-slot="concept"], [data-async-slot="sna"] { min-block-size: 360px; }
@media (prefers-reduced-motion: reduce) { :root { --motion-fast: 0ms; --motion-standard: 0ms; } html { scroll-behavior: auto; } *, *::before, *::after { animation-duration: 0ms !important; animation-iteration-count: 1 !important; transition-duration: 0ms !important; } }
```

```css
/* apps/web/src/shell/AppShell.module.css */
.appShell { min-block-size: 100dvh; display: grid; grid-template-rows: auto minmax(0, 1fr); }
.workspace { display: grid; gap: calc(var(--space-1) * 2); min-width: 0; min-block-size: 0; }
.chatRegion { grid-area: chat; }
.conceptRegion { grid-area: concept; }
.snaRegion { grid-area: sna; }
@media (min-width: 1120px) {
  .appShell { block-size: 100dvh; min-block-size: 0; overflow: hidden; }
  .workspace { block-size: 100%; grid-template: "chat concept" minmax(0, 1fr) "chat sna" minmax(0, 1fr) / minmax(0, 1fr) minmax(0, 1fr); }
  .chatRegion, .conceptRegion, .snaRegion { min-block-size: 0; overflow: auto; }
}
@media (min-width: 768px) and (max-width: 1119px) {
  .appShell { block-size: auto; min-block-size: 100dvh; overflow: visible; }
  .workspace { block-size: auto; grid-template: "chat chat" auto "concept sna" minmax(0, 1fr) / minmax(0, 1fr) minmax(0, 1fr); }
}
@media (max-width: 767px) {
  .appShell { display: block; block-size: auto; min-block-size: 100dvh; overflow: visible; }
  .workspace { block-size: auto; grid-template-areas: "chat" "concept" "sna"; grid-template-columns: minmax(0, 1fr); }
}
```

Use only the seven root color tokens in component CSS; no component contains a raw hex literal. `#58CC02` is restricted to progress, borders, focus-independent strokes and decoration, and never carries small white text. Body text stays at least 16px/1.5; spacing follows the 8px rhythm, card/panel radii stay 18–24px, and shadows use the low token. Token tests calculate all approved foreground/background text pairs and require at least 4.5:1; they separately require the 3px dark-blue focus perimeter to contrast at least 3:1 against every adjacent approved surface, with amber only as a secondary halo. Micro-interactions use only 180ms or 240ms tokens (never above 260ms), apply only to newly inserted or changed opacity/transform/stroke states, and never animate width, height, grid tracks or other layout geometry; reduced motion resolves both duration tokens to zero.

At 1120px and above, `.appShell` supplies a definite remaining viewport track after its intrinsic header and `.workspace` fills that track, making its two right-hand `1fr` rows exactly computable; chat spans the left of two exact `minmax(0, 1fr)` columns. At 768–1119px, chat spans both columns, with concept and SNA as equal one-fraction columns on the next row. Below 768px, the definite desktop block size is explicitly released; order is chat, concept, SNA in one naturally scrolling column. Use three equal-width SNA scope buttons, mobile list defaults when the URL is silent, and a full-width send button. At `max-width: 390px`, allow brand, segmented labels, metrics and pseudonyms to wrap. Keep the SNA panel scrollable and its limitation reachable. The 1440×900 test requires left/right width difference and right upper/lower height difference no greater than 1px; all five viewport tests assert order and column structure. The skip link must focus `#workspace`; sticky headers must use `scroll-margin-top` on focusable descendants.

Chat attachments, Agent status, concept and SNA panels always render the reserved `data-async-slot` container before their request begins. While pending they set `aria-busy="true"` and render a dimension-matched skeleton plus concise visually hidden status; success/error/empty states replace only the contents of that slot. They never replace the whole workspace or collapse its block size. `layout-stability.spec.ts` delays all four responses in one synthetic student journey and records cumulative layout shift below `0.1`; this is an engineering regression threshold, not an SLA. Concept and SNA retain the list fallback while SVG measurement or projection data is pending.

`signed-media-grant-tracker.ts` records server responses that issue short-lived upload/download URLs before recording storage requests. The network test allows same-origin documents/assets and the configured API HTTP/WebSocket origins. At the configured private-storage origin it allows only a server-issued short-signed `PUT`, or a server-issued short-signed `GET` whose view/play control was activated first; it records grant source, issuance time, activation time and request time. Storage list calls, anonymous requests, background/static-asset loads, ungranted URLs, wrong methods and every other origin fail. `private-storage-integration.spec.ts` uses the locked real MinIO service and real browser Origin to upload an image/audio fixture via signed PUT, complete processing, click view/play, fetch the signed GET under CORS into a Blob URL, render/play from that local URL, revoke it, and prove anonymous GET/list and a foreign Origin fail. This resolves the Plan 02/05 trust boundary with browser evidence rather than a mocked fetch.

- [ ] **Step 4: Run all five viewports and accessibility checks**

Run: `pnpm --filter @learning-orbit/web test -- src/styles/visual-tokens.test.ts && RUN_PRIVATE_STORAGE_E2E=1 pnpm --filter @learning-orbit/web test:e2e -- e2e/viewports.spec.ts e2e/accessibility.spec.ts e2e/network-policy.spec.ts e2e/private-storage-integration.spec.ts e2e/layout-stability.spec.ts`

Expected: token/contrast/motion assertions pass; all five viewports pass their exact single/two-column geometry with no horizontal overflow; axe reports zero serious/critical violations; reduced motion requires manual timeline advancement; the network tracker proves signed-grant causation and user activation with no unauthorized origin/method; the delayed four-surface journey records CLS below `0.1` while SVG/list fallbacks remain reachable.

- [ ] **Step 5: Commit responsive and accessibility behavior**

```bash
git add apps/web/package.json apps/web/app/globals.css apps/web/src apps/web/e2e apps/web/playwright.config.ts scripts/assert-root-scripts.mjs
git commit -m "test(web): verify responsive accessible classroom UI"
```

### Task 19: Run integrated pilot journeys and close Gate 5

**Files:**
- Create: `learning-orbit/apps/web/e2e/student-journey.spec.ts`
- Create: `learning-orbit/apps/web/e2e/teacher-journey.spec.ts`
- Create: `learning-orbit/apps/web/e2e/projection-parity.spec.ts`
- Modify: `learning-orbit/apps/web/src/testing/legacy-contract-migration.test.ts`
- Modify: `learning-orbit/package.json`

- [ ] **Step 1: Write failing cross-feature acceptance journeys**

```ts
// apps/web/e2e/projection-parity.spec.ts
import { EVENT_001, MESSAGE_001, displayEventLabel } from "../src/testing/contract-fixtures";

test("media in reply preserves provenance through server acknowledgment", async ({ page }) => {
  await openSeededStudentSession(page);
  await page.getByRole("button", { name: `回覆探索者 A 的${displayEventLabel(EVENT_001)}` }).click();
  await attachFixtureImage(page, "ecosystem-observation.png", "池塘食物網觀察");
  await page.getByRole("button", { name: "加入對話" }).click();
  await expect(page.getByText(`回覆 ${displayEventLabel(EVENT_001)} · 探索者 A`)).toBeVisible();
  await expect(page.locator(`[data-message-id="${MESSAGE_001}"]`)).toHaveCount(1);
  await expect(page.getByRole("status", { name: "同步狀態" })).toHaveText("已同步至房間序號 128（聊天投影 41、概念投影 12、SNA 投影 9）");
});

test("timeline graph and list expose identical edge IDs", async ({ page }) => {
  await openSeededStudentSession(page);
  await page.getByRole("button", { name: "重設時間軸" }).click();
  await page.getByRole("button", { name: "下一事件" }).click();
  const graphIds = await page.locator("[data-concept-edge-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-concept-edge-id")).sort());
  await page.getByRole("button", { name: "概念清單" }).click();
  const listIds = await page.locator("[data-concept-row-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-concept-row-id")).sort());
  expect(listIds).toEqual(graphIds);
});

test("SNA view switching never resets runtime metrics", async ({ page }) => {
  await openSeededStudentSession(page);
  await sendEvidenceMessage(page);
  const observed = await readMetricValues(page);
  await page.getByRole("button", { name: "只看同學" }).click();
  await page.getByRole("button", { name: "來源歸因" }).click();
  await page.getByRole("button", { name: "全體互動" }).click();
  expect(await readMetricValues(page)).toEqual(observed);
});

test("SNA switches server windows and presentation pause without touching chat or concept", async ({ page }) => {
  await openSeededStudentSession(page);
  const chatBefore = await page.getByTestId("chat-version").textContent();
  const conceptBefore = await page.getByTestId("concept-version").textContent();
  await expect(page.getByText(/時間窗口：/)).toContainText("09:08");
  await page.getByRole("button", { name: "整場 45 分鐘" }).click();
  await expect(page.getByText(/時間窗口：/)).toContainText("09:00");
  await page.getByRole("button", { name: "暫停 SNA 更新" }).click();
  await injectValidatedSnaBundle(page, 10);
  await injectValidatedSnaBundle(page, 11);
  await expect(page.getByRole("status", { name: "SNA 更新狀態" })).toContainText("有 2 次已驗證更新待顯示");
  await expect(page.getByTestId("sna-version")).toHaveText("9");
  await page.getByRole("button", { name: "繼續 SNA 更新" }).click();
  await expect(page.getByTestId("sna-version")).toHaveText("11");
  await expect(page.getByTestId("chat-version")).toHaveText(chatBefore!);
  await expect(page.getByTestId("concept-version")).toHaveText(conceptBefore!);
});

for (const viewport of [{ name: "mobile", width: 390, height: 844 }, { name: "desktop", width: 1440, height: 900 }] as const) {
  test(`reciprocal edges remain separated in final screen pixels on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openSeededStudentSession(page);
    const [forward, reverse] = await page.locator('[data-reciprocal-pair="explorer-a-explorer-b"]').evaluateAll((nodes) => nodes.map((node) => {
      const path = node as SVGPathElement;
      const length = path.getTotalLength();
      const matrix = path.getScreenCTM()!;
      const at = (offset: number) => {
        const point = path.getPointAtLength(offset);
        const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
        return { x: screen.x, y: screen.y };
      };
      const atScreenDistance = (fromEnd: boolean, pixels: number) => {
        const endpoint = at(fromEnd ? length : 0);
        let low = 0;
        let high = length;
        for (let index = 0; index < 24; index += 1) {
          const traveled = (low + high) / 2;
          const sample = at(fromEnd ? length - traveled : traveled);
          const screenDistance = Math.hypot(sample.x - endpoint.x, sample.y - endpoint.y);
          if (screenDistance < pixels) low = traveled; else high = traveled;
        }
        return at(fromEnd ? length - high : high);
      };
      return {
        d: path.getAttribute("d"), marker: path.getAttribute("marker-end"),
        sourcePortId: path.dataset.sourcePortId, targetPortId: path.dataset.targetPortId,
        sourcePort: at(0), sourceFan: atScreenDistance(false, 12),
        quarter: at(length * 0.25), midpoint: at(length * 0.5), threeQuarter: at(length * 0.75),
        targetFan: atScreenDistance(true, 12), targetPort: at(length),
      };
    }));
    const separation = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    expect(separation(forward.sourcePort, reverse.targetPort)).toBeGreaterThanOrEqual(8);
    expect(separation(forward.sourceFan, reverse.targetFan)).toBeGreaterThanOrEqual(8);
    expect(separation(forward.targetFan, reverse.sourceFan)).toBeGreaterThanOrEqual(8);
    expect(separation(forward.targetPort, reverse.sourcePort)).toBeGreaterThanOrEqual(8);
    expect(separation(forward.quarter, reverse.threeQuarter)).toBeGreaterThanOrEqual(8);
    expect(separation(forward.midpoint, reverse.midpoint)).toBeGreaterThanOrEqual(8);
    expect(separation(forward.threeQuarter, reverse.quarter)).toBeGreaterThanOrEqual(8);
    expect(forward.d).not.toBe(reverse.d);
    expect(forward.marker).not.toBe(reverse.marker);
    expect(forward.sourcePortId).not.toBe(reverse.targetPortId);
    expect(forward.targetPortId).not.toBe(reverse.sourcePortId);
  });
}
```

- [ ] **Step 2: Run integrated journeys and verify the red state**

Run: `pnpm --filter @learning-orbit/web test:e2e -- e2e/student-journey.spec.ts e2e/teacher-journey.spec.ts e2e/projection-parity.spec.ts`

Expected: FAIL until session wiring, server acknowledgments, teacher actions and the shared projection selectors are connected end to end.

- [ ] **Step 3: Wire the final workspace and enforce proof-file presence**

```tsx
// apps/web/app/session/[roomId]/SessionWorkspace.tsx
"use client";
export function SessionWorkspace({ bootstrap, gateway }: SessionWorkspaceProps) {
  const runtime = useMemo(() => createSessionRuntime(bootstrap, gateway), [bootstrap, gateway]);
  const state = useSessionStore(runtime.store);
  const preferences = useViewPreferences();
  useEffect(() => { runtime.connect(); return () => runtime.close(); }, [runtime]);
  return <AppShell session={state.session} connectionStatus={state.connectionStatus}>
    <ChatPanel ledger={state.ledger} session={state.session} commandBus={runtime.commandBus} mediaGateway={gateway} />
    <PolicyAwareAnalysisSlot kind="concept" availability={state.projectionAvailability.concept} onRetry={runtime.projections.reconcileApproved}>
      {state.concept ? <ConceptPanel state={state.concept} preferences={preferences} /> : null}
    </PolicyAwareAnalysisSlot>
    <PolicyAwareAnalysisSlot kind="sna" availability={state.projectionAvailability.sna} onRetry={runtime.projections.reconcileApproved}>
      {state.sna ? <SnaPanel controller={runtime.snaPresentation} liveState={state.sna} preferences={preferences} /> : null}
    </PolicyAwareAnalysisSlot>
    <span role="status" aria-label="同步狀態" aria-live="polite">{state.projectionStatusText}</span>
  </AppShell>;
}
```

`PolicyAwareAnalysisSlot` reserves panel geometry for loading/error states, but `not_available_by_policy` renders only “本次課堂未開放此分析視圖” and a bounded “重新檢查權限” action. It never mounts graph/list components with empty scientific data. Promotion of one key hydrates only that panel; the other remains independently unavailable, and the chat composer/ledger never becomes disabled by analytics policy.

`clearGeneratedProjection` is a destructive in-memory privacy transition scoped to one generated key: it replaces that reducer value with `null`, removes its cursor/history/selected inspector target, calls `SnaLiveController.clear()` for TRACE, and then publishes `not_available_by_policy` in one store transaction. It does not persist the revoked graph in local/session storage or URL state; the URL may retain only the non-sensitive view/window preference. Tests inspect the store and DOM after targeted revocation and prove no old node/edge/provenance text remains reachable.

Extend `legacy-contract-migration.test.ts` to read every registered `proofFile` with `node:fs`, assert that the file exists, and assert that its exact `testName` appears once. Add the root script:

```json
{
  "scripts": {
    "gate:5": "pnpm --filter @learning-orbit/web test && pnpm --filter @learning-orbit/web typecheck && pnpm --filter @learning-orbit/web build && pnpm --filter @learning-orbit/web test:e2e"
  }
}
```

- [ ] **Step 4: Execute Gate 5 from a clean test environment**

Run:

```bash
pnpm gate:5
git diff --check
git status --short
```

Expected:

- Vitest passes, including all 19 `LO-HTML-*` proof names exactly once.
- TypeScript exits `0` with no `any` added to session, concept or SNA code.
- Next.js production build succeeds.
- Playwright passes student `roomCode`/`seatCode` join, server-assigned pseudonym/actor/session hydration, chat/media/reply, Agent policy-held/unavailable presentation, concept timeline parity, SNA two-window/three-view metric consistency and pause/resume, mobile/desktop screen-pixel reciprocal geometry, teacher auth/create/lifecycle/review/correction, five viewports, CLS, network policy and axe checks. Export/deletion receive role/state tests against Plan 06 generated contracts and injected ports only; real service E2E remains Gate 6.
- `git diff --check` prints nothing.
- `git status --short` lists only the intended uncommitted Gate 5 evidence before the final commit, or prints nothing after it.

- [ ] **Step 5: Commit Gate 5 closure**

```bash
git add apps/web package.json pnpm-lock.yaml
git commit -m "feat(web): complete controlled classroom pilot UI"
```

## Gate 5 acceptance

Gate 5 is accepted only when all conditions below are evidenced in the same commit:

- [ ] Plan 01’s existing Next scaffold is extended without overwriting its package/config ownership; `/rooms/:roomId` redirects to the sole `/session/:roomId` UI entry, the exact pinned test dependencies and lockfile are reviewed, and the Playwright Chromium revision launches. A missing browser is a Gate blocker, not a skipped pass.
- [ ] Student join normalizes then sends exactly `{ roomCode, seatCode }` through `routes.rooms.join()` with six- and ten-character generated-code grammar; it sends no pseudonym, role, actor kind or room ID. The join response is exactly `{ roomMemberId, actorId, pseudonym }`, contains no room ID or realtime ticket, and the HttpOnly cookie plus `routes.auth.session()` alone hydrate `role`, `roomId`, server-assigned `探索者 A/B/C/D` and generated `nova`; `RoomDetails.participants + nova` alone forms the roster before navigation.
- [ ] Authorization comes only from the hydrated server session. Query/client changes cannot expose teacher controls; the teacher supervision view has no ordinary composer, permits an author to revise/retract their own message, and permits a teacher to retract—but never revise—another participant’s message.
- [ ] Canonical wire types come only from `packages/contracts/src/generated/`, core payload narrowing from `packages/contracts/src/core-room-event.ts`, REST paths from `packages/contracts/src/routes.ts`, and realtime parsing/encoding from `packages/contracts/src/realtime.ts`. All parser fixtures use valid UUIDs; no duplicate wire/page/route/attachment type exists in `apps/web`.
- [ ] Cookie-auth WebSocket open sends generated `hello { resumeFrom }`; welcome/event/resume_complete and snapshot_required ordering is tested. Event, projection, media-status and agent-status frames route independently; projection/media/Agent frames never enter `EventLedger` or advance room sequence. Missed media status is repaired through authenticated `routes.media.get`; RoomEvent gaps leave the cursor unchanged and trigger generated-route pagination; snapshot URLs, projection snapshot URLs and role allowlists reject hostile origin/room/path/query values.
- [ ] `EventLedger` orders only contiguous numeric `roomSeq`, stores generic envelopes, and calls `parseCoreRoomEvent` before reading message payloads. `ChatMessageView` retains author, reply, mentions, media and safe Agent provenance locally, maps actor IDs through the server roster, and never serializes itself or exposes actor UUIDs in the DOM.
- [ ] Generated message add/revise/retract, replies and mentions re-enter the UI only through canonical events. `message.add.mediaIds` has at most four UUIDs and requires text or media; refresh uses `routes.media.get(roomId, mediaId)` and generated `MediaAttachmentView`; revise cannot replace attachments. Image/audio in a reply preserves `replyTo` until acknowledgment and clears the banner once. Network policy permits private-storage traffic only for causally recorded server-issued signed PUTs and user-activated signed GETs, never list/anonymous/static loads.
- [ ] Projection frames deduplicate by `(projectionKey, analysisEpoch, projectionVersion)` independently of room events. Same-epoch `local + 1` uses `routes.analytics.patches(roomId, projectionKey, {analysisEpoch,afterProjectionVersion})`; epoch change, gap, 409 or baseline mismatch uses only the validated frame latest URL. Reconnect actively reconciles each independently policy-available role key.
- [ ] `ProjectionCoordinator` becomes ready only when chat ledger, concept and SNA have equal numeric `completeThroughRoomSeq`. Their independent chat/concept/SNA projection versions remain distinct and all appear in the exact synchronization copy.
- [ ] Generated `AgentRun.state` remains queued/running/streaming/completed/blocked_by_policy/cancelled/failed. `selectAgentPresentation(runState, serviceHealth)` alone derives idle/thinking/streaming/held/unavailable; `agent_status` and `routes.agent.current(roomId)` update only the Agent reducer, raw provider deltas never parse/render, and Agent disclosure uses only parsed final-message provenance fields. Nova enable/disable binds the exact Plan 04 generated REST helpers and is never invented as a Plan 01 RoomCommand.
- [ ] Concept state consumes generated `ConceptMapPatch`/`ConceptMapSnapshot`, enforces base plus monotonic projection versions and numeric completeness, applies node/edge add/update/hide/positions, and preserves `activityScore`, `evidenceStatus`, `reviewStatus`, `displayStatus`, `channels` and object evidence refs. Timeline reset is a local cursor operation; graph/list edge IDs remain equal at every cursor, including reduced-motion manual stepping.
- [ ] TRACE consumes generated `SnaProjectionBundle` with shared bundle base/projection/completeness fields and exact observed/human_only/lineage_adjusted payload views; repeated switching never resets server metrics. Student bundle/list/inspector contains no evidence IDs, while authorized teacher evidence is label-mapped. Screen-space allocation produces unique ports, fan-outs, paths and arrowheads with at least 8px reciprocal/parallel separation in component matrices and Playwright mobile/desktop viewports; all edges retain a 44px transparent hit stroke.
- [ ] Teacher magic-link request returns identical generic copy without a login URL; browser/server handles the emailed link and 303 cookie session. Room create sends only topic “生態系統探究” and parses nested scheduled 2700-second room plus four one-time seat invites; `startsAt`/`closesAt` appear only after open acknowledgment, pause never extends closing, and scheduled/open/paused/closed student copy is honest.
- [ ] Teacher review queue uses teacher-only `routes.analytics.artifacts(roomId, { reviewStatus, afterArtifactId, includeHistory: false, limit })`, generated `DerivedTextArtifactPage`, stable server cursor order and limit 50/max 100; a distinct audit-history control alone may request `includeHistory: true`. Review/correction forms send only the seven-branch generated union to `routes.analytics.reviews(roomId)`; relationship correction targets a provenance-bearing UUIDv5 projection edge with `replace_relation`. The first 201 and idempotent 200 recorded RoomEvent type/server-derived causation are verified, and UI waits for analysis rebuild without predicting a projection version.
- [ ] Export and deletion components are role-gated and tested only through Plan 06 generated contracts plus injected ports at Gate 5. Export calls `routes.rooms.export(roomId, format)` without query concatenation. Deletion uses generated `DeleteRoomRequest`, accepted/status/receipt types, `routes.deletions.forRoom` recovery and `routes.deletions.get` polling; queued/running/retryable/dead/completed copy never claims completion before a content-free receipt. Real export bytes and server deletion lifecycle E2E remain Gate 6.
- [ ] Student surfaces contain only server pseudonyms and group-level interpretation—no legal names, personal rankings, individual metrics or participant UUIDs. URL preferences preserve concept graph/list, SNA graph/list, SNA scope and `recent_10m|session_45m` across reload, history navigation and viewport changes.
- [ ] Approved seven-color and rounded-font tokens are centralized; body is at least 16px/1.5 on an 8px rhythm, lime never carries small white text, component CSS contains no raw hex, and tested text pairs meet 4.5:1. Micro-interactions use 180ms/240ms (never over 260ms), avoid layout geometry, and reduce to zero. All controls have visible focus, 44px targets and keyboard equivalents; reduced-motion timeline is manual, live updates are polite/atomic, and axe has zero serious/critical violations.
- [ ] Attachment, Agent, concept and SNA async slots reserve dimensions/skeletons and preserve SVG/list fallbacks; the delayed synthetic journey records CLS below `0.1` as an engineering threshold. All five viewports prove the <768 single-column and 768–1119 chat-over-two-column orders; 1440×900 proves equal desktop columns and equal right-hand rows within 1px. All regions and the SNA limitation remain reachable with no horizontal page overflow.
- [ ] All 19 former HTML contract tests have exactly one uniquely named migrated proof; unit, typecheck, production build and the non-skipped Playwright suite all pass in the same Gate 5 commit.

## Non-goals for Plan 05

- Changing the server, generated TypeScript, JSON Schemas, WebSocket envelope format, authentication policy or database schema from the preceding plans.
- Recalibrating ECHO-CM, TRACE-AI, concept activity/evidence/review/display status, SNA metrics or scientific interpretation; the UI renders generated server results and warnings.
- Individual ability scoring, student ranking, automated grading, discipline decisions or teacher replacement.
- Tailwind, Redux, D3, canvas graph rendering, a native mobile app, an offline-first PWA or a second design system.
- Provider deployment, production-domain configuration, organization-wide tenancy, billing, long-term retention policy or a general-availability release; those require a later release gate.
- Treating injected export/deletion port tests as proof of exported bytes or completed server deletion; Plan 06 Task 4 and Gate 6 own those real integration journeys.
- Claiming learning efficacy, algorithm validity or production readiness from successful UI tests alone.
