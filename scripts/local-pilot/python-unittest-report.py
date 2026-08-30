from __future__ import annotations

import contextlib
import io
import json
import sys
import unittest


def _write_error(code: str) -> int:
    sys.stderr.write(f"{code}\n")
    return 2


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] != "--start-directory" or not argv[1]:
        return _write_error("PYTHON_UNITTEST_REPORT_ARGS")

    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            suite = unittest.defaultTestLoader.discover(start_dir=argv[1])
            result = unittest.TextTestRunner(
                stream=captured,
                verbosity=0,
                buffer=True,
            ).run(suite)
    except BaseException:
        return _write_error("PYTHON_UNITTEST_REPORT_FAILED")

    report = {
        "testsRun": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "skipped": len(result.skipped),
        "expectedFailures": len(result.expectedFailures),
        "unexpectedSuccesses": len(result.unexpectedSuccesses),
        "focused": 0,
    }
    sys.stdout.write(json.dumps(report, separators=(",", ":")) + "\n")
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
