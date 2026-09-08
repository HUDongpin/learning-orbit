# Template: student visibility promotion record

> **This file is a template. It is not a record, and it is not a promotion.**
> Every value below is a `<<PLACEHOLDER>>` that no schema pattern accepts. A
> completed record is decided and signed **outside this repository**, by someone
> who is not the teacher who ran the shadow.
>
> **本檔案是範本，不是記錄，也不是升級決定。** 完成的記錄必須由「不是執行 shadow
> 的那個人」在 repository 之外決定並簽署。

Kind: `student_visible_promotion` · Payload schema:
`packages/contracts/schemas/student-visible-promotion-record.v1.json` · Payload
checker: `studentVisiblePromotionRecordContract`
(`packages/contracts/src/governance.ts:204-237`)

This is the decision that lets a student see the analytics built from their own
conversation. Default-deny is the resting state: a room with no live promotion
row shows students nothing at all
(`apps/server/src/modules/lifecycle/student-analytics-promotion.ts:156-175`).

---

## 1. Two questions that look like one

"The agent behaved acceptably in a room with one adult in it" and "students may
see the analytics built from their own conversation" are different questions, and
one person answering both at once tends to answer the second by momentum. The
contract enforces the separation two ways:

- `derivedFromShadowRecord: true` → `PROMOTION_INFERRED_FROM_SHADOW`
  (`governance.ts:209`).
- `decidedBy.deciderRef == shadowTeacherRef` → `PROMOTION_DECIDED_BY_SHADOW_TEACHER`
  (`governance.ts:210-212`).

Both only work if the digests are computed the same way across records — see
[the authorization template §3](external-authorization-record.template.md#3-the-salted-digests-and-the-trap-in-them).

---

## 2. The payload

```json
{
  "recordKind": "student_visible_promotion",
  "promotionId": "<<FRESH UUID - VERSION 4, LOWERCASE>>",
  "roomId": "<<UUID OF THE ONE ROOM THIS DECISION COVERS>>",
  "synthetic": false,
  "externalAuthorizationRecordSha256": "<<SHA-256 OF THE SIGNED AUTHORIZATION RECORD FILE>>",
  "authorizedFrom": "<<COPY OF scope.sessionsFrom FROM THAT AUTHORIZATION>>",
  "authorizedUntil": "<<COPY OF scope.sessionsUntil FROM THAT AUTHORIZATION>>",
  "shadowRecordSha256": "<<SHA-256 OF THE SIGNED SHADOW RECORD FILE>>",
  "shadowTeacherRef": "<<SALTED SHA-256 OF THE TEACHER WHO RAN THAT SHADOW>>",
  "shadowVerdict": "<<ONE OF ready_for_students | not_ready>>",
  "derivedFromShadowRecord": false,
  "decidedBy": {
    "deciderRef": "<<SALTED SHA-256 OF THE DECIDER - NOT shadowTeacherRef>>",
    "deciderRole": "<<ONE OF school_authority | research_ethics_board | designated_release_custodian>>",
    "decidedAt": "<<ISO 8601 UTC - NOT AFTER startsAt>>"
  },
  "studentProjectionKeys": ["<<ZERO, ONE OR BOTH OF echo.student_approved | trace.student_bundle>>"],
  "startsAt": "<<ISO 8601 UTC - NOT BEFORE authorizedFrom>>",
  "expiresAt": "<<ISO 8601 UTC - NOT AFTER authorizedUntil>>",
  "revocation": {
    "contactRef": "<<SALTED SHA-256 OF WHOEVER CAN WITHDRAW THIS>>",
    "method": "<<ONE OF signed_revocation_record | operator_revoke_command>>",
    "maxLatencyMinutes": "<<INTEGER 1-1440, NOT LONGER THAN THE WINDOW ITSELF>>"
  },
  "usedForGradesOrDiscipline": false
}
```

The envelope is the same eight keys as every other authority record; see
[the authorization template §1](external-authorization-record.template.md#1-the-envelope).

### Field by field

| Field | What it means, in plain language | Who is entitled to state it | Refused as |
| --- | --- | --- | --- |
| `promotionId` | This decision's own identity. | The decider | Schema-refused unless a UUID |
| `roomId` | The one room this covers. Promotion is a whole-room decision and is never made for a cohort in the abstract. | The decider | Schema-refused unless a UUID |
| `synthetic` | Whether this is a rehearsal of the paperwork. | The decider | `PROMOTION_WAS_SYNTHETIC` when `true` (`governance.ts:207`) |
| `externalAuthorizationRecordSha256` | The digest of the signed authorization this rests on. | The decider, computed over the record file they were handed | Schema-refused unless 64 lowercase hex |
| `authorizedFrom` / `authorizedUntil` | The authorization's window, restated here so this record can be refused on its own. **A restatement is not the record** — the operator still has to compare it against the verified authorization by hand (§4). | The decider, copied from the authorization | `INVALID_STUDENT_VISIBLE_PROMOTION_RECORD` if `until` is not after `from` (`governance.ts:219`) |
| `shadowRecordSha256` | The digest of the signed completed shadow. Named so the two decisions can be **linked**, not so one can be derived from the other. | The decider | Schema-refused unless 64 lowercase hex |
| `shadowTeacherRef` | The teacher who ran that shadow, as a salted digest. | The custodian, to the pilot's one convention | Drives `PROMOTION_DECIDED_BY_SHADOW_TEACHER` (`governance.ts:210-212`) |
| `shadowVerdict` | What that shadow concluded. | The decider, copied from the shadow record | `PROMOTION_CONTRADICTS_SHADOW_VERDICT` if it is `not_ready` and any projection key is granted (`governance.ts:227-229`) |
| `derivedFromShadowRecord` | Whether this promotion was derived from the shadow rather than decided. | The decider | `PROMOTION_INFERRED_FROM_SHADOW` when `true` (`governance.ts:209`) |
| `decidedBy.deciderRef` | Who decided, as a salted digest. | The decider | `PROMOTION_DECIDED_BY_SHADOW_TEACHER` if it equals `shadowTeacherRef` |
| `decidedBy.deciderRole` | In what capacity: school authority, ethics board, or the designated release custodian. | The decider | Schema-refused for any other value |
| `decidedBy.decidedAt` | When. Must not be after visibility starts. | The decider | `PROMOTION_DECISION_OUT_OF_ORDER` (`governance.ts:220`) |
| `studentProjectionKeys` | The projections a student in this room may be shown. **Zero, one or both, named out loud.** An empty list is a decision to stay at chat-only, which is the resting state anyway; an absent list is not a decision at all and the schema refuses it. | The decider | Schema-refused for any key outside the two |
| `startsAt` / `expiresAt` | The window this visibility is open. | The decider | `PROMOTION_SCOPE_EXCEEDS_AUTHORIZATION` if it starts before, or outlasts, the restated authorization window (`governance.ts:224-226`) |
| `revocation.contactRef` | Who can withdraw this before it expires. | The decider | Schema-refused unless 64 lowercase hex |
| `revocation.method` | How: another signed record, or an operator command. See the warning in §5 before choosing. | The decider | Schema-refused for any other value |
| `revocation.maxLatencyMinutes` | How long withdrawal may take, 1–1440. A withdrawal slower than the grant it withdraws is a promise, not a path. | The decider | `PROMOTION_REVOCATION_PATH_INEFFECTIVE` if the latency exceeds the whole `startsAt`→`expiresAt` window (`governance.ts:231-233`) |
| `usedForGradesOrDiscipline` | Whether what the student is shown feeds grades or discipline. | The decider | `PROMOTION_USED_FOR_GRADES_OR_DISCIPLINE` when `true` (`governance.ts:208`) |

---

## 3. What each key actually shows a student

| Key | What a student in that room sees |
| --- | --- |
| `echo.student_approved` | The room's concept map, in the teacher-approved form only. The student patch carries counts and change scores and **no `evidenceRefs`** — the student view cannot point back at who said which span (`apps/server/src/modules/analytics/analytics-repository.ts:69-77`). |
| `trace.student_bundle` | Aggregate interaction shape over two windows — the last 10 minutes and the 45-minute session — in three views (`observed`, `human_only`, `lineage_adjusted`), with a fixed interpretation line stating that the picture is not friendship, status, ability, contribution, grades or agent causality (`packages/contracts/schemas/trace-projection.v1.json`, `$defs.StudentBundle`). |

Neither is a claim about an individual student, and neither may be used as one.
Granting both is a bigger decision than granting either.

---

## 4. What no code checks for you

`externalAuthorizationRecordSha256` and `shadowRecordSha256` are checked for
**shape only**. Nothing in this repository recomputes them or compares them
against the records the release chain verified — grep confirms the fields appear
only in the schema, the generated types and their tests. So a promotion can name
a digest that belongs to no record anyone holds, and every automated check will
still pass.

The operator closes that gap by hand, before importing anything:

```bash
shasum -a 256 /secure/authority/external-authorization.json
shasum -a 256 /secure/authority/human-shadow.json
```

and comparing those two values, and the restated `authorizedFrom`/`authorizedUntil`,
against the records that actually verified. The
[verification walkthrough](../../runbooks/authority-verification.md#4-the-three-links-no-tool-checks)
has the full procedure.

---

## 5. Choosing a revocation method honestly

`maxLatencyMinutes` is a promise about a mechanism that has to exist in the
deployment. In this repository:

- The durable grant and its withdrawal live in
  `StudentAnalyticsPromotionService` — `grant` at
  `apps/server/src/modules/lifecycle/student-analytics-promotion.ts:101` and
  `revoke` at `:134`. Revocation is a tombstone with a higher revision rather
  than a delete, so a late notification can never be mistaken for a fresh grant,
  and the change is announced in the same transaction that makes it.
- **No HTTP route and no CLI in this repository calls either of them.** The
  service is wired for reads only (`apps/server/src/app.ts:247-251`). A pilot
  choosing `operator_revoke_command` must name the concrete mechanism the
  deployment provides, and time it, before writing a number into this field.

Signing a latency the deployment cannot meet is the one failure this record
cannot catch: the contract only checks that the number is smaller than the
window.

Next: [sign it](../../runbooks/authority-signing.md), then
[check it](../../runbooks/authority-verification.md).
