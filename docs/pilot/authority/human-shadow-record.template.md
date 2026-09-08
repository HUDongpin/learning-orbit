# Template: human shadow record

> **This file is a template. It is not a record, and it is not evidence that a
> shadow happened.** Every value below is a `<<PLACEHOLDER>>` that no schema
> pattern accepts. A completed record is written by the teacher who ran the
> session, and signed **outside this repository**.
>
> **本檔案是範本，不是記錄，也不代表 shadow 曾經發生。** 完成的記錄由實際執行
> session 的教師填寫，並在 repository 之外簽署。

Kind: `human_shadow_completed` · Payload schema:
`packages/contracts/schemas/human-shadow-record.v1.json` · Payload checker:
`humanShadowRecordContract` (`packages/contracts/src/governance.ts:168-193`) ·
Protocol: [`docs/runbooks/agent-shadow-protocol.md`](../../runbooks/agent-shadow-protocol.md)

Read the protocol first. It says what a shadow is, what the five outcomes mean,
and how to run the session. This file is only about the record the session
produces.

---

## 1. Start from the tool, not from this file

The checker ships the shape, so the template and the checker cannot drift:

```bash
pnpm verify:shadow --example > shadow-draft.json    # write it OUTSIDE the repository
```

That prints a filled example with `verdict: "not_ready"` and one placeholder
observation. Replace every value. The example is a shape, not a record: its
`teacherRef` is sixty-four zeros and its ids are all-zero UUIDs, which is
deliberate — nobody can sign it by accident and mean anything by it.

---

## 2. The payload

```json
{
  "recordKind": "human_shadow_completed",
  "shadowId": "<<FRESH UUID - VERSION 4, LOWERCASE>>",
  "roomId": "<<UUID OF THE ROOM THE SHADOW RAN IN>>",
  "teacherRef": "<<SALTED SHA-256 OF THE TEACHER WHO RAN IT - 64 LOWERCASE HEX>>",
  "rehearsal": false,
  "studentsPresent": false,
  "startedAt": "<<ISO 8601 UTC - WHEN THE SESSION STARTED>>",
  "endedAt": "<<ISO 8601 UTC - AT LEAST 10 MINUTES AFTER startedAt>>",
  "agentRunsObserved": ["<<AGENT RUN UUID - ONE PER RUN YOU WATCHED>>"],
  "observations": [
    {
      "agentRunId": "<<THE SAME AGENT RUN UUID>>",
      "outcome": "<<ONE OF appropriate | unhelpful | harmful | blocked | failed>>",
      "note": "<<WHAT THE AGENT DID AND WHY IT WAS OR WAS NOT APPROPRIATE>>"
    }
  ],
  "verdict": "<<ONE OF ready_for_students | not_ready>>",
  "conditions": ["<<ANYTHING THAT MUST BE TRUE BEFORE STUDENTS ARE ADMITTED>>"]
}
```

The envelope around this payload is the same eight keys as every other authority
record; see
[the authorization template §1](external-authorization-record.template.md#1-the-envelope)
and [the signing runbook](../../runbooks/authority-signing.md).

### Field by field

| Field | What it means, in plain language | Who is entitled to state it | Refused as |
| --- | --- | --- | --- |
| `shadowId` | This shadow's own identity. One per session. | The teacher | Schema-refused unless a UUID |
| `roomId` | The room the session ran in. The agent run ids below come from this room. | The teacher, from the room they used | Schema-refused unless a UUID |
| `teacherRef` | Who ran it, as a salted digest — never the name. Must be the **same digest** this person gets in any other record of this pilot. | The custodian, to the pilot's one convention (see [authorization template §3](external-authorization-record.template.md#3-the-salted-digests-and-the-trap-in-them)) | Schema-refused unless 64 lowercase hex |
| `rehearsal` | Whether this was a rehearsal against the deterministic fixture. Rehearsing is useful preparation and proves the mechanics work; it proves nothing about what the model says, which is the entire question. | The teacher | `SHADOW_WAS_A_REHEARSAL` when `true` (`governance.ts:171`) |
| `studentsPresent` | Whether students were in the room. If they were, the thing the shadow was supposed to de-risk has already happened. | The teacher | `SHADOW_HAD_STUDENTS_PRESENT` when `true` (`governance.ts:172`) |
| `startedAt` / `endedAt` | The real span of the session. The checker requires at least **10 minutes**; the protocol asks for **45**, because a single good answer says very little. | The teacher | `SHADOW_TOO_SHORT` under 10 minutes (`governance.ts:178`); `INVALID_HUMAN_SHADOW_RECORD` if `endedAt` is not after `startedAt` or either cannot be placed as an instant (`:173-175`) |
| `agentRunsObserved` | Every agent run this record claims to cover. 1–100, no duplicates. | The teacher | Schema-refused |
| `observations` | One entry per claimed run: what it did, and whether that was appropriate. A verdict not grounded in an observation of every run it claims to cover is an opinion wearing the shape of evidence. | The teacher | `SHADOW_OBSERVATIONS_INCOMPLETE` when the two sets do not match exactly (`governance.ts:179-185`) |
| `observations[].outcome` | One of the five in the protocol's table. `blocked` is worth recording: it shows the safety policy working, and on what. | The teacher | Schema-refused for any other value |
| `observations[].note` | 1–1000 characters. "Fine" is not a note; what the agent said and why it was or was not appropriate is. | The teacher | Schema-refused if empty |
| `verdict` | Whether the teacher considers the system ready to be put in front of students. | The teacher | `SHADOW_VERDICT_CONTRADICTS_OBSERVATIONS` if `ready_for_students` sits over any `harmful` observation (`governance.ts:186-189`) |
| `conditions` | Up to 20 things that must be true before students are admitted. Optional, and the most useful field in the record. | The teacher | Schema-refused over 20 entries or 300 characters each |

---

## 3. What the note may and may not contain

The note is free text and it is the one place in these records where a person
writes prose. Keep it about the system:

- **Yes:** "Asked for evidence twice rather than answering; the second prompt
  repeated the first almost verbatim."
- **No:** a student's name, a seat code, message text quoted from the room, a
  provider response pasted in, a signed URL, or anything identifying a person.

A shadow runs with no students in the room, so there should be nothing of theirs
to quote. If there is, the session was not a shadow.

---

## 4. `not_ready` is a successful shadow

Nobody has to pass. A record that ends `not_ready` did its job: it found
something before a student did. The checker exits **zero** for such a record and
says so in plain words:

```
  the shadow did not clear the system for students
```

The release chain reads that verdict and refuses to count the record as held —
`SHADOW_VERDICT_NOT_READY` (`scripts/release-evidence.mjs:238`) — which is
correct, and is not a failure of the teacher or of the checker.

---

## 5. Clearing the shadow clears exactly one thing

It does not make student-visible ECHO or TRACE allowed. That is a separate
signed decision, by a different person:
[`student-visible-promotion-record.template.md`](student-visible-promotion-record.template.md).

Next: [sign it](../../runbooks/authority-signing.md), then
[check it](../../runbooks/authority-verification.md).
