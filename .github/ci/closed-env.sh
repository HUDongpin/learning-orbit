#!/usr/bin/env bash
#
# Run a command under the same closed environment the pilot harness gives its
# gates, and nothing more.
#
# This exists because four of the seven defects fixed this week were gates that
# passed only on a machine that happened to carry extra state: a developer's
# `.env` exported into their shell satisfied a `${VAR:?}` the harness does not
# supply, and an editable `pip install -e services/worker` made an import work
# that the code never asked for. Both were invisible to `pnpm test` at a
# workstation and fatal inside the harness, whose gates see only the variables
# listed below.
#
# The list is a transcription of `closedBaseEnvironment()` in
# scripts/verify-local-pilot.mjs:68 - the pass-through names, then the fixed
# assignments. If that function changes, this must change with it; there is no
# import that could keep them in step, so the line number is cited instead.
#
# The four repository variables the harness's `required-tests` stage adds on top
# (scripts/verify-local-pilot.mjs:587-592) plus the analytics key its
# `worker-python` gate adds (line 631) are forwarded only when the caller has
# already set them, so a step that needs no database is not handed one.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: closed-env.sh <command> [args...]" >&2
  exit 2
fi

closed=()

# PATH is the one pass-through the harness rebuilds rather than copies: it
# prepends the directories of the Node and pnpm binaries it resolved. On a
# runner both already sit on PATH because the setup actions put them there, so
# copying PATH is the same set - and copying it is what keeps `docker`, `git`
# and the toolchain reachable for the suites that shell out to them.
closed+=("PATH=$PATH")

# HOME is on the harness's pass-through list and everything from pnpm's store
# to pip's cache is anchored to it, so an unset HOME is a broken run, not a
# closed one.
closed+=("HOME=$HOME")

# Optional pass-throughs. The harness copies each only when the base
# environment carries a non-empty value, and so does this: forwarding an empty
# DOCKER_HOST is not the same as not forwarding it.
#
# LD_LIBRARY_PATH is the one name here the harness does not list, and it is a
# platform difference rather than a relaxation. The harness runs on macOS
# against a self-contained uv CPython; a Linux runner installs a shared-library
# build whose interpreter finds `libpython3.12.so` through the dynamic loader's
# search path. Dropping it would not close the environment, it would stop
# Python from starting at all. It is a loader path and nothing else: it cannot
# satisfy a `${VAR:?}` in a compose file and it cannot make a Python package
# importable - PYTHONPATH does that, and PYTHONPATH is forwarded below only
# when a caller sets it deliberately.
for name in TMPDIR LANG LC_ALL DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG SSL_CERT_FILE SSL_CERT_DIR LD_LIBRARY_PATH; do
  value="${!name-}"
  if [ -n "$value" ]; then
    closed+=("$name=$value")
  fi
done

# Fixed assignments: user and system configuration that could otherwise change
# what a command does are pointed at nothing, and every prompt is refused so a
# gate fails instead of hanging on a runner with no terminal.
closed+=(
  "GIT_CONFIG_NOSYSTEM=1"
  "GIT_CONFIG_GLOBAL=/dev/null"
  "GIT_TERMINAL_PROMPT=0"
  "NPM_CONFIG_USERCONFIG=/dev/null"
  "PIP_CONFIG_FILE=/dev/null"
  "PIP_DISABLE_PIP_VERSION_CHECK=1"
  "PIP_NO_INPUT=1"
)

# The repository variables the harness's own gate environment adds. Forwarded
# only when set, for the same reason as the optional pass-throughs above.
#
# PYTHONPATH is the load-bearing one. The harness passes it because the worker
# package is NOT installed into the virtualenv on a clean machine, and a test
# that spawns the worker without it is the `auto-close-restart` defect. The CI
# job deliberately reproduces that clean machine - see the workflow.
for name in DATABASE_URL TEST_DATABASE_URL LO_MIGRATION_ENV PYTHONPATH LO_ANALYTICS_PSEUDONYM_KEY; do
  value="${!name-}"
  if [ -n "$value" ]; then
    closed+=("$name=$value")
  fi
done

exec env -i "${closed[@]}" "$@"
