# Learning Orbit reference algorithms v1

This directory contains the hash-pinned ECHO-CM and TRACE-AI executable
reference used by the analytics adapters. It is an original engineering
synthesis and research proposal: it is not peer reviewed, not SOTA, and does
not establish learning outcomes, relationship measurement, or production
performance.

`learning_orbit_algorithms_v1.py` is copied byte-for-byte from
`work/learning_orbit_algorithms.py`. Do not edit it in place. Add integration
wrappers outside `reference/`; a changed hash requires a new reference version
and a new analysis epoch. The manifest retains the original source and source
test provenance paths and hashes; isolated builds validate that tracked
provenance plus the bundled reference without depending on files outside the
Git checkout.
