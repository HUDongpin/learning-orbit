# Signing an authority record, and the trust set that admits it

This runbook is for the release custodian. It describes how to produce the key
that signs a Gate 6 record, how that key's public half enters the deployment
trust set, and the exact bytes a signature has to cover.

Everything here happens **outside this repository**. There is deliberately no
script in Learning Orbit that generates an authority key or signs an authority
record: a verifier that could also produce the thing it verifies would always
pass. The repository's job is to tell you afterwards whether you got it right,
and it is very good at that — see
[authority-verification.md](authority-verification.md).

Conventions this runbook extends:
[`docs/pilot/trusted-authority-configuration.md`](../pilot/trusted-authority-configuration.md).

---

## 1. What is being signed, and by whom

| | Authority record | Service assertion |
| --- | --- | --- |
| Lifetime | Months. A school term. | Seconds. One HTTP call. |
| Signed by | A human authority, offline | The worker process, at runtime |
| Verified by | `controlled-authority-verifier.ts` | `LO_SERVICE_ASSERTION_TRUST_FILE` |
| Private key location | A custodian's offline machine | `LO_WORKER_ASSERTION_PRIVATE_KEY_FILE`, mode `0600` |

The two verifiers are deliberately separate and neither accepts the other's
record shape or key purpose
(`apps/server/src/modules/authorization/controlled-authority-verifier.ts:5-19`).
**No process in Learning Orbit ever reads an authority private key.** If a
deployment finds itself configuring a path to one, something has gone wrong.

---

## 2. Generate the key pair, off this machine

Ed25519, one key pair per issuer, generated on a machine that does not check out
this repository:

```bash
umask 077
openssl genpkey -algorithm ed25519 -out authority-2026a.key.pem
openssl pkey -in authority-2026a.key.pem -pubout -out authority-2026a.pub.pem
```

`umask 077` makes the private key `0600` at creation rather than after a window
in which it was world-readable. Verify both:

```bash
ls -l authority-2026a.key.pem     # -rw-------  owned by the custodian, not a group
head -1 authority-2026a.pub.pem   # -----BEGIN PUBLIC KEY-----
```

Custody rules, the same ones the pilot's other secrets live under:

- Mode `0600`, owned by the custodian's own account, not a symlink, not on a
  shared volume. The worker's key loader enforces exactly this shape for its own
  key and refuses anything else
  (`services/worker/src/learning_orbit_worker/service_assertion.py:153-162`);
  the authority key is held to the same standard by hand, because no program
  holds it.
- Never in Git, never in a log, an environment dump, an API body, a browser
  payload, a chat message or a screenshot.
- One key per issuer per validity period. Sharing a key between two issuers means
  the trust set can no longer say who signed.

Only `BEGIN PUBLIC KEY` — SPKI — is accepted in the trust file; the parser looks
for that exact marker (`controlled-authority-verifier.ts:114`). An OpenSSH
`ssh-ed25519 AAAA…` line is not it.

---

## 3. The trust set

The trust set is a JSON file the deployment controls. It is named on the command
line of the verification tools (`--trust <file>`); there is no environment
variable that points at it, and the server does not read it at startup.

```json
{
  "version": 1,
  "keys": [
    {
      "keyId": "authority-2026a",
      "issuer": "example-school-board",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\nMCow…\n-----END PUBLIC KEY-----\n",
      "notBefore": "2026-08-01T00:00:00.000Z",
      "notAfter": "2027-02-01T00:00:00.000Z",
      "revokedAt": null
    }
  ]
}
```

| Field | Meaning | Refused as |
| --- | --- | --- |
| `version` | Exactly `1`. | `AUTHORITY_TRUST_SET_INVALID` (`:101`) |
| `keyId` | `^[a-z0-9][a-z0-9._-]{0,63}$`, unique within the file. A record names it together with `issuer`; both must match for the key to be found at all. | `AUTHORITY_TRUST_SET_INVALID` (`:108`), then `AUTHORITY_KEY_NOT_ALLOWLISTED` at verification (`:211-214`) |
| `issuer` | 1–160 characters. The authority this key belongs to. | `AUTHORITY_TRUST_SET_INVALID` (`:111`) |
| `publicKeyPem` | The SPKI PEM from step 2, embedded with `\n` escapes. | `AUTHORITY_TRUST_SET_INVALID` (`:114`, and again if OpenSSL cannot load it, `:156-159`) |
| `notBefore` / `notAfter` | The window in which this key **may have signed**. Checked against the record's `signedAt`, not against the clock. `notAfter` must be strictly after `notBefore`. | `AUTHORITY_TRUST_SET_INVALID` (`:117-119`); `AUTHORITY_KEY_NOT_VALID_AT_SIGNING_TIME` at verification (`:218-221`) |
| `revokedAt` | Set it and **every** record this key ever signed stops verifying, including ones signed before the compromise. That bluntness is the point: revocation is not a date filter, it is a refusal. | `AUTHORITY_KEY_REVOKED` (`:215`) |
| `fixture` | Boolean. See below. | `AUTHORITY_FIXTURE_KEY_FORBIDDEN` (`:216`) |

The trust file itself is public material — it holds only public keys — but it is
still deployment-controlled: whoever can edit it can admit a key. Keep it under
the same change control as the deployment, and record its digest. `pnpm
verify:pilot` writes the trust set's SHA-256 into the evidence chain, so a
release names the anchor that admitted it rather than leaving a reader to guess
(`scripts/release-evidence.mjs:284-295`).

### A fixture key can never enter the pilot trust set

`fixture: true` marks a key that exists so the tools can be exercised without a
real authority. Verification refuses it unless the caller passes
`allowFixtureKeys` explicitly, and the only callers that pass it are the
`--fixture` and `--dry-run` self-tests
(`controlled-authority-verifier.ts:66-68,216`;
`scripts/verify-controlled-authority.ts:121,149`).

Two more layers sit behind that:

- `scripts/verify-controlled-authority.ts:88-91` refuses the fixture path
  outright when `NODE_ENV=production`.
- The release chain refuses any verifier answer that reports `fixture` as
  anything but `false` — `AUTHORITY_FIXTURE_RESULT_REFUSED`
  (`scripts/release-evidence.mjs:254`).

So the rule is not "avoid fixture keys in production". It is: a fixture key in a
pilot trust set is a mistake the tooling will catch, and a fixture key **without**
the flag is a real key with a misleading name — which nothing can catch. Never
copy a demonstration key pair into a trust set and drop the flag to make it work.

### Rotation without a gap

```
key A  notBefore 2026-08-01 ────────── notAfter 2027-02-01
key B                    notBefore 2027-01-01 ────────── notAfter 2027-08-01
                         └── overlap, not a gap ──┘
```

A record signed in a gap between one key's `notAfter` and the next key's
`notBefore` verifies against nothing, and the authority then looks forged rather
than merely late. `trustSetHasNoRotationGap` checks this per issuer, skipping
revoked keys, and reports `gapped` when a key starts after the previous one
ended (`controlled-authority-verifier.ts:137-154`). The check is a *report*, not
a refusal: `pnpm verify:authority` prints `"rotation":"continuous"` or
`"rotation":"gapped"` on its success line and still accepts the record.

So: start the new key **before** the old one expires, keep both in the file
through the overlap, and only then let the old one lapse. Do not delete a lapsed
key — records it signed while valid still verify, and deleting it turns them into
`AUTHORITY_KEY_NOT_ALLOWLISTED`.

---

## 4. Sign the record

The signature covers the canonical bytes of the payload **together with the
record's own identity**, so a payload cannot be lifted onto another record
(`controlled-authority-verifier.ts:229-240`). The exact input is the seven
non-signature fields, canonicalised (`authoritySigningInput`, `:253-266`).

Canonical JSON here means: object keys sorted at every level, no whitespace, no
trailing newline, UTF-8, and **safe integers only** — a number that is not a safe
integer, and `-0`, are refused as `CANONICAL_JSON_INVALID`
(`apps/server/src/modules/security/canonical-json.ts:41`). Depth is capped at 64,
nodes at 10 000, strings at 16 384 characters, total output at 1 MiB.

That rule judges the **value, not the spelling**. The record is read with
`JSON.parse` (`controlled-authority-verifier.ts:163`), so `30.0` has already
become the number `30` before the canonicaliser sees it: a trailing `.0` is not
refused, it is silently normalised, and the only thing it changes is whether the
bytes you signed match the bytes the verifier rebuilds. `30.5` is a different
matter and really is refused. Both cases are worked through in the procedure below.

### The procedure

1. Write the seven fields — `kind`, `recordId`, `issuer`, `keyId`, `signedAt`,
   `expiresAt`, `payload` — into `unsigned.json`. No `signature` key yet.

2. Canonicalise. `jq -cjS .` produces byte-identical output to the verifier's own
   canonicaliser for a well-formed record (`-c` compact, `-j` no trailing
   newline, `-S` sort keys recursively):

   ```bash
   jq -cjS . unsigned.json > signing-input.bin
   ```

3. Sign those bytes. Ed25519 signs the message directly; there is no separate
   digest step:

   ```bash
   openssl pkeyutl -sign -inkey authority-2026a.key.pem \
     -rawin -in signing-input.bin -out signature.bin
   wc -c < signature.bin        # must print 64
   ```

4. Encode base64url, **unpadded**. The verifier's character class is
   `^[A-Za-z0-9_-]+$`, so a `=` makes the whole record `AUTHORITY_RECORD_INVALID`
   before anything looks at the signature
   (`controlled-authority-verifier.ts:73,176`):

   ```bash
   openssl base64 -A < signature.bin | tr '+/' '-_' | tr -d '='   # 86 characters
   ```

5. Add that string as `"signature"` in the record file. Key order in the file
   does not matter — only the sorted key **list** is compared (`:169-170`) — but
   the bytes of every value do.

6. Verify before handing it over. This step is the repository's only real
   contribution to signing: it recomputes the canonical bytes independently, so
   if your canonicalisation differed by one byte you learn it now rather than at
   a release gate.

   ```bash
   pnpm verify:authority --record record.json --trust authority-trust.json
   ```

### Three ways this goes wrong quietly

Each of these produces a *different* refusal code, and the difference matters:
looking for the wrong one costs an afternoon.

- **A whole number spelled as a float** — `"maxLatencyMinutes": 30.0`. Nothing
  rejects it, which is what makes it a trap. `jq -cjS` keeps the literal, so you
  sign `…"maxLatencyMinutes":30.0…`; the verifier's `JSON.parse` reads it as the
  integer `30` and its canonicaliser emits `…"maxLatencyMinutes":30…`. The two
  byte streams differ by two characters, so the refusal is
  **`AUTHORITY_SIGNATURE_INVALID`**, *not* `CANONICAL_JSON_INVALID`. The payload
  canonicalised perfectly well; it is the signature that no longer covers it.
- **A genuinely fractional number** — `"maxLatencyMinutes": 30.5`. This one
  survives `JSON.parse` as `30.5` and the canonicaliser refuses it outright,
  before the signature is looked at: **`CANONICAL_JSON_INVALID`**, whatever the
  signature says. Keep every number in a payload whole — minutes, days, counts —
  and neither case can arise.
- **A control character in a note.** `jq` escapes `U+007F` as `\u007f`;
  `JSON.stringify`, which the verifier's canonicaliser uses, emits it literally.
  The two byte streams then differ and the signature fails with
  **`AUTHORITY_SIGNATURE_INVALID`**. Keep record text to ordinary printable
  characters, and run step 6 every time.

Step 6 catches all three before the record leaves your hands, which is the whole
reason it is not optional.

---

## 5. Where the signed record lives

Outside the repository. A record file inside the worktree makes
`git status --porcelain=v1` non-empty, and the release chain then reports
`WORKTREE_DIRTY` and refuses the evidence
(`scripts/release-evidence.mjs:105-118`). Keep the three records in a
deployment-controlled directory — `/secure/authority/`, `/run/learning-orbit/`,
whatever the deployment uses — readable by the operator who runs the verifier and
nobody else.

Next: [authority-verification.md](authority-verification.md).
