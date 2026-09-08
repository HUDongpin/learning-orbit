"""The durable Agent executor: context, prompt artifact, safety, reporting."""
import json
import re
import tempfile
import unittest
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

from learning_orbit_worker.agent.executor import (
    DurableAgentExecutor,
    build_prompt_artifact,
    load_reviewed_manifest,
    record_prompt_artifact,
)
from learning_orbit_worker.agent.context import build_context
from learning_orbit_worker.core_handlers import RetryableJobError, TerminalJobError
from learning_orbit_worker.handler_registry import HandlerOutcome
from learning_orbit_worker.internal_http import InternalResponse
from learning_orbit_worker.jobs import JobStore, WorkerJob
from learning_orbit_worker.providers.fixture import ProviderError
from learning_orbit_worker.providers.manifest import parse_provider_manifest

ROOM = str(uuid4())
RUN = str(uuid4())
JOB = str(uuid4())
TRIGGER = str(uuid4())
CORRELATION = str(uuid4())
CLAIM_TOKEN = str(uuid4())

MANIFEST_DOCUMENT = {
    "schemaVersion": 1,
    "providerId": "anthropic-messages-v1",
    "displayName": "Anthropic Messages",
    "modelId": "claude-sonnet-5",
    "region": "us",
    "purpose": "socratic facilitation for a controlled classroom pilot",
    "maxOutputTokens": 512,
    "credentialEnvVar": "LO_AGENT_PROVIDER_KEY",
    "remoteCopyMode": "no_persistent_copy_attested",
}
MANIFEST = parse_provider_manifest(json.dumps(MANIFEST_DOCUMENT).encode("utf-8"))


def message(seq: int, text: str, event_id=None) -> dict:
    return {
        "eventId": event_id or str(uuid4()), "roomId": ROOM, "roomSeq": seq,
        "type": "message.added", "actorId": str(uuid4()), "actorKind": "human",
        "actorRole": "student", "revision": 1, "operation": "add",
        "eventTime": "2026-09-07T10:00:00Z", "ingestTime": "2026-09-07T10:00:00Z",
        "causationId": str(uuid4()), "correlationId": CORRELATION,
        "payload": {"messageId": str(uuid4()), "text": text}, "schemaVersion": 1,
    }


class FakeCursor:
    def __init__(self, rows, rowcount=None):
        self._rows = rows
        self.rowcount = len(rows) if rowcount is None else rowcount

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class FakeConnection:
    """Answers only the queries the executor is expected to make."""

    def __init__(self, *, run_state="queued", events=None, stored_prompt=None, through=2):
        self.run_state = run_state
        self.events = events if events is not None else [message(1, "分解者把落葉變成土壤"), message(2, "那沒有牠們會怎樣？")]
        self.stored_prompt = stored_prompt
        self.through = through
        self.inserted = []
        self.queries = []

    def execute(self, sql, params=()):
        self.queries.append(sql)
        if "FROM agent_run" in sql:
            return FakeCursor([{
                "room_id": ROOM, "state": self.run_state,
                "input_from_room_seq": 1, "input_through_room_seq": self.through,
            }])
        if "FROM room_event" in sql:
            return FakeCursor(self.events)
        if sql.startswith("INSERT INTO agent_prompt_artifact"):
            if self.stored_prompt is not None:
                return FakeCursor([], rowcount=0)
            self.inserted.append(params)
            self.stored_prompt = params[3]
            return FakeCursor([], rowcount=1)
        if "SELECT prompt_sha256" in sql:
            return FakeCursor([{"prompt_sha256": self.stored_prompt}])
        raise AssertionError("unexpected query: " + sql[:60])


class FakeProvider:
    provider_id = "anthropic-messages-v1"

    def __init__(self, chunks=("你觀察到什麼？",), error=None):
        self.chunks = chunks
        self.error = error
        self.prepared = []

    def prepare(self, request, invocation_id):
        if self.error:
            raise self.error
        self.prepared.append((request, invocation_id))
        return request

    def open_stream(self, call, *, cancelled=None):
        return iter(self.chunks)


class FakeInternalHttp:
    def __init__(self, body=None):
        self.body = body if body is not None else {"status": "applied", "eventId": str(uuid4())}
        self.posts = []

    def post(self, path, audience, body, claim):
        self.posts.append({"path": path, "audience": audience, "body": body})
        return InternalResponse(200, self.body)


class Job:
    payload = {"agentRunId": RUN}
    job_id = JOB
    job_type = "agent.execute.v1"
    room_id = ROOM
    source_event_id = TRIGGER
    dedupe_key = "agent.execute.v1:" + RUN
    correlation_id = CORRELATION
    claim_generation = "1"
    claim_token = CLAIM_TOKEN
    attempt_cancelled = None


class Claim:
    worker_id = "worker-1"


class Allowed:
    action = "allow"
    reason_codes = ()


class Held:
    action = "hold"
    reason_codes = ("SAFETY_DIRECT_ANSWER",)


def executor(connection, provider=None, http=None, safety=None, **kwargs):
    return DurableAgentExecutor(
        connection, http or FakeInternalHttp(),
        manifest_loader=lambda: MANIFEST,
        provider_factory=lambda _manifest: provider or FakeProvider(),
        safety=safety or (lambda _text: Allowed()),
        **kwargs,
    )


class PromptArtifactTest(unittest.TestCase):
    def context(self):
        return build_context(ROOM, FakeConnection().events, through_seq=2)

    def test_records_a_hash_and_a_range_rather_than_the_prompt(self) -> None:
        artifact = build_prompt_artifact(RUN, self.context(), MANIFEST)
        self.assertEqual(artifact.context_from_room_seq, 1)
        self.assertEqual(artifact.context_through_room_seq, 2)
        self.assertEqual(len(artifact.context_event_ids), 2)
        # The prompt itself is the room's own events. Storing it again would
        # create a second content store that deletion has to find.
        for field in artifact.__slots__:
            self.assertNotIn("分解者", str(getattr(artifact, field)))

    def test_the_same_conversation_under_a_different_system_prompt_is_a_different_prompt(self) -> None:
        a = build_prompt_artifact(RUN, self.context(), MANIFEST)
        b = build_prompt_artifact(RUN, self.context(), MANIFEST, system="Just answer the question.")
        self.assertNotEqual(a.prompt_sha256, b.prompt_sha256)
        self.assertNotEqual(a.system_sha256, b.system_sha256)

    def test_a_retry_of_the_same_run_finds_its_own_row_and_continues(self) -> None:
        connection = FakeConnection()
        artifact = build_prompt_artifact(RUN, self.context(), MANIFEST)
        record_prompt_artifact(connection, artifact)
        record_prompt_artifact(connection, artifact)
        self.assertEqual(len(connection.inserted), 1)

    def test_a_second_different_prompt_under_one_run_id_stops_the_attempt(self) -> None:
        connection = FakeConnection(stored_prompt="f" * 64)
        with self.assertRaises(TerminalJobError) as raised:
            record_prompt_artifact(connection, build_prompt_artifact(RUN, self.context(), MANIFEST))
        self.assertIn("AGENT_PROMPT_ARTIFACT_CONFLICT", str(raised.exception))


class ExecutionTest(unittest.TestCase):
    def test_reads_the_ledger_runs_and_reports_through_the_signed_route(self) -> None:
        connection = FakeConnection()
        http = FakeInternalHttp()
        provider = FakeProvider(("你觀察到", "什麼？"))
        outcome = executor(connection, provider, http)(job=Job(), claim=Claim())

        self.assertIs(outcome, HandlerOutcome.SUCCESS)
        self.assertEqual(len(http.posts), 1)
        post = http.posts[0]
        self.assertEqual(post["path"], "/internal/agent/complete")
        self.assertEqual(post["audience"], "internal.agent.complete")
        self.assertEqual(post["body"]["text"], "你觀察到什麼？")
        self.assertEqual(
            post["body"]["outputSha256"],
            sha256("你觀察到什麼？".encode("utf-8")).hexdigest(),
        )
        # Provenance travels with the answer: which events it was given.
        self.assertEqual(len(post["body"]["sourceEventIds"]), 2)
        self.assertEqual(post["body"]["agentRunId"], RUN)

    def test_the_prompt_carries_the_room_events_and_nothing_else(self) -> None:
        provider = FakeProvider()
        executor(FakeConnection(), provider)(job=Job(), claim=Claim())
        request, invocation = provider.prepared[0]
        self.assertEqual(invocation, RUN)
        self.assertEqual(request.model_id, "claude-sonnet-5")
        self.assertEqual(request.max_output_tokens, 512)
        self.assertIn("分解者", request.messages[0]["content"])

    def test_an_unconfigured_provider_never_becomes_a_fixture(self) -> None:
        # Canned text presented to students as Nova would be indistinguishable
        # from a real answer, so no manifest means no run.
        with self.assertRaises(RetryableJobError) as raised:
            load_reviewed_manifest({})
        self.assertIn("AGENT_PROVIDER_UNCONFIGURED", str(raised.exception))

    def test_a_settled_run_is_not_run_again(self) -> None:
        for state in ("cancelled", "completed", "blocked_by_policy", "failed"):
            connection = FakeConnection(run_state=state)
            http = FakeInternalHttp()
            outcome = executor(connection, http=http)(job=Job(), claim=Claim())
            self.assertIs(outcome, HandlerOutcome.SUCCESS)
            self.assertEqual(http.posts, [], state)

    def test_a_run_pointing_at_another_room_is_refused(self) -> None:
        connection = FakeConnection()
        connection.execute = lambda sql, params=(): FakeCursor([{
            "room_id": str(uuid4()), "state": "queued",
            "input_from_room_seq": 1, "input_through_room_seq": 2,
        }])
        with self.assertRaises(TerminalJobError) as raised:
            executor(connection)(job=Job(), claim=Claim())
        self.assertIn("AGENT_RUN_ROOM_MISMATCH", str(raised.exception))

    def test_a_range_that_no_longer_resolves_fails_rather_than_answering(self) -> None:
        # Every message retracted: answering about a different conversation
        # would be worse than not answering.
        connection = FakeConnection(events=[])
        with self.assertRaises(TerminalJobError) as raised:
            executor(connection)(job=Job(), claim=Claim())
        self.assertIn("AGENT_CONTEXT_NO_ACTIVE_CONTEXT", str(raised.exception))

    def test_held_output_is_never_posted_even_in_part(self) -> None:
        http = FakeInternalHttp()
        with self.assertRaises(TerminalJobError) as raised:
            executor(FakeConnection(), http=http, safety=lambda _t: Held())(job=Job(), claim=Claim())
        self.assertIn("AGENT_SAFETY_DIRECT_ANSWER", str(raised.exception))
        self.assertEqual(http.posts, [])

    def test_an_empty_answer_is_not_reported_as_one(self) -> None:
        http = FakeInternalHttp()
        with self.assertRaises(TerminalJobError) as raised:
            executor(FakeConnection(), FakeProvider(("   ",)), http)(job=Job(), claim=Claim())
        self.assertIn("AGENT_OUTPUT_EMPTY", str(raised.exception))
        self.assertEqual(http.posts, [])

    def test_a_provider_failure_is_the_runs_outcome_not_a_crash(self) -> None:
        provider = FakeProvider(error=ProviderError("PROVIDER_RATE_LIMITED"))
        with self.assertRaises(RetryableJobError) as raised:
            executor(FakeConnection(), provider)(job=Job(), claim=Claim())
        self.assertIn("AGENT_PROVIDER_RATE_LIMITED", str(raised.exception))

    def test_a_stale_claim_reported_by_the_server_loses_the_lease(self) -> None:
        http = FakeInternalHttp({"status": "rejected", "code": "JOB_CLAIM_STALE"})
        outcome = executor(FakeConnection(), http=http)(job=Job(), claim=Claim())
        self.assertIs(outcome, HandlerOutcome.LOST_LEASE)

    def test_an_already_applied_result_is_success_not_a_duplicate(self) -> None:
        http = FakeInternalHttp({"status": "already_applied", "eventId": str(uuid4())})
        outcome = executor(FakeConnection(), http=http)(job=Job(), claim=Claim())
        self.assertIs(outcome, HandlerOutcome.SUCCESS)

    def test_a_job_without_a_run_id_is_refused_before_anything_is_read(self) -> None:
        class Bare(Job):
            payload = {}

        connection = FakeConnection()
        with self.assertRaises(TerminalJobError):
            executor(connection)(job=Bare(), claim=Claim())
        self.assertEqual(connection.queries, [])


class RecordingJobDb:
    """The narrowest connection double ``JobStore.fail`` will accept.

    It answers the claim predicate, reports no business receipt so the failure
    path is the one taken, and keeps the ``last_error`` parameter of the real
    UPDATE - the exact string the row would hold.
    """

    def __init__(self) -> None:
        self.last_error = None

    def execute(self, sql, params=()):
        text = " ".join(sql.split())
        if text.startswith("SELECT 1 FROM worker_job"):
            return FakeCursor([{"one": 1}], rowcount=1)
        if text.startswith("SELECT claim_token_hash"):
            return FakeCursor([], rowcount=0)
        if text.startswith("UPDATE worker_job SET status ="):
            self.last_error = params[0]
            return FakeCursor([{"status": "dead"}], rowcount=1)
        return FakeCursor([], rowcount=0)


def failing_job() -> WorkerJob:
    return WorkerJob(
        job_id=JOB, job_type="agent.execute.v1", room_id=ROOM,
        source_event_id=TRIGGER, dedupe_key="agent.execute.v1:" + RUN,
        payload={"agentRunId": RUN}, attempts=1, correlation_id=CORRELATION,
        locked_by="worker-1", claim_generation="1", claim_token=CLAIM_TOKEN,
    )


def manifest_bytes(**overrides) -> bytes:
    return json.dumps({**MANIFEST_DOCUMENT, **overrides}).encode("utf-8")


class ProviderManifestErrorCodeTest(unittest.TestCase):
    """A manifest fault must reach the job row under its own name.

    ``load_reviewed_manifest`` used to raise
    ``"AGENT_PROVIDER_MANIFEST_" + error.code`` over a ``ProviderManifestError``
    code that already began with that prefix. Six of the seven codes reached
    ``worker_job.last_error`` doubled, and the longest -
    ``AGENT_PROVIDER_MANIFEST_COPY_MODE_UNIMPLEMENTED`` at 47 characters - grew
    to 71, failed the job layer's ``[A-Z0-9_]{1,64}`` bound and was coerced to
    the anonymous ``JOB_HANDLER_FAILED``. The manifest fault a person most needs
    named was the one the row could not say.

    Every case here writes a real manifest file and reads it back through the
    real ``load_reviewed_manifest``, then carries the raised error into the real
    ``JobStore.fail``: the assertion is on the string that genuinely lands in
    the row, not on one an injected ``manifest_loader`` was handed.
    """

    #: The job layer's bound, restated so a regression in either place is loud.
    JOB_CODE = re.compile(r"[A-Z0-9_]{1,64}")

    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)

    def write_manifest(self, name: str, raw: bytes) -> str:
        """One file per case: every case is loaded from its own bytes."""
        path = self.directory / (name + ".json")
        path.write_bytes(raw)
        return str(path)

    def last_error_for(self, path: str) -> str:
        """Load through the real path and report what the row would hold."""
        with self.assertRaises(TerminalJobError) as raised:
            load_reviewed_manifest({"LO_AGENT_PROVIDER_MANIFEST": path})
        db = RecordingJobDb()
        JobStore(db, "worker-1").fail(failing_job(), raised.exception)
        return db.last_error

    def cases(self) -> dict:
        absent = self.directory / "never-written.json"
        return {
            "AGENT_PROVIDER_MANIFEST_INVALID":
                self.write_manifest("malformed", b"{ not json"),
            "AGENT_PROVIDER_MANIFEST_VERSION":
                self.write_manifest("version", manifest_bytes(schemaVersion=2)),
            "AGENT_PROVIDER_MANIFEST_REMOTE_COPY_MODE":
                self.write_manifest("unknown-mode", manifest_bytes(remoteCopyMode="teleported")),
            "AGENT_PROVIDER_MANIFEST_COPY_MODE_UNIMPLEMENTED":
                self.write_manifest("unimplemented-mode", manifest_bytes(remoteCopyMode="delete_and_probe")),
            "AGENT_PROVIDER_MANIFEST_SECRET_SUSPECTED":
                self.write_manifest("secret-shaped", manifest_bytes(purpose="s" * 61)),
            "AGENT_PROVIDER_MANIFEST_PATH_INVALID": "relative/provider-manifest.json",
            "AGENT_PROVIDER_MANIFEST_UNREADABLE": str(absent),
        }

    def test_every_manifest_code_reaches_the_job_row_intact(self) -> None:
        for expected, path in self.cases().items():
            with self.subTest(code=expected):
                self.assertEqual(self.last_error_for(path), expected)

    def test_no_manifest_code_is_coerced_away_by_the_job_bound(self) -> None:
        # The failure this guards is silent: an over-long code is not rejected,
        # it is replaced, and the row then blames the handler for a fault that
        # was the deployment's manifest.
        for expected, path in self.cases().items():
            with self.subTest(code=expected):
                landed = self.last_error_for(path)
                self.assertNotEqual(landed, "JOB_HANDLER_FAILED")
                self.assertLessEqual(len(landed), 64)
                self.assertIsNotNone(self.JOB_CODE.fullmatch(landed))

    def test_the_manifest_prefix_is_never_doubled(self) -> None:
        for expected, path in self.cases().items():
            with self.subTest(code=expected):
                landed = self.last_error_for(path)
                self.assertEqual(landed.count("AGENT_PROVIDER_MANIFEST_"), 1)

    def test_the_executors_own_loader_carries_the_code_unqualified(self) -> None:
        # No injected ``manifest_loader``: this is the path a deployed worker
        # takes, so the executor's default loader is the one under test.
        path = self.write_manifest(
            "executor-default-loader", manifest_bytes(remoteCopyMode="delete_and_probe"),
        )
        run = DurableAgentExecutor(
            FakeConnection(), FakeInternalHttp(),
            env={"LO_AGENT_PROVIDER_MANIFEST": path},
            provider_factory=lambda _manifest: FakeProvider(),
            safety=lambda _text: Allowed(),
        )
        with self.assertRaises(TerminalJobError) as raised:
            run(job=Job(), claim=Claim())
        self.assertEqual(
            raised.exception.code, "AGENT_PROVIDER_MANIFEST_COPY_MODE_UNIMPLEMENTED",
        )


class HandlerWiringTest(unittest.TestCase):
    """The handler refused every agent job because nothing injected an executor."""

    def _deps(self, executor_value):
        from learning_orbit_worker.handler_registry import WorkerDeps

        class Store:
            job_claims = None

        deps = WorkerDeps.__new__(WorkerDeps)
        object.__setattr__(deps, "db", None)
        object.__setattr__(deps, "jobs", Store())
        object.__setattr__(deps, "claim", Claim())
        object.__setattr__(deps, "agent_executor", executor_value)
        return deps

    def test_an_absent_executor_is_still_never_treated_as_success(self) -> None:
        from learning_orbit_worker.pipeline_handlers import agent_execute_handler

        with self.assertRaises(RetryableJobError) as raised:
            agent_execute_handler(self._deps(None), Job())
        self.assertIn("AGENT_EXECUTOR_UNAVAILABLE", str(raised.exception))

    def test_the_injected_executor_runs_the_job_through_the_handler(self) -> None:
        from learning_orbit_worker.pipeline_handlers import agent_execute_handler

        http = FakeInternalHttp()
        outcome = agent_execute_handler(
            self._deps(executor(FakeConnection(), http=http)), Job(),
        )
        self.assertIs(outcome, HandlerOutcome.SUCCESS)
        self.assertEqual(len(http.posts), 1)

    def test_the_composition_root_injects_one(self) -> None:
        import inspect

        from learning_orbit_worker import main

        source = inspect.getsource(main.build_supervisor)
        self.assertIn("agent_executor=DurableAgentExecutor(", source)


if __name__ == "__main__":
    unittest.main()
