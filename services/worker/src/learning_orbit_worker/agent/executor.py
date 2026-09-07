"""The durable Agent executor: the seam that made every Nova run fail.

``agent.execute.v1`` was registered and delegated to ``deps.agent_executor``,
which nothing ever injected, so every claim of that job raised
``AGENT_EXECUTOR_UNAVAILABLE`` and retried until it died. The handler was right
to refuse - an absent capability is not a success - but the capability had to
exist.

Three things this module refuses to do, each because the alternative is worse
than a failed run:

* **Never substitute a fixture for an unconfigured provider.** Canned text
  presented to students as Nova would be indistinguishable from a real answer.
  No manifest means the run fails with a stated reason.
* **Never invent context.** The events are read from the ledger over the range
  the run recorded, and a run whose range no longer resolves fails rather than
  answering about a different conversation.
* **Never write the answer itself.** The result is posted through the signed
  internal route, so the server's authenticated command remains the only thing
  that turns provider text into a RoomEvent.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Callable, Mapping

from ..generated.agent_internal_command_v1 import Request as AgentCompleteRequest
from ..core_handlers import RetryableJobError, TerminalJobError
from ..handler_registry import HandlerOutcome
from ..providers.anthropic import build_model_provider
from ..providers.fixture import ProviderError
from ..providers.manifest import (
    ProviderManifest,
    ProviderManifestError,
    load_provider_manifest,
)
from ..providers.model import ModelRequest
from .context import AgentContext, build_context
from .contracts import AgentRunState

#: The system prompt is versioned because a change to it changes what the
#: system is, and a stored run has to say which one it was.
PROMPT_VERSION = "socratic-prompt-v1"
SYSTEM_PROMPT = (
    "Ask for evidence; connect views; surface contradictions; "
    "summarize without supplying the answer."
)

_SETTLED = {
    AgentRunState.CANCELLED,
    AgentRunState.COMPLETED,
    AgentRunState.BLOCKED_BY_POLICY,
    AgentRunState.FAILED,
}


def _sha256(text: str) -> str:
    return sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class PromptArtifact:
    """What was sent, recorded as a hash and a provenance range."""

    agent_run_id: str
    room_id: str
    prompt_version: str
    prompt_sha256: str
    system_sha256: str
    context_from_room_seq: int
    context_through_room_seq: int
    context_event_ids: tuple[str, ...]
    approved_artifact_ids: tuple[str, ...]
    model_provider: str
    model_id: str
    provider_manifest_sha256: str
    max_output_tokens: int


def build_prompt_artifact(
    agent_run_id: str,
    context: AgentContext,
    manifest: ProviderManifest,
    *,
    system: str = SYSTEM_PROMPT,
    max_output_tokens: int | None = None,
) -> PromptArtifact:
    rendered = context.rendered
    return PromptArtifact(
        agent_run_id=agent_run_id,
        room_id=context.room_id,
        prompt_version=PROMPT_VERSION,
        # The hash covers the system prompt too: the same conversation asked
        # under different instructions is a different prompt.
        prompt_sha256=_sha256(system + "\n" + rendered),
        system_sha256=_sha256(system),
        context_from_room_seq=context.source_range[0],
        context_through_room_seq=context.source_range[1],
        context_event_ids=tuple(event.event_id for event in context.events),
        approved_artifact_ids=tuple(
            artifact.artifact_id for artifact in context.approved_artifacts if artifact.artifact_id
        ),
        model_provider=manifest.provider_id,
        model_id=manifest.model_id,
        provider_manifest_sha256=manifest.sha256,
        max_output_tokens=max_output_tokens or manifest.max_output_tokens,
    )


INSERT_PROMPT_ARTIFACT = """INSERT INTO agent_prompt_artifact (
    agent_run_id, room_id, prompt_version, prompt_sha256, system_sha256,
    context_from_room_seq, context_through_room_seq, context_event_ids,
    approved_artifact_ids, model_provider, model_id,
    provider_manifest_sha256, max_output_tokens
  ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s::uuid[],%s::uuid[],%s,%s,%s,%s)
  ON CONFLICT (agent_run_id) DO NOTHING"""


def _scalar(row: Any, name: str) -> Any:
    if row is None:
        return None
    if isinstance(row, Mapping):
        return row.get(name)
    return row[0]


def record_prompt_artifact(connection: Any, artifact: PromptArtifact) -> None:
    """Persist the artifact, or prove the stored one is the same prompt.

    A retry of the same run must find its own row and continue. A row with a
    different hash means two different prompts were sent under one run id,
    which nothing downstream could disambiguate, so the attempt stops.
    """
    cursor = connection.execute(
        INSERT_PROMPT_ARTIFACT,
        (
            artifact.agent_run_id,
            artifact.room_id,
            artifact.prompt_version,
            artifact.prompt_sha256,
            artifact.system_sha256,
            artifact.context_from_room_seq,
            artifact.context_through_room_seq,
            list(artifact.context_event_ids),
            list(artifact.approved_artifact_ids),
            artifact.model_provider,
            artifact.model_id,
            artifact.provider_manifest_sha256,
            artifact.max_output_tokens,
        ),
    )
    if getattr(cursor, "rowcount", 0) == 1:
        return
    stored = connection.execute(
        "SELECT prompt_sha256 FROM agent_prompt_artifact WHERE agent_run_id=%s",
        (artifact.agent_run_id,),
    ).fetchone()
    if _scalar(stored, "prompt_sha256") != artifact.prompt_sha256:
        raise TerminalJobError("AGENT_PROMPT_ARTIFACT_CONFLICT")


def load_reviewed_manifest(env: Mapping[str, str] | None = None) -> ProviderManifest:
    """Load the manifest, or fail with a reason a person can act on.

    An unconfigured provider is a stated condition, never a fixture quietly
    standing in for one.
    """
    env = os.environ if env is None else env
    path = env.get("LO_AGENT_PROVIDER_MANIFEST")
    if not path:
        raise RetryableJobError("AGENT_PROVIDER_UNCONFIGURED")
    try:
        return load_provider_manifest(path)
    except ProviderManifestError as error:
        raise TerminalJobError("AGENT_PROVIDER_MANIFEST_" + error.code) from None


class DurableAgentExecutor:
    """Injectable ``deps.agent_executor``: reads the ledger, runs, reports."""

    def __init__(
        self,
        connection: Any,
        internal_http: Any,
        *,
        env: Mapping[str, str] | None = None,
        provider_factory: Callable[[ProviderManifest], Any] | None = None,
        manifest_loader: Callable[[], ProviderManifest] | None = None,
        safety: Callable[[str], Any] | None = None,
        max_context_events: int = 30,
    ) -> None:
        self._connection = connection
        self._internal_http = internal_http
        self._env = os.environ if env is None else env
        self._provider_factory = provider_factory or (
            lambda manifest: build_model_provider(manifest, env=self._env)
        )
        self._manifest_loader = manifest_loader or (lambda: load_reviewed_manifest(self._env))
        self._max_context_events = max_context_events
        self._safety = safety or _default_safety

    def _run_row(self, agent_run_id: str) -> dict[str, Any]:
        row = self._connection.execute(
            """SELECT room_id, state::text AS state, input_from_room_seq,
                      input_through_room_seq
               FROM agent_run WHERE agent_run_id=%s""",
            (agent_run_id,),
        ).fetchone()
        if row is None:
            raise TerminalJobError("AGENT_RUN_ABSENT")
        if isinstance(row, Mapping):
            return dict(row)
        return {
            "room_id": str(row[0]),
            "state": row[1],
            "input_from_room_seq": row[2],
            "input_through_room_seq": row[3],
        }

    def _events(self, room_id: str, through_seq: int) -> list[dict[str, Any]]:
        rows = self._connection.execute(
            """SELECT event_id, room_id, room_seq, type, actor_id, actor_kind,
                      actor_role, revision, operation, event_time, ingest_time,
                      causation_id, correlation_id, payload, schema_version
               FROM room_event WHERE room_id=%s AND room_seq<=%s
               ORDER BY room_seq""",
            (room_id, through_seq),
        ).fetchall()
        events: list[dict[str, Any]] = []
        for row in rows:
            if isinstance(row, Mapping):
                events.append(dict(row))
                continue
            events.append({
                "eventId": str(row[0]), "roomId": str(row[1]), "roomSeq": int(row[2]),
                "type": row[3], "actorId": str(row[4]), "actorKind": row[5],
                "actorRole": row[6], "revision": int(row[7]), "operation": row[8],
                "eventTime": row[9], "ingestTime": row[10],
                "causationId": str(row[11]), "correlationId": str(row[12]),
                "payload": row[13], "schemaVersion": int(row[14]),
            })
        return events

    def __call__(self, *, job: Any, claim: Any) -> HandlerOutcome:
        payload = job.payload if isinstance(job.payload, Mapping) else {}
        agent_run_id = str(payload.get("agentRunId") or "")
        if not agent_run_id:
            raise TerminalJobError("AGENT_JOB_PAYLOAD_INVALID")

        run = self._run_row(agent_run_id)
        if run["state"] in {state.value for state in _SETTLED}:
            # Already settled by cancellation, the reconciler, or a prior
            # attempt. The job is done; re-running would answer a question the
            # room has moved past.
            return HandlerOutcome.SUCCESS
        if str(run["room_id"]) != str(job.room_id):
            raise TerminalJobError("AGENT_RUN_ROOM_MISMATCH")

        manifest = self._manifest_loader()
        through = int(run["input_through_room_seq"])
        try:
            context = build_context(
                str(run["room_id"]),
                self._events(str(run["room_id"]), through),
                through_seq=through,
                max_events=self._max_context_events,
            )
        except ValueError as error:
            # A range that no longer resolves - every message in it retracted,
            # say. Answering about a different conversation would be worse than
            # not answering at all.
            raise TerminalJobError("AGENT_CONTEXT_" + str(error.args[0])) from None

        artifact = build_prompt_artifact(agent_run_id, context, manifest)
        record_prompt_artifact(self._connection, artifact)

        provider = self._provider_factory(manifest)
        request = ModelRequest(
            model_id=manifest.model_id,
            system=SYSTEM_PROMPT,
            messages=({"role": "user", "content": context.rendered},),
            max_output_tokens=artifact.max_output_tokens,
        )
        try:
            call = provider.prepare(request, agent_run_id)
            text = "".join(provider.open_stream(call, cancelled=self._cancellation(job))).strip()
        except ProviderError as error:
            # A provider outage is retryable and a rejected request is not, but
            # both are the run's outcome rather than this worker crashing.
            raise RetryableJobError("AGENT_" + error.code) from None
        if not text:
            raise TerminalJobError("AGENT_OUTPUT_EMPTY")

        decision = self._safety(text)
        if getattr(decision, "action", "allow") == "hold":
            # Held output is never posted, in whole or in part.
            raise TerminalJobError("AGENT_" + decision.reason_codes[0])

        return self._report(job, claim, agent_run_id, text, context, tuple(decision.reason_codes))

    def _cancellation(self, job: Any) -> Callable[[], bool] | None:
        event = getattr(job, "attempt_cancelled", None)
        return (lambda: bool(event.is_set())) if event is not None else None

    def _report(self, job, claim, agent_run_id, text, context, warning_codes) -> HandlerOutcome:
        bounded = text[:4000]
        body = {
            "jobId": job.job_id,
            "jobType": "agent.execute.v1",
            "roomId": job.room_id,
            "sourceEventId": job.source_event_id,
            "dedupeKey": job.dedupe_key,
            "agentRunId": agent_run_id,
            "correlationId": job.correlation_id,
            "claimGeneration": str(job.claim_generation),
            "claimToken": job.claim_token,
            "workerId": getattr(claim, "worker_id", None) or getattr(claim, "locked_by", ""),
            "text": bounded,
            # The hash covers what is actually sent, so a truncated answer
            # cannot be checked against the untruncated one and pass.
            "outputSha256": _sha256(bounded),
            "sourceEventIds": [event.event_id for event in context.events],
            "warningCodes": list(warning_codes)[:10],
        }
        # Parsed through the generated closed contract before it is signed, so
        # a body the server would reject never becomes a signed assertion.
        AgentCompleteRequest.from_dict(body)
        response = self._internal_http.post(
            "/internal/agent/complete", "internal.agent.complete", body, claim,
        )
        result = response.body if isinstance(response.body, Mapping) else {}
        status = result.get("status")
        if status in {"applied", "already_applied"}:
            return HandlerOutcome.SUCCESS
        if result.get("code") == "JOB_CLAIM_STALE":
            return HandlerOutcome.LOST_LEASE
        raise RetryableJobError("AGENT_COMPLETE_" + str(result.get("code", "REJECTED")))


def _default_safety(text: str) -> Any:
    from ..safety.policy import evaluate_agent_output

    return evaluate_agent_output(text, policy_version="socratic-policy-v1")
