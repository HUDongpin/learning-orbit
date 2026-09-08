"""The reviewed description of which model provider this worker may call.

A provider is not configured by environment variables scattered through the
process. It is one reviewed file, named by ``LO_AGENT_PROVIDER_MANIFEST``,
whose SHA-256 the server also knows: every health sample and every completion
carries that digest, so a worker running against a provider nobody approved
cannot be mistaken for one that was.

The manifest deliberately contains no secret. Credentials are named, not
carried: the manifest says which environment variable holds the key, and the
value never appears in the file, in a log, or in a health sample.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Mapping

MANIFEST_KEYS = frozenset({
    "schemaVersion", "providerId", "displayName", "modelId", "region",
    "purpose", "maxOutputTokens", "credentialEnvVar", "remoteCopyMode",
})
#: The copy lifecycles the contracts are allowed to *describe*. An external
#: authorization record may name either one, and a contract is permitted to
#: describe more than any single build implements.
REMOTE_COPY_MODES = frozenset({"no_persistent_copy_attested", "delete_and_probe"})
#: The copy lifecycles this build can actually *deliver*, which is the smaller
#: set a manifest is held to.
#:
#: `delete_and_probe` is refused here for one reason only: no delete-and-probe
#: lifecycle exists in this repository. There is no remote delete call, no
#: unreadability probe, and no provider-copy closure record - so a manifest
#: declaring the mode would assert that remote copies are deleted and the
#: deletion proven, while nothing performs either step. The mode is not wrong
#: in principle and the contracts are right to keep describing it.
#:
#: To re-enable it: implement the bounded remote DELETE, the probe that must
#: report the artifact unreadable for a stable invocation id, and the closure
#: record that makes the result durable; then add "delete_and_probe" back to
#: this set. `anthropic.py` reads this same set, so there is one place to edit.
IMPLEMENTED_REMOTE_COPY_MODES = frozenset({"no_persistent_copy_attested"})
PROVIDER_ID = r"^[a-z0-9._-]{1,64}$"


class ProviderManifestError(ValueError):
    """The manifest is absent, malformed, or not one this build may use."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class ProviderManifest:
    provider_id: str
    display_name: str
    model_id: str
    region: str
    purpose: str
    max_output_tokens: int
    credential_env_var: str
    remote_copy_mode: str
    sha256: str

    def credential_present(self, env: Mapping[str, str]) -> bool:
        """True when the named credential is set. Its value is never read here."""
        value = env.get(self.credential_env_var)
        return isinstance(value, str) and len(value) > 0


def _require(condition: bool, code: str) -> None:
    if not condition:
        raise ProviderManifestError(code)


def parse_provider_manifest(raw: bytes) -> ProviderManifest:
    """Validate a manifest and bind it to the digest of its exact bytes."""
    digest = sha256(raw).hexdigest()
    try:
        document: Any = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProviderManifestError("AGENT_PROVIDER_MANIFEST_INVALID") from error
    _require(isinstance(document, dict), "AGENT_PROVIDER_MANIFEST_INVALID")
    _require(set(document) == MANIFEST_KEYS, "AGENT_PROVIDER_MANIFEST_INVALID")
    # `True == 1` in Python but `true !== 1` in JavaScript, so the JSON literal
    # `true` passed here and was refused by the server's own reader - the one
    # place the two manifest readers disagreed about what a manifest is, and
    # the worker was the permissive side. Guarded the way `maxOutputTokens` is.
    version = document["schemaVersion"]
    _require(not isinstance(version, bool) and version == 1, "AGENT_PROVIDER_MANIFEST_VERSION")

    import re

    _require(isinstance(document["providerId"], str)
             and re.fullmatch(PROVIDER_ID, document["providerId"]) is not None,
             "AGENT_PROVIDER_MANIFEST_INVALID")
    for field in ("displayName", "modelId", "region", "purpose", "credentialEnvVar"):
        value = document[field]
        _require(isinstance(value, str) and 0 < len(value) <= 160,
                 "AGENT_PROVIDER_MANIFEST_INVALID")
    _require(re.fullmatch(r"[A-Z][A-Z0-9_]{2,63}", document["credentialEnvVar"]) is not None,
             "AGENT_PROVIDER_MANIFEST_INVALID")
    tokens = document["maxOutputTokens"]
    _require(isinstance(tokens, int) and not isinstance(tokens, bool) and 1 <= tokens <= 8192,
             "AGENT_PROVIDER_MANIFEST_INVALID")
    _require(document["remoteCopyMode"] in REMOTE_COPY_MODES,
             "AGENT_PROVIDER_MANIFEST_REMOTE_COPY_MODE")
    # A described mode is not an implemented one. The two codes stay distinct so
    # a reader can tell "nobody has ever heard of this mode" from "this mode is
    # real and this build does not implement its lifecycle yet".
    _require(document["remoteCopyMode"] in IMPLEMENTED_REMOTE_COPY_MODES,
             "AGENT_PROVIDER_MANIFEST_COPY_MODE_UNIMPLEMENTED")
    # A secret in the manifest would be committed, logged and hashed into the
    # digest the server stores. The credential is named, never carried.
    for value in document.values():
        if isinstance(value, str) and len(value) > 60 and " " not in value:
            raise ProviderManifestError("AGENT_PROVIDER_MANIFEST_SECRET_SUSPECTED")

    return ProviderManifest(
        provider_id=document["providerId"],
        display_name=document["displayName"],
        model_id=document["modelId"],
        region=document["region"],
        purpose=document["purpose"],
        max_output_tokens=tokens,
        credential_env_var=document["credentialEnvVar"],
        remote_copy_mode=document["remoteCopyMode"],
        sha256=digest,
    )


def load_provider_manifest(path: str | Path) -> ProviderManifest:
    target = Path(path)
    if not target.is_absolute():
        raise ProviderManifestError("AGENT_PROVIDER_MANIFEST_PATH_INVALID")
    try:
        raw = target.read_bytes()
    except OSError as error:
        raise ProviderManifestError("AGENT_PROVIDER_MANIFEST_UNREADABLE") from error
    return parse_provider_manifest(raw)
