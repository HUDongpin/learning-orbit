# When Nova stops working

The classroom does not depend on Nova. Chat, the event ledger, projections and
deletion all continue whether or not the agent answers, and every failure below
is designed to stop at the agent rather than spread. That is the first thing to
tell a teacher who reports it: the lesson is not broken.

The second thing is that a room with a dead agent should say so. If a teacher
is waiting on an answer that will never arrive, the failure has already reached
the classroom even though nothing crashed.

## Reading the state

```bash
psql "$DATABASE_URL" -c "SELECT provider_id, health, reason_code, checked_at
                         FROM agent_provider_health ORDER BY checked_at DESC LIMIT 5"
psql "$DATABASE_URL" -c "SELECT state, count(*) FROM agent_run
                         WHERE created_at > now() - interval '1 hour' GROUP BY state"
psql "$DATABASE_URL" -c "SELECT job_type, status, last_error, count(*)
                         FROM worker_job WHERE job_type='agent.execute.v1'
                         GROUP BY 1,2,3 ORDER BY 4 DESC"
```

Runs stuck in `queued` with no matching `worker_job` row mean the trigger
wrote a run and no job; runs in `running` with a dead job mean the reconciler
has not swept yet. It runs every 30 seconds and settles both cases.

## The failures, and what each one means

### `AGENT_PROVIDER_UNCONFIGURED`

No manifest is set. The run fails and retries, and it will keep failing until
`LO_AGENT_PROVIDER_MANIFEST` points at a reviewed manifest and the credential
it names is present.

This is not a bug and there is no fallback. A deterministic fixture standing in
for the provider would put canned text in front of students under Nova's name,
which they could not tell from a real answer. See
[model-provider.md](model-provider.md).

### `AGENT_PROVIDER_CREDENTIAL_REJECTED`

The key is wrong, expired or revoked. Rotate it in the deployment environment
under the name the manifest gives. No restart is needed — the credential is
read at the moment of each call.

### `AGENT_PROVIDER_RATE_LIMITED` / `AGENT_PROVIDER_OVERLOADED`

The provider is throttling. Runs retry with backoff and reach `dead` after
`max_attempts`. Nothing to do at 3 runs; at 30, the pilot is asking for more
than the account allows and the trigger rate is the thing to change, not the
retry policy.

### `AGENT_PROVIDER_UNREACHABLE`

Network or DNS. Check whether the worker can reach the provider at all; the
adapter refuses plaintext endpoints, so a proxy that terminates TLS will fail
here rather than downgrade.

### `AGENT_SAFETY_*`

The safety policy held the output. **This is the system working.** The run is
settled `blocked_by_policy`, nothing is posted to the room, and nothing partial
reaches a student. Investigate the pattern if it becomes common; do not relax
the policy to make a room quieter.

### `AGENT_CONTEXT_NO_ACTIVE_CONTEXT`

Every message in the run's range was retracted before the worker got to it. The
run fails rather than answering about a different conversation. Expected after
a teacher retracts a thread; not expected otherwise.

### `AGENT_EXECUTOR_UNAVAILABLE`

The worker is running a build with no executor injected. This should be
impossible in a deployed image — `tests/chaos` and the worker suite both assert
the composition root injects one — so treat it as a wrong-artifact deployment
rather than a runtime fault.

## Turning Nova off

A teacher can disable the agent per room, which cancels any active run. That is
the right first move during a lesson: it is instant, scoped, and reversible.
Do not stop the worker to stop the agent — the worker also runs analytics,
media and deletion, and stopping it converts an agent outage into a deletion
outage.

## What must keep working during any of the above

If any of these stop, the incident is no longer about Nova:

- Students can send and see messages; room sequence stays contiguous.
- The event ledger keeps committing; the outbox drains once delivery recovers.
- Teacher deletion still completes and still issues a receipt.
- No provider text reaches a room except through the server's authenticated
  command — an agent failure must never produce a partial or unattributed
  message.

`tests/chaos` covers the first two under process loss; the deletion saga covers
the third.
