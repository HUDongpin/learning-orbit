# Checking a completed authority record

This runbook is for the operator who has been handed one or more signed Gate 6
records and has to decide whether they are what they claim to be, and then feed
them into the release chain.

Nothing here produces a record. Every command reads; the only file any of them
writes is the evidence chain in step 5.

Prerequisites: Node `24.19.x` and pnpm `11.19.0`, per
[local-dev.md](local-dev.md). The three records and the trust set live
**outside** the repository — a record file inside the worktree makes the chain
report `WORKTREE_DIRTY`.

---

## 1. Check each record on its own

Two checkers, three kinds. The split is not arbitrary: the shadow record's
payload is checked by `verify-shadow-record.ts` and by nothing else, because
`verify-controlled-authority.ts` applies payload contracts to only the two kinds
that open a classroom (`scripts/verify-controlled-authority.ts:51-63`).

```bash
TRUST=/secure/authority/authority-trust.json

pnpm verify:authority --record /secure/authority/external-authorization.json --trust "$TRUST"
pnpm verify:shadow    --record /secure/authority/human-shadow.json           --trust "$TRUST"
pnpm verify:authority --record /secure/authority/student-visible-promotion.json --trust "$TRUST"
```

### Reading `verify:authority`

A single JSON line on stdout, exit `0`:

```json
{"ok":true,"kind":"external_authorization","recordId":"…","issuer":"…","keyId":"…",
 "signedAt":"…","expiresAt":"…","payloadContract":"external-authorization-record.v1",
 "fixture":false,"rotation":"continuous"}
```

Read four fields before believing it:

| Field | What to require | Why |
| --- | --- | --- |
| `payloadContract` | `external-authorization-record.v1` or `student-visible-promotion-record.v1` | `null` means the payload was checked by nothing. A signature proves who wrote the bytes and nothing about what they say. |
| `fixture` | `false` | `true` means the tool signed its own example. It proves the plumbing works and admits nobody. |
| `rotation` | `continuous` | `gapped` is a *report*, not a refusal — this record verified, and the next one signed in the gap will not. Fix the trust set before it happens. |
| `issuer` / `keyId` | The authority you expect | A valid signature from an unexpected key is still a valid signature from an unexpected key. |

### Reading `verify:shadow`

```json
{"ok":true,"shadowId":"…","minutes":45,"runsObserved":3,"verdict":"ready_for_students","signedBy":"issuer/keyId"}
```

- `signedBy: null` with the trailing line `coherent, but unsigned: pass --trust
  to check authority` means you checked a **draft**. Gate 6 does not admit
  drafts.
- A `not_ready` verdict exits `0` and prints `the shadow did not clear the system
  for students`. That is the checker working. The release chain reads the verdict
  and refuses to count the record as held (`SHADOW_VERDICT_NOT_READY`).
- Passing `--trust` with an unsigned draft gives `AUTHORITY_RECORD_INVALID`: a
  bare payload is not an envelope.

---

## 2. What each refusal code means

A refusal is one bounded code on stderr and exit `1`. No part of a record is ever
echoed (`scripts/verify-controlled-authority.ts:65-74`).

### The envelope and the key

| Code | What happened | What to do |
| --- | --- | --- |
| `AUTHORITY_INPUT_UNREADABLE` | A path is wrong, or the file is not JSON. | Check the two paths. |
| `AUTHORITY_RECORD_INVALID` | The envelope is not the eight expected keys, or `recordId` is not a UUID, or `keyId` is not lowercase, or `signature` is not unpadded base64url, or `expiresAt` is not after `signedAt`, or `payload` is not an object. | Compare against [the envelope table](../pilot/authority/external-authorization-record.template.md#1-the-envelope). A stray `=` on the signature lands here. |
| `AUTHORITY_RECORD_KIND` | `kind` is not one of the six known kinds. | A typo, or a record from another system. |
| `AUTHORITY_TRUST_SET_INVALID` | The trust file is malformed, has a duplicate `keyId`, a PEM without `BEGIN PUBLIC KEY`, or `notAfter` not after `notBefore`. | [Signing runbook §3](authority-signing.md#3-the-trust-set). |
| `AUTHORITY_KEY_NOT_ALLOWLISTED` | No trust entry matches this `issuer` **and** `keyId`. | Usually a key that was deleted after it lapsed, or an issuer string that does not match byte for byte. |
| `AUTHORITY_KEY_REVOKED` | The key is revoked. Every record it ever signed is refused, including ones signed before the revocation. | Re-sign under a live key, or investigate why it was revoked. |
| `AUTHORITY_FIXTURE_KEY_FORBIDDEN` | The key is flagged `fixture: true`. | A demonstration key reached a real trust set. Remove it. |
| `AUTHORITY_KEY_NOT_VALID_AT_SIGNING_TIME` | `signedAt` falls outside the key's `notBefore`/`notAfter`. | The classic rotation-gap symptom. |
| `AUTHORITY_RECORD_EXPIRED` | The envelope's `expiresAt` has passed. Checked before the signature, so an expired record is refused for being expired. | Re-sign with a window that covers the pilot. |
| `AUTHORITY_SIGNATURE_INVALID` | The signature is not 64 bytes, or does not verify over the canonical bytes. An RSA, EC or Ed448 public key in the trust set lands here too, because verification returns false for them; an **X25519** key does not - see `AUTHORITY_VERIFICATION_FAILED` below. | Almost always a canonicalisation difference: re-run [signing §4](authority-signing.md#4-sign-the-record) step 2. A whole number written `30.0` lands **here**, not in the row below: the verifier's `JSON.parse` reads it back as `30`, so the bytes signed and the bytes rebuilt differ by two characters. |
| `CANONICAL_JSON_INVALID` | The payload holds something the canonicaliser will not encode: a number that is not a safe integer (`30.5`), a negative zero (`-0` is a safe integer, and is refused by its own clause at `canonical-json.ts:41`), a lone surrogate, more than 64 levels, more than 10 000 nodes, a string over 16 384 characters, or over 1 MiB of output. | A payload problem, not a tooling failure. Canonicalisation runs before the signature check, so this code preempts whatever the signature would have said — fix the payload, then re-sign. |
| `AUTHORITY_VERIFICATION_FAILED` | A refusal with no bounded code of its own. An **X25519** public key in the trust set lands here rather than in `AUTHORITY_SIGNATURE_INVALID`: `crypto.verify` throws for that key type instead of returning false, and nothing rejects it earlier, since the trust set only requires a PEM that `createPublicKey` accepts. | Check the key type first - `openssl genpkey -algorithm X25519` is one keystroke from `ed25519` and is the likeliest cause. Otherwise re-run the individual checker for a specific code. |

### The authorization payload

All from `packages/contracts/src/governance.ts:91-157`.

| Code | What the record says about itself |
| --- | --- |
| `AUTHORIZATION_WAS_SYNTHETIC` | `synthetic: true` — a rehearsal of the paperwork, offered as a decision. |
| `AUTHORIZATION_USED_FOR_GRADES_OR_DISCIPLINE` | The analytics feed grades or discipline. The pilot makes no claim about an individual student. |
| `AUTHORIZATION_SELF_ISSUED` | The body, or one of its named signers, is the supervising teacher, the rollback owner or an incident contact. The pilot approved itself, possibly one indirection out. |
| `AUTHORIZATION_DECISION_OUT_OF_ORDER` | Sessions start before the decision, or a document was read after it. |
| `AUTHORIZATION_REVIEWED_DOCUMENTS_INCOMPLETE` | The three required document kinds are not each present exactly once. |
| `AUTHORIZATION_SCOPE_UNBOUNDED` | The window exceeds 180 days, or the per-room cap exceeds the whole cohort. |
| `AUTHORIZATION_CONSENT_NOT_OBTAINED_BEFORE_SESSIONS` | Sessions may begin before consent was held. |
| `AUTHORIZATION_PROVIDER_SCOPE_MISMATCH` | The provider scope carries the other copy mode's fields, or the copy attestation lapses before the last authorised session. |
| `INVALID_EXTERNAL_AUTHORIZATION_RECORD` | Schema failure, or a timestamp that never happened (a leap second parses to `NaN`, and every comparison against `NaN` is false, so it is refused rather than compared). |

### The shadow payload

All from `packages/contracts/src/governance.ts:168-193`.

| Code | What the record says about itself |
| --- | --- |
| `SHADOW_WAS_A_REHEARSAL` | Run against the deterministic fixture. Useful preparation; not a shadow. |
| `SHADOW_HAD_STUDENTS_PRESENT` | Students were in the room. The thing the shadow was to de-risk already happened. |
| `SHADOW_TOO_SHORT` | Under 10 minutes. |
| `SHADOW_OBSERVATIONS_INCOMPLETE` | The observed runs and the declared runs are not the same set. |
| `SHADOW_VERDICT_CONTRADICTS_OBSERVATIONS` | `ready_for_students` over an observation of harm. |
| `INVALID_HUMAN_SHADOW_RECORD` | Schema failure, or `endedAt` not after `startedAt`, or a timestamp that cannot be placed. |
| `SHADOW_RECORD_UNREADABLE` | Not JSON, or the path is wrong. |
| `SHADOW_RECORD_KIND_MISMATCH` | The envelope verified, but its `kind` is not `human_shadow_completed`. |

### The promotion payload

All from `packages/contracts/src/governance.ts:204-237`.

| Code | What the record says about itself |
| --- | --- |
| `PROMOTION_WAS_SYNTHETIC` | A rehearsal of the paperwork. |
| `PROMOTION_USED_FOR_GRADES_OR_DISCIPLINE` | What the student is shown feeds grades or discipline. |
| `PROMOTION_INFERRED_FROM_SHADOW` | `derivedFromShadowRecord: true`. The record admits it was not decided. |
| `PROMOTION_DECIDED_BY_SHADOW_TEACHER` | The decider is the teacher who ran the shadow. One person answering both questions tends to answer the second by momentum. |
| `PROMOTION_DECISION_OUT_OF_ORDER` | Visibility starts before the decision. |
| `PROMOTION_SCOPE_EXCEEDS_AUTHORIZATION` | The visibility window starts before, or outlasts, the authorization window the record restates. |
| `PROMOTION_CONTRADICTS_SHADOW_VERDICT` | Projection keys granted over a `not_ready` shadow. |
| `PROMOTION_REVOCATION_PATH_INEFFECTIVE` | Withdrawal may take longer than the grant lasts. A promise, not a path. |
| `INVALID_STUDENT_VISIBLE_PROMOTION_RECORD` | Schema failure, or an unplaceable timestamp, or a window that does not open before it closes. |

---

## 3. A template is refused as a record

Worth doing once, so nobody wonders later. Copy the payload block out of any
template in [`docs/pilot/authority/`](../pilot/authority/README.md) and run it
through its own checker:

```
$ pnpm verify:shadow --record template-payload.json
INVALID_HUMAN_SHADOW_RECORD
```

The other two payloads are refused the same way, by
`externalAuthorizationRecordContract` and
`studentVisiblePromotionRecordContract`, as
`INVALID_EXTERNAL_AUTHORIZATION_RECORD` and
`INVALID_STUDENT_VISIBLE_PROMOTION_RECORD`. The `<<PLACEHOLDER>>` values are
valid JSON strings and match none of the schema patterns, so an unfilled template
fails closed rather than being mistaken for a record.

---

## 4. The three links no tool checks

Between the individual checks and the release chain there is a gap only a person
closes. The promotion record names the other two records **by digest**, and
`^[a-f0-9]{64}$` is the only thing checked about those fields: nothing in this
repository recomputes them or compares them with the records the chain verified.

Before importing anything, confirm by hand:

```bash
shasum -a 256 /secure/authority/external-authorization.json
shasum -a 256 /secure/authority/human-shadow.json
```

1. The first digest equals the promotion's `externalAuthorizationRecordSha256`.
2. The second equals its `shadowRecordSha256`.
3. The promotion's `authorizedFrom` / `authorizedUntil` equal the
   authorization's `scope.sessionsFrom` / `scope.sessionsUntil`, and its
   `shadowVerdict` equals the shadow's `verdict`. The contract refuses a
   promotion whose window escapes the window it *restates*, but a restatement is
   not the record.

Also worth an eye, for the same reason:

4. The promotion's `roomId` appears in the authorization's `scope.roomIds`.
5. The shadow's `roomId` is a room the authorization covers.
6. The `reviewedDocuments` digests match the versions of
   [`threat-model.md`](../security/threat-model.md),
   [`data-inventory.md`](../privacy/data-inventory.md) and the retention policy
   that were actually put in front of the body.

None of these six is enforced anywhere. Write down that you checked them.

---

## 5. Feed all three into the release chain

The chain reads evidence and never produces any, so the pilot run has to exist
first:

```bash
pnpm verify:local-pilot                       # writes the receipt
pnpm verify:pilot \
  --trust /secure/authority/authority-trust.json \
  --authority /secure/authority/            # a directory, or one .json file
```

`--trust` and `--authority` are both-or-neither: one without the other exits `2`
with `RELEASE_AUTHORITY_OPTIONS_INCOMPLETE`, because an operator who meant to
verify authority would otherwise read the resulting `NOT HELD` lines as a
finished answer (`scripts/verify-release-evidence.mjs:71-74`).

Each record is dispatched to the checker that owns its kind — nothing is
re-decided here (`scripts/release-evidence.mjs:136-140`). The chain is written to
`test-results/release-evidence/<sha>.chain.json`, mode `0600`, and it carries the
records held, the trust set's digest, and every record refused. An exit code is
not carried in the file, which is why refusals go into it too.

### Chain-level refusals

| Code | What happened |
| --- | --- |
| `RELEASE_RECEIPT_ABSENT` | No pilot receipt. Run `pnpm verify:local-pilot` first. |
| `RELEASE_AUTHORITY_OPTIONS_INCOMPLETE` | Only one of `--trust` / `--authority`. Exit `2`. |
| `RELEASE_AUTHORITY_TRUST_UNREADABLE` | `--trust` is not a readable file. |
| `RELEASE_AUTHORITY_PATH_UNREADABLE` | `--authority` names nothing. |
| `AUTHORITY_RECORDS_ABSENT` | The directory holds no `.json`. A misconfiguration, not a release that happens to hold none. |
| `AUTHORITY_RECORD_UNREADABLE` | A file there is not a JSON object. |
| `AUTHORITY_RECORD_KIND_UNRECOGNISED` | Its `kind` is not one of the three Gate 6 kinds. The other authority kinds are real records about other decisions and are not standing in for these three. |
| `AUTHORITY_RECORD_KIND_DUPLICATED` | Two records claim the same kind. Not twice the authority — a question about which one the release was granted under, so neither is held. |
| `AUTHORITY_PAYLOAD_CONTRACT_NOT_APPLIED` | The verifier did not name the payload contract it applied. An older build, or a contract that failed to load; refused rather than mistaken for a clean result. |
| `AUTHORITY_FIXTURE_RESULT_REFUSED` | The verifier reported a fixture result. |
| `SHADOW_VERDICT_NOT_READY` | The shadow record is genuine and says the system is not ready. |
| `AUTHORITY_VERIFIER_UNAVAILABLE` / `AUTHORITY_VERIFIER_TIMEOUT` | The checker could not be run. Not a passing record. |
| `WORKTREE_DIRTY` | Something is uncommitted or untracked — including a record file left inside the repository. |
| `EVIDENCE_NOT_AT_HEAD`, `SOURCE_COMMIT_AFTER_EVIDENCE` | The evidence does not describe the commit being released. |

### Reading the ending

```
  held: School and research ethics authorization (blocks: Any session with real students)
  held: Non-student teacher shadow, conducted as a controlled human session (blocks: Gate 6 admission)
  held: Student visibility promotion, signed separately from the shadow (blocks: Any student-visible ECHO or TRACE)
verify:pilot: PASS sha=… chain=…
```

Three endings, and only one of them opens a classroom:

- **`PASS (engineering evidence only)`** — the engineering evidence holds and at
  least one human record is `NOT HELD`. The release is not admissible for a
  classroom. This is the current state of the project, and it is the correct
  state, not a bug to work around.
- **`AUTHORITY REFUSED`** — a record was offered and turned away. Different from
  a record nobody has signed, and it does not get the softer ending. Read the
  `refused <file>: <code>` lines above it.
- **`PASS`** — all three held, no refusals, no problems. `admissible: true` in the
  chain file (`scripts/release-evidence.mjs:391-395`).

---

## 6. What a PASS still does not mean

`admissible` means three signed records verified against a named trust set. It
does not mean the sessions they describe happened, that the documents named by
digest were understood, that the digests in §4 line up, or that the pilot is
safe. It means the paperwork is real, checkable, and points at the decisions it
claims to.

The claim ceiling in
[`docs/plans/Learning Orbit Completion Plan.md`](../plans/Learning%20Orbit%20Completion%20Plan.md)
still holds in full: no amount of green output substitutes for the three signed
human records, and the records themselves prove nothing about learning benefit,
production readiness, or any individual student.
