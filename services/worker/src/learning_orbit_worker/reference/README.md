# Learning Orbit reference algorithms v1

This directory contains the hash-pinned ECHO-CM and TRACE-AI executable
reference used by the analytics adapters. It is an original engineering
synthesis and research proposal: it is not peer reviewed, not SOTA, and does
not establish learning outcomes, relationship measurement, or production
performance.

`learning_orbit_algorithms_v1.py` originated as a byte-for-byte copy of
`work/learning_orbit_algorithms.py`. Reference version 1.1 applies three
recorded defect fixes on top of that copy, so the file now diverges from its
upstream source: `manifest.json` keeps the upstream hash in `upstreamSha256`
and describes each departure in `patches`. Do not edit it in place for anything
else. Add integration wrappers outside `reference/`; a changed hash requires a
new reference version and a new analysis epoch, and every divergence must be
listed in `patches` with its defect and fix. The manifest retains the original
source and source test provenance paths and hashes; isolated builds validate
that tracked provenance plus the bundled reference without depending on files
outside the Git checkout.

## Reference version 1.1

| patch | defect |
| --- | --- |
| `cm-merge-rekey` | `merge_concepts`/`undo_merge` cleared the entire visible-edge set, so an unrelated edge held by the theta_off band vanished at the next snapshot with no archive record. |
| `cm-retract-tombstone` | A retraction delivered before the event it targets removed nothing, and the target stayed visible permanently once it arrived. |
| `extractor-verb-boundaries` | No pattern bounded its verb slot, so any word merely containing a verb satisfied it — `consume` in `consumers`, `gives` in `forgives`, `feed` in `feedback`, `eat` in `heat` — and emitted a confident edge the sentence never asserted. Recall is unchanged; only the word-internal matches are gone. |

These fix defects in the reference's own stated behaviour. They do not widen
the extractor's declared fixture scope: it remains six patterns over a closed
seven-concept vocabulary and is still not a natural-language-processing model.
