# Model provider: what is decided, and by whom

The Anthropic Messages adapter is implemented and tested. Turning it on is a
separate act, and this file is about that act rather than about the code.

## What engineering has delivered

- `services/worker/src/learning_orbit_worker/providers/anthropic.py` — the
  adapter, selected by `providerId` from the reviewed manifest. A manifest
  naming an unimplemented provider is refused rather than falling back to a
  default.
- The manifest format, bound to its own sha256, which names the credential's
  environment variable and never carries the credential.
- A health probe that reports `unavailable` / `CREDENTIAL_ABSENT` before any
  network call, so an unconfigured provider is a stated condition rather than a
  silent one.
- `services/worker/tests/test_anthropic_provider.py` — 18 cases, none of which
  touch the network.

## What the adapter refuses

- A model id or an output ceiling the manifest does not describe. The reviewed
  document and the running system have to be the same system.
- A plaintext endpoint, including locally. A provider call carries classroom
  text off the machine.
- A copy mode nobody reviewed.
- Any response body reaching a log, a span, an exception or a caller. A
  provider error can quote the prompt it was sent; only bounded codes escape.

The credential is read from the environment at the moment of the call. It is
never stored on the instance, so nothing holding a provider holds a secret, and
a rotated key takes effect without a restart.

## What still requires a person

Supplying the credential and approving the data processing are not engineering
steps and are not performed from this repository.

1. **Data-processing review.** Someone accountable for the pilot's privacy
   posture has to agree that classroom text may go to this provider, in this
   region, for this purpose. The manifest records what was reviewed; it does
   not perform the review.
2. **The credential.** It is injected into the deployment environment under the
   name the manifest gives. It is not committed, not pasted into a chat, and
   not handled by anyone building this system.

Until both happen, the health probe reports `unavailable` and the server
answers agent requests with a 503 — which is the correct behaviour, and is
different from the system being broken.

## Media transcoding

ffmpeg is in the worker image, copied as a static binary from an image pinned
by digest in `infra/images.lock.json`. There is no package manager in the
image: the worker's only component that decodes attacker-supplied media should
not be whatever an archive serves on the day of the build.

Verified inside the built image, as the unprivileged runtime user: a WAV goes
in and Opus-in-Ogg comes out. `tests/chaos/worker-container-contract.test.ts`
asserts the pin so an `apt-get` cannot creep back in.

## What this does *not* unlock

Turning the provider on does not make the pilot admissible for a classroom.
That still needs the three signed human records `pnpm verify:pilot` reports:
ethics authorization, the completed teacher shadow, and the student-visibility
promotion. They are separate decisions by separate people, and no amount of
working software substitutes for them.

## Turning Nova on

The executor is injected in `build_supervisor` and reads its provider from the
manifest, so the whole switch is one environment variable plus the credential:

```bash
LO_AGENT_PROVIDER_MANIFEST=/run/learning-orbit/provider-manifest.json
LO_AGENT_PROVIDER_KEY=<injected at deploy; never committed>
```

With the manifest unset, `agent.execute.v1` fails with
`AGENT_PROVIDER_UNCONFIGURED` and retries — the run does not silently fall back
to the deterministic fixture. That fallback would put canned text in front of
students under Nova's name, which they could not tell from a real answer, so it
is not offered.

Each run records an `agent_prompt_artifact` row: the sha256 of exactly what was
sent, the system prompt's own hash, the room-sequence range, the context event
ids, and which manifest was in force. The prompt text is not stored — it is the
room's own events over the recorded range, and a second copy would be one more
place deletion has to reach.
