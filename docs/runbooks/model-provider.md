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

## What this does *not* unlock

Turning the provider on does not make the pilot admissible for a classroom.
That still needs the three signed human records `pnpm verify:pilot` reports:
ethics authorization, the completed teacher shadow, and the student-visibility
promotion. They are separate decisions by separate people, and no amount of
working software substitutes for them.
