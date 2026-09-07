# Worker image.  Build context is the repository root.
#
# The worker reads five canonical SQL files that the *server* owns, at the path
# its module resolution produces (`parents[4]/apps/server/src/db/sql`).  They
# are copied in as bytes and never rewritten in Python: a claim or a room lock
# expressed twice is two things that can drift, and the drift would show up as
# a lease that looks held by one runtime and free to the other.
# `scripts/verify-worker-runtime-sql.mjs` reads them back out of the built
# image and compares them to the sources byte for byte.
#
# syntax=docker/dockerfile:1
FROM mwader/static-ffmpeg:9.0.1@sha256:54e55b0cb8f672870fc38ceb2e6c411855cb3b39c505f5f3b2505ee01ed5f2b7 AS ffmpeg

FROM python@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# ffmpeg, pinned by digest like everything else in this image.
#
# It is the worker's only component that decodes attacker-supplied media, so
# `apt-get install ffmpeg` — which resolves whatever the archive serves on the
# day of the build — would have been the one unreviewed thing here. A static
# build copied from an image pinned by digest is reviewable and reproducible:
# the bytes are fixed by the hash, and there is no package manager, no
# transitive set and no network in the build.
#
# The binary is static, so it needs nothing from this base beyond a place to
# live, and it is installed read-only and owned by root like the rest of /app.
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg

# Dependencies first, from the hashed lock only.  `--require-hashes` makes a
# lock edit that forgot a hash fail the build instead of silently resolving.
COPY services/worker/requirements.lock /tmp/requirements.lock
RUN python -m pip install --require-hashes --no-deps -r /tmp/requirements.lock \
    && rm /tmp/requirements.lock

COPY services/worker/pyproject.toml /app/services/worker/pyproject.toml
COPY services/worker/src /app/services/worker/src

# Exactly the five files the worker reads, named one by one.  Copying the
# directory would let a new server-owned statement reach the worker image
# without anyone deciding that it should.
COPY apps/server/src/db/sql/claim_worker_job.sql \
     apps/server/src/db/sql/settle_worker_job_claims.sql \
     apps/server/src/db/sql/lock_room_xact.sql \
     apps/server/src/db/sql/lock_room_session.sql \
     apps/server/src/db/sql/unlock_room_session.sql \
     /app/apps/server/src/db/sql/

# The build commit is recorded so the verifier can refuse an image built from
# different source than the checkout it is comparing against.
ARG SOURCE_SHA=unknown
ENV LO_SOURCE_SHA=${SOURCE_SHA}

RUN useradd --system --create-home --uid 10001 worker \
    && chown -R root:root /app \
    && chmod -R a-w,a+rX /app
USER 10001:10001

ENV PYTHONPATH=/app/services/worker/src
ENTRYPOINT ["python", "-m", "learning_orbit_worker.main"]
