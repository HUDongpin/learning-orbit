# Template: external authorization record

> **This file is a template. It is not a record, and it is not an authorization.**
> Every value below is a `<<PLACEHOLDER>>` that no schema pattern accepts, so this
> file cannot become a record by being copied and signed unchanged. A completed
> record is filled in, canonicalised and signed **outside this repository** by the
> body that took the decision — never by anyone building the system.
>
> **本檔案是範本，不是記錄，也不是授權。** 下列每個值都是佔位符，任何一個都不符合
> schema 的格式，未填的範本會被檢查器拒絕。完成的記錄必須由作出決定的機構在
> repository 之外填寫與簽署。

Kind: `external_authorization` · Payload schema:
`packages/contracts/schemas/external-authorization-record.v1.json` · Payload
checker: `externalAuthorizationRecordContract`
(`packages/contracts/src/governance.ts:91-157`)

This is the decision that admits real students at all. Nothing else in the system
substitutes for it, and it is the record `pnpm verify:pilot` reports as
`NOT HELD: School and research ethics authorization (blocks: Any session with real
students)`.

---

## 1. The envelope

The eight envelope keys are fixed. `parseSignedAuthorityRecord` compares the
sorted key list against an exact list, so one extra or one missing key is
`AUTHORITY_RECORD_INVALID`
(`apps/server/src/modules/authorization/controlled-authority-verifier.ts:169-170`).
Key **order in the file** does not matter; only the canonical signing input is
sorted, and the signing runbook covers that.

```json
{
  "kind": "external_authorization",
  "recordId": "<<FRESH UUID - VERSION 4, LOWERCASE, NEVER REUSED>>",
  "issuer": "<<ISSUER STRING EXACTLY AS IT APPEARS IN THE TRUST SET>>",
  "keyId": "<<KEY ID EXACTLY AS IT APPEARS IN THE TRUST SET>>",
  "signedAt": "<<ISO 8601 UTC INSTANT THIS ENVELOPE WAS SIGNED>>",
  "expiresAt": "<<ISO 8601 UTC INSTANT THIS ENVELOPE STOPS BEING ACCEPTED>>",
  "signature": "<<BASE64URL ED25519 SIGNATURE - 86 CHARACTERS, NO = PADDING>>",
  "payload": { "…": "see section 2" }
}
```

| Envelope field | Plain language | Who states it | Refused as |
| --- | --- | --- | --- |
| `kind` | Which of the six record kinds this is. | Custodian, from the record being signed | `AUTHORITY_RECORD_KIND` if not one of the six (`controlled-authority-verifier.ts:21-28,171`) |
| `recordId` | This record's own identity, so a payload cannot be lifted onto another record — the signature covers it. | Custodian | `AUTHORITY_RECORD_INVALID` unless it matches the UUID pattern at `controlled-authority-verifier.ts:71` |
| `issuer` | The authority the key belongs to. Must match a trust-set entry exactly, together with `keyId`. | Custodian | `AUTHORITY_KEY_NOT_ALLOWLISTED` (`:211-214`) |
| `keyId` | Which key signed. Lowercase, `^[a-z0-9][a-z0-9._-]{0,63}$`. | Custodian | `AUTHORITY_RECORD_INVALID` (`:72,173`) |
| `signedAt` | When the envelope was signed. Must fall inside the key's `notBefore`/`notAfter`. | Custodian | `AUTHORITY_KEY_NOT_VALID_AT_SIGNING_TIME` (`:218-221`) |
| `expiresAt` | When this envelope stops being read. Strictly after `signedAt`; a record already past it is refused whatever it says. | Custodian | `AUTHORITY_RECORD_INVALID` (`:179`) then `AUTHORITY_RECORD_EXPIRED` (`:222`) |
| `signature` | Ed25519 over the canonical bytes of the seven other fields. Base64url, **unpadded** — `=` is not in the accepted character set. | Custodian | `AUTHORITY_RECORD_INVALID` (`:73,176`), or `AUTHORITY_SIGNATURE_INVALID` if it is not 64 bytes or does not verify (`:227,240`) |
| `payload` | The record in section 2. Must be a JSON object. | The authorizing body | `AUTHORITY_RECORD_INVALID` (`:180`) |

`expiresAt` is the envelope's life, not the pilot's. Keep it at or after
`scope.sessionsUntil`: an envelope that expires mid-pilot leaves the running
sessions with no verifiable authorization behind them.

---

## 2. The payload

```json
{
  "recordKind": "external_authorization",
  "authorizationId": "<<FRESH UUID - VERSION 4, LOWERCASE>>",
  "synthetic": false,
  "authorizingBody": {
    "bodyKind": "<<ONE OF school | research_ethics_board | school_and_research_ethics_board>>",
    "bodyRef": "<<SALTED SHA-256 OF THE BODY LEGAL NAME - 64 LOWERCASE HEX>>",
    "approvalReference": "<<THE BODY OWN FILE NUMBER - NO SPACES>>",
    "decidedAt": "<<ISO 8601 UTC INSTANT THE BODY DECIDED>>"
  },
  "scope": {
    "schoolRef": "<<SALTED SHA-256 OF THE SCHOOL LEGAL NAME>>",
    "classRef": "<<SALTED SHA-256 OF THE CLASS IDENTIFIER>>",
    "roomIds": ["<<ROOM UUID - ONE ENTRY PER AUTHORIZED ROOM, NO WILDCARD>>"],
    "maxStudentsPerRoom": "<<INTEGER 1-40>>",
    "maxStudentsTotal": "<<INTEGER 1-400, NOT SMALLER THAN maxStudentsPerRoom>>",
    "sessionsFrom": "<<ISO 8601 UTC - FIRST INSTANT A SESSION MAY RUN>>",
    "sessionsUntil": "<<ISO 8601 UTC - LAST INSTANT A SESSION MAY RUN>>"
  },
  "supervisingTeacherRef": "<<SALTED SHA-256 OF THE SUPERVISING TEACHER>>",
  "rollbackOwnerRef": "<<SALTED SHA-256 OF WHOEVER MAY STOP THE PILOT>>",
  "incidentContactRefs": ["<<SALTED SHA-256 OF AN INCIDENT CONTACT>>"],
  "participantInformation": {
    "informationSheetSha256": "<<SHA-256 OF THE INFORMATION SHEET GIVEN TO GUARDIANS>>",
    "consentPath": "<<ONE OF guardian_written_opt_in | guardian_and_student_written_opt_in>>",
    "consentObtainedBy": "<<ISO 8601 UTC - NOT AFTER sessionsFrom>>"
  },
  "reviewedDocuments": [
    { "documentKind": "threat_model", "documentSha256": "<<SHA-256 OF THE VERSION READ>>", "reviewedAt": "<<ISO 8601 UTC - NOT AFTER decidedAt>>" },
    { "documentKind": "data_inventory", "documentSha256": "<<SHA-256 OF THE VERSION READ>>", "reviewedAt": "<<ISO 8601 UTC - NOT AFTER decidedAt>>" },
    { "documentKind": "retention_policy", "documentSha256": "<<SHA-256 OF THE VERSION READ>>", "reviewedAt": "<<ISO 8601 UTC - NOT AFTER decidedAt>>" }
  ],
  "retentionPolicyId": "<<UUID OF THE IMPORTED pilot_retention_policy VERSION>>",
  "providerScope": {
    "providerId": "<<PROVIDER ID FROM THE REVIEWED MANIFEST - LOWERCASE>>",
    "providerManifestSha256": "<<SHA-256 OF THE EXACT MANIFEST FILE BYTES>>",
    "region": "<<REGION FROM THE REVIEWED MANIFEST>>",
    "purpose": "<<PURPOSE FROM THE REVIEWED MANIFEST - NO SPACES>>",
    "remoteCopyMode": "no_persistent_copy_attested",
    "copyAuthorityRecordSha256": "<<SHA-256 OF THE SIGNED provider_copy_authority RECORD FILE>>",
    "copyAuthorityExpiresAt": "<<ISO 8601 UTC - NOT BEFORE sessionsUntil>>"
  },
  "featureAllowlist": ["<<ONE OR MORE OF room_chat | media_upload | agent_nova | teacher_analytics | teacher_export>>"],
  "usedForGradesOrDiscipline": false,
  "authorizedSignerRefs": ["<<SALTED SHA-256 OF A PERSON ENTITLED TO SIGN FOR THE BODY>>"]
}
```

### Field by field

| Field | What it means, in plain language | Who is entitled to state it | Refused as |
| --- | --- | --- | --- |
| `synthetic` | Whether this is a rehearsal of the paperwork. A rehearsal is useful and is not an authorization. | The body | `AUTHORIZATION_WAS_SYNTHETIC` when `true` (`governance.ts:94`) |
| `authorizingBody.bodyKind` | Whether the school decided, the ethics board decided, or both decided together. | The body | Schema-refused as `INVALID_EXTERNAL_AUTHORIZATION_RECORD` if it is anything else |
| `authorizingBody.bodyRef` | The body's identity as a salted digest, never the name. | The body (digest computed by the custodian to the convention in §3) | `AUTHORIZATION_SELF_ISSUED` if it equals the supervising teacher, the rollback owner or any incident contact (`governance.ts:109-115`) |
| `authorizingBody.approvalReference` | The body's own file or minute number, so the decision can be looked up on their side. No spaces: `^[A-Za-z0-9._:/-]+$`, ≤160 characters. | The body | Schema-refused |
| `authorizingBody.decidedAt` | When the decision was taken. Everything else orders around it. | The body | `AUTHORIZATION_DECISION_OUT_OF_ORDER` if any document was read after it, or if sessions start before it (`governance.ts:118-120`) |
| `scope.schoolRef`, `scope.classRef` | Which school and which class, as salted digests. | The body | Schema-refused unless 64 lowercase hex |
| `scope.roomIds` | Every room this decision covers, listed. There is no wildcard: a room not listed was not authorized. 1–20 entries, no duplicates. | The body, working from room ids engineering supplies | Schema-refused |
| `scope.maxStudentsPerRoom` / `maxStudentsTotal` | The caps the body admitted. A per-room cap larger than the whole cohort is a number that can never refuse anyone. | The body | `AUTHORIZATION_SCOPE_UNBOUNDED` if per-room exceeds total (`governance.ts:126-129`) |
| `scope.sessionsFrom` / `sessionsUntil` | The closed window sessions may run in. Longer than 180 days is a standing permission, not a pilot. | The body | `AUTHORIZATION_SCOPE_UNBOUNDED` (`governance.ts:77,126`); `INVALID_EXTERNAL_AUTHORIZATION_RECORD` if `until` is not after `from` (`:105`) |
| `supervisingTeacherRef` | The named teacher supervising the authorized sessions. | The body | Part of the "operating party" set that makes `AUTHORIZATION_SELF_ISSUED` fire |
| `rollbackOwnerRef` | Who may stop the pilot. | The body | Same |
| `incidentContactRefs` | Who takes the call when something goes wrong. 1–5 entries. | The body | Same |
| `participantInformation.informationSheetSha256` | The digest of the sheet guardians actually received. | The body | Schema-refused |
| `participantInformation.consentPath` | Guardian opt-in, or guardian **and** student opt-in. | The body | Schema-refused |
| `participantInformation.consentObtainedBy` | The instant consent was held for everyone in scope. Sessions may not begin before it. | The body | `AUTHORIZATION_CONSENT_NOT_OBTAINED_BEFORE_SESSIONS` (`governance.ts:130-132`) |
| `reviewedDocuments` | Exactly three entries, one per kind: `threat_model`, `data_inventory`, `retention_policy`, each bound to the digest of the version read. | The body | `AUTHORIZATION_REVIEWED_DOCUMENTS_INCOMPLETE` if a kind is missing or duplicated (`governance.ts:121-125`) |
| `retentionPolicyId` | The `pilot_retention_policy` version these sessions run under — the id in the signed policy record an operator imports with `pnpm governance:import-policy`. | The body, from the policy record it approved | Schema-refused unless a UUID |
| `providerScope.*` | The exact model provider the decision covers, by id, manifest digest, region and purpose. No URL, endpoint or secret belongs here. | The body, from the reviewed manifest | `AUTHORIZATION_PROVIDER_SCOPE_MISMATCH` — see below |
| `featureAllowlist` | The surfaces this decision opens. Student-visible ECHO and TRACE are **absent from the vocabulary**: they are a separate signed decision and cannot be reached from here. | The body | Schema-refused for any other value |
| `usedForGradesOrDiscipline` | Whether the analytics feed grades or discipline. | The body | `AUTHORIZATION_USED_FOR_GRADES_OR_DISCIPLINE` when `true` (`governance.ts:95`) |
| `authorizedSignerRefs` | Who may sign for the body. Naming a signer is not proof; the envelope signature is. 1–5 entries. | The body | `AUTHORIZATION_SELF_ISSUED` if any of them is a party running the pilot (`governance.ts:112-115`) |

### The two provider modes are exclusive

`providerScope` carries the fields of exactly one mode
(`governance.ts:133-153`):

- `no_persistent_copy_attested` **must** carry `copyAuthorityRecordSha256` and
  `copyAuthorityExpiresAt`, and **must not** carry `capabilitySchemaVersion` or
  `portSchemaVersion`. The attestation must not expire before
  `scope.sessionsUntil`, or the last sessions run under nothing at all.
- `delete_and_probe` **must** carry `capabilitySchemaVersion` and
  `portSchemaVersion`, and **must not** carry the copy-authority fields.

Anything else is `AUTHORIZATION_PROVIDER_SCOPE_MISMATCH`.

> **Only one of the two modes can actually run in this build.** The contract
> describes both, but the worker's manifest reader refuses `delete_and_probe`
> with `AGENT_PROVIDER_MANIFEST_COPY_MODE_UNIMPLEMENTED`
> (`services/worker/src/learning_orbit_worker/providers/manifest.py:43,113-114`):
> there is no remote delete, no unreadability probe and no closure record in this
> repository. An authorization naming `delete_and_probe` would verify and then
> have nothing to run against. Say so to the body before it decides.

### Dates that never happened

`format: "date-time"` admits strings `Date.parse` cannot place — a leap second
such as `2026-12-31T23:59:60Z` parses to `NaN`, and every comparison against
`NaN` is false, so an ordering rule would wave the record through instead of
refusing it. Each timestamp is therefore read into a real instant first and
refused as `INVALID_EXTERNAL_AUTHORIZATION_RECORD` if it cannot be placed
(`governance.ts:42-46,97-104`). Use plain UTC instants with a `Z` suffix.

---

## 3. The salted digests, and the trap in them

Every `*Ref` field is a salted SHA-256 of an identity, written as 64 lowercase
hex characters. The record is evidence about the system, never a directory of
people.

**Nothing in this repository derives or checks these digests.** The schema checks
the shape; the contract checks whether two of them are *equal*. That puts one
trap in the operator's hands:

> If `bodyRef` and `supervisingTeacherRef` are computed with different salts —
> or one with a name and one with an email — then a body that **is** the
> supervising teacher produces two different digests, and
> `AUTHORIZATION_SELF_ISSUED` cannot fire. The check is only as good as the
> consistency of the inputs.

So, for one pilot:

1. One salt, generated outside the repository, at least 32 bytes, held by the
   custodian. It never enters Git, a log, a report, a test fixture or a browser
   payload — the same rule the audit salt lives under
   (`apps/server/src/config.ts:143-158`).
2. One documented input form per role, used for every record in the pilot. The
   convention that already exists in the codebase is
   `sha256("<salt>:<tag>:<identity>")`
   (`apps/server/src/modules/security/security-audit.ts:31-33`); use `school`,
   `class`, `body`, `teacher`, `rollback`, `incident`, `signer`, `decider` as the
   tag, and one stable identity string per person or body.
3. The identity-to-digest mapping is held by the authorizing body, outside this
   repository. Engineering does not need it and must not be given it.

The same rule reaches across records: the teacher who ran the shadow must produce
the **same** digest in the shadow record's `teacherRef` and in the promotion's
`shadowTeacherRef`, or `PROMOTION_DECIDED_BY_SHADOW_TEACHER` cannot fire either.

---

## 4. Digests of documents

`documentSha256`, `informationSheetSha256`, `providerManifestSha256` and
`copyAuthorityRecordSha256` are all SHA-256 over the **exact bytes** of the file
the body was shown:

```bash
shasum -a 256 docs/security/threat-model.md
shasum -a 256 docs/privacy/data-inventory.md
```

Two consequences worth stating to the body out loud:

- These documents live in the repository and change with commits. Record the
  commit sha alongside the digest on the body's own copy, so "the version we
  reviewed" can be recovered later.
- The digest binds what was read, not whether it was understood. A digest of an
  unread document is a well-formed lie the checker cannot detect.

---

## 5. What this record does **not** do

- It does not admit students to anything by itself. Gate 6 also needs the
  completed shadow, and the promotion decides student visibility separately.
- It does not turn Nova on. That needs the provider credential, injected into the
  deployment environment by someone accountable for it
  ([`docs/runbooks/model-provider.md`](../../runbooks/model-provider.md)).
- It does not prove learning benefit, production readiness, or anything about an
  individual student. See the claim ceiling in
  [`docs/plans/Learning Orbit Completion Plan.md`](../../plans/Learning%20Orbit%20Completion%20Plan.md).

Next: [sign it](../../runbooks/authority-signing.md), then
[check it](../../runbooks/authority-verification.md).
