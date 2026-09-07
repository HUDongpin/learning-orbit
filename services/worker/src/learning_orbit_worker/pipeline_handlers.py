"""Fail-closed seams for media and Agent job families.

The worker owns claiming and settlement, while domain mutations remain behind
an injected capability or signed server route.  In particular, a missing
provider/processor cannot accidentally produce a successful durable receipt.
"""
from __future__ import annotations

from typing import Any, Mapping

from .handler_registry import HandlerOutcome, WorkerDeps
from .internal_http import InternalHttpError
from .jobs import WorkerJob
from .core_handlers import RetryableJobError, TerminalJobError


def _payload(job: WorkerJob) -> Mapping[str, Any]:
    if not isinstance(job.payload, Mapping):
        raise TerminalJobError("JOB_PAYLOAD_INVALID")
    return job.payload


def media_process_handler(deps: WorkerDeps, job: WorkerJob) -> HandlerOutcome:
    payload = _payload(job)
    media_id = payload.get("mediaId")
    if not isinstance(media_id, str) or set(payload) != {"mediaId"} or not job.room_id:
        raise TerminalJobError("MEDIA_JOB_PAYLOAD_INVALID")
    processor = deps.media_processor
    if not callable(processor):
        raise RetryableJobError("MEDIA_PROCESSOR_UNAVAILABLE")
    # The job travels with the call because the outcome is reported through
    # the signed route, and that body is bound to this claim.
    result = processor(media_id=media_id, room_id=job.room_id, claim=deps.claim, job=job)
    if result is HandlerOutcome.LOST_LEASE or result == HandlerOutcome.LOST_LEASE:
        return HandlerOutcome.LOST_LEASE
    if result is not HandlerOutcome.SUCCESS and result != HandlerOutcome.SUCCESS:
        raise RetryableJobError("MEDIA_PROCESS_NOT_SETTLED")
    return HandlerOutcome.SUCCESS


def media_reconcile_upload_handler(deps: WorkerDeps, job: WorkerJob) -> HandlerOutcome:
    payload = _payload(job)
    media_id = payload.get("mediaId")
    if not isinstance(media_id, str) or set(payload) != {"mediaId"} or not job.room_id or deps.claim is None:
        raise TerminalJobError("MEDIA_JOB_PAYLOAD_INVALID")
    if deps.internal_http is None:
        raise RetryableJobError("INTERNAL_HTTP_UNAVAILABLE")
    claim = deps.claim
    body = {
        "jobId": claim.job_id, "jobType": claim.job_type,
        "roomId": claim.room_id, "sourceEventId": claim.source_event_id,
        "dedupeKey": claim.dedupe_key, "mediaId": media_id,
        "correlationId": claim.correlation_id,
        "claimGeneration": claim.claim_generation,
        "claimToken": claim.claim_token, "workerId": claim.worker_id,
    }
    try:
        response = deps.internal_http.post(
            "/internal/media/reconcile-upload",
            "internal.media.reconcileUpload", body, claim,
        )
    except InternalHttpError as error:
        if error.code in {"INTERNAL_HTTP_TIMEOUT", "INTERNAL_HTTP_TRANSPORT", "INTERNAL_HTTP_STATUS"}:
            raise RetryableJobError("MEDIA_RECONCILE_RETRYABLE") from error
        raise TerminalJobError("MEDIA_RECONCILE_REJECTED") from error
    result = response.body
    status, code = result.get("status"), result.get("code")
    if status == "completed" and code in {"PROMOTION_COMMITTED", "ALREADY_PROMOTED", "PROMOTION_ABANDONED", "PROMOTION_IDENTITY_MISMATCH"}:
        return HandlerOutcome.SUCCESS
    if status == "retryable" and code == "PROMOTION_NOT_SETTLED":
        raise RetryableJobError("PROMOTION_NOT_SETTLED")
    if status == "rejected" and code == "JOB_CLAIM_STALE":
        return HandlerOutcome.LOST_LEASE
    raise TerminalJobError("MEDIA_RECONCILE_RESPONSE_INVALID")


def agent_execute_handler(deps: WorkerDeps, job: WorkerJob) -> HandlerOutcome:
    if not isinstance(job.payload, Mapping) or not job.room_id or deps.claim is None:
        raise TerminalJobError("AGENT_JOB_PAYLOAD_INVALID")
    executor = deps.agent_executor
    if not callable(executor):
        raise RetryableJobError("AGENT_EXECUTOR_UNAVAILABLE")
    result = executor(job=job, claim=deps.claim)
    if result is HandlerOutcome.LOST_LEASE or result == HandlerOutcome.LOST_LEASE:
        return HandlerOutcome.LOST_LEASE
    if result is not HandlerOutcome.SUCCESS and result != HandlerOutcome.SUCCESS:
        raise RetryableJobError("AGENT_EXECUTION_NOT_SETTLED")
    return HandlerOutcome.SUCCESS


def register_pipeline_handlers(registry: Any) -> Any:
    registry.register("media.process.v1", media_process_handler)
    registry.register("media.reconcile-upload.v1", media_reconcile_upload_handler)
    registry.register("agent.execute.v1", agent_execute_handler)
    return registry


__all__ = ["agent_execute_handler", "media_process_handler", "media_reconcile_upload_handler", "register_pipeline_handlers"]
