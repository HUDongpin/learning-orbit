"""Run the provider dry run, and optionally inspect a real manifest, keylessly.

Nothing here is wired into `pnpm verify:pilot` or the required-test gates: this
is the thing a person runs on the day the credential is about to arrive, and in
the hour before that, to turn the switch-on into an observation.

It does two things, both read-only and both offline:

* runs `services/worker/tests/test_provider_dry_run.py`, which drives the real
  manifest loader, the real manifest-selected adapter and the real durable
  executor against a replayed Anthropic Messages stream;
* with `--manifest <absolute path>`, loads *that* file through the same loader
  the worker and the server use, and reports what a deployment needs to know
  before it commits: which adapter it selects, the SHA-256 the server will
  demand in every health sample, and the name - never the value - of the
  environment variable the credential has to appear in.

Two rules this script keeps:

* **It never needs a credential.** Every credential variable this script can
  name - the two in :data:`CREDENTIAL_VARIABLES`, and whichever one the
  inspected manifest names - is removed from the environment before the
  harness runs, so a pass here cannot depend on a key that happens to be set
  on the operator's machine.
* **It never prints one.** The credential value is never read, never copied
  and never echoed; only whether the named variable was set. The manifest
  fields that *are* echoed - providerId, modelId, region, the token ceiling,
  the copy mode and the digest - are the reviewed facts a deployment has to
  check, and none of them is the credential. They are free text all the same:
  the loader refuses any field value longer than 60 characters that contains
  no space, but that is a tripwire against a pasted key rather than a proof
  that none is there, so this output is only ever as trustworthy as the
  manifest that was reviewed. displayName and purpose are not echoed.

Usage:

    .venv/bin/python scripts/provider-dry-run.py
    .venv/bin/python scripts/provider-dry-run.py --manifest /run/learning-orbit/provider-manifest.json
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from typing import Mapping

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKER_SRC = REPO_ROOT / "services" / "worker" / "src"
WORKER_TESTS = REPO_ROOT / "services" / "worker" / "tests"
DRY_RUN_MODULE = "test_provider_dry_run"

#: Cleared before the harness runs. A dry run that passes because a real key is
#: sitting in the shell has proved nothing about the day it is not.
CREDENTIAL_VARIABLES = ("LO_AGENT_PROVIDER_KEY", "ANTHROPIC_API_KEY")

#: What a presence snapshot records in place of a value. Whether the variable
#: was set is the whole question; what it held is never copied.
PRESENT = "set"


def _fail(code: str) -> int:
    sys.stderr.write(code + "\n")
    return 2


def _presence_snapshot(env: Mapping[str, str]) -> dict[str, str]:
    """Which variables were set, and nothing whatsoever about what they hold.

    ``ProviderManifest.credential_present`` asks a mapping whether its named
    variable holds a non-empty string. This records exactly that much of the
    environment - the names with a non-empty value, each mapped to a fixed
    literal - so the answer survives the clearing in :func:`main` without a
    credential value being copied anywhere.
    """
    return {
        name: PRESENT
        for name, value in env.items()
        if isinstance(value, str) and len(value) > 0
    }


def _report_manifest(path: str, present_at_start: Mapping[str, str]) -> tuple[int, str | None]:
    """Describe one real manifest without reading, printing or needing its key.

    ``present_at_start`` is the presence snapshot taken before this process
    cleared anything: the credential question is about the shell the operator
    ran this in, not about a mapping this script emptied on its way there.

    Returns the exit code and, when the file loaded, the variable the manifest
    names - so the caller can clear that one too before the harness runs.
    """
    from learning_orbit_worker.providers.anthropic import ADAPTERS
    from learning_orbit_worker.providers.manifest import (
        ProviderManifestError,
        load_provider_manifest,
    )

    try:
        manifest = load_provider_manifest(path)
    except ProviderManifestError as error:
        # The manifest is the reviewed thing. A file this loader refuses is a
        # file the worker will refuse at boot, said now instead of then. There
        # is no manifest, so there is no named variable to report or to clear.
        return _fail(error.code), None

    implemented = manifest.provider_id in ADAPTERS
    present = manifest.credential_present(present_at_start)
    print("manifest:")
    print(f"  providerId          {manifest.provider_id}")
    print(f"  adapterImplemented  {'yes' if implemented else 'no'}")
    print(f"  modelId             {manifest.model_id}")
    print(f"  region              {manifest.region}")
    print(f"  maxOutputTokens     {manifest.max_output_tokens}")
    print(f"  remoteCopyMode      {manifest.remote_copy_mode}")
    print(f"  sha256              {manifest.sha256}")
    # The name, never the value - and presence as the operator's shell had it,
    # from the snapshot main() took before clearing anything. That clearing
    # keeps the harness keyless; it is not an answer to "is the key set?", and
    # it reaches only the names this script knows to clear, so reading presence
    # from the live environment would report a hardwired "no" for the two in
    # CREDENTIAL_VARIABLES and the truth for every other name.
    print(f"  credentialEnvVar    {manifest.credential_env_var}")
    print(f"  credentialPresent   {'yes' if present else 'no'}")
    if not implemented:
        # No default adapter exists, and this is where that becomes visible.
        return _fail("PROVIDER_NOT_IMPLEMENTED"), manifest.credential_env_var
    return 0, manifest.credential_env_var


def main(argv: list[str]) -> int:
    if argv and (len(argv) != 2 or argv[0] != "--manifest"):
        return _fail("PROVIDER_DRY_RUN_ARGS")

    if not WORKER_SRC.is_dir() or not (WORKER_TESTS / (DRY_RUN_MODULE + ".py")).is_file():
        return _fail("PROVIDER_DRY_RUN_LAYOUT")
    sys.path.insert(0, str(WORKER_SRC))
    sys.path.insert(0, str(WORKER_TESTS))
    # Presence is a fact about the shell this was run in, and the clearing on
    # the next line destroys it. Snapshot which names were set - never what
    # they held - before anything is removed.
    present_at_start = _presence_snapshot(os.environ)
    for name in CREDENTIAL_VARIABLES:
        os.environ.pop(name, None)

    if argv:
        outcome, named = _report_manifest(argv[1], present_at_start)
        if named is not None:
            # A manifest may name a variable CREDENTIAL_VARIABLES does not
            # cover. Presence has been reported; clear that one too, so the
            # harness below runs without any key at all.
            os.environ.pop(named, None)
        if outcome != 0:
            return outcome
        print("")

    suite = unittest.defaultTestLoader.loadTestsFromName(DRY_RUN_MODULE)
    result = unittest.TextTestRunner(verbosity=2, buffer=True).run(suite)
    if not result.wasSuccessful():
        return 1
    if result.testsRun == 0:
        # An empty suite is not a passing one.
        return _fail("PROVIDER_DRY_RUN_EMPTY")
    print(f"\nprovider dry run: PASS ({result.testsRun} cases, no network, no credential)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
