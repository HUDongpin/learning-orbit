#!/usr/bin/env bash
#
# Gate 3: the analytics evidence bundle, as one command.
#
# The suites below already existed and were each runnable on their own, which
# is precisely the problem this script solves: "analytics is green" was a claim
# nobody could reproduce in one step, because it meant remembering seven
# commands and the order they had to run in.  Running this twice must produce
# the same result, and it ends by asserting the worker left no dead job behind
# — a suite can pass while quietly parking work it could not finish.
#
# Usage: pnpm analytics:gate3
set -euo pipefail

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository"

fail() { printf 'analytics:gate3: FAIL %s\n' "$1" >&2; exit 1; }
step() { printf '\n--- %s\n' "$1"; }

# The virtualenv is the Plan 01-owned one; the gate never creates or upgrades
# it, because a gate that repairs its own environment stops measuring it.
test -x .venv/bin/python || fail "PYTHON_VENV_ABSENT"
.venv/bin/python - <<'PY' || fail "PYTHON_VERSION_UNSUPPORTED"
import sys
assert sys.version_info[:2] == (3, 12), sys.version
PY

# A database is required and must not be the one anything cares about: this
# gate truncates business tables between suites.
: "${TEST_DATABASE_URL:?analytics:gate3 requires TEST_DATABASE_URL}"

step "contracts"
pnpm --filter @learning-orbit/contracts generate
pnpm --filter @learning-orbit/contracts test

step "migrations"
pnpm db:migrate:test

step "server analytics surfaces"
pnpm --filter @learning-orbit/server exec vitest run \
  test/analytics test/db/schema.test.ts test/governance/migration-shape.test.ts

step "worker analytics pipeline"
.venv/bin/python -m unittest discover -s services/worker/tests -t services/worker

step "dead jobs"
# `psql` is not assumed: the same question is asked through the connection
# string the suites themselves used.
.venv/bin/python - <<'PY' || fail "WORKER_DEAD_JOBS_PRESENT"
import os
import sys

try:
    import psycopg
except ImportError:
    sys.stderr.write("analytics:gate3: psycopg missing; cannot check dead jobs\n")
    raise SystemExit(1)

with psycopg.connect(os.environ["TEST_DATABASE_URL"], autocommit=True) as connection:
    rows = connection.execute(
        "SELECT job_type, status, last_error FROM worker_job WHERE status='dead' ORDER BY created_at",
    ).fetchall()

for job_type, status, last_error in rows:
    sys.stderr.write(f"dead job: {job_type} {status} {last_error}\n")
raise SystemExit(1 if rows else 0)
PY

printf '\nanalytics:gate3: PASS\n'
