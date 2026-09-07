// k6 load profile for the authenticated read surface.
//
// This is deliberately narrow. It measures what concurrent HTTP reads do to
// the server under a classroom-sized load, and nothing else: k6 cannot sign in
// through a magic link, redeem a single-use seat code, or drive the
// contract-validated WebSocket protocol, so it cannot say whether an event was
// lost. `tests/load/run-local-pilot.mjs` answers that question and remains the
// harness the required-test manifest gates on.
//
// Every endpoint is read-only and every response is checked for a shape, not
// just a status: a load test that only counts 200s will happily report a
// healthy system that is returning an error page quickly.
import http from "k6/http";
import { check } from "k6";

// An unauthenticated read *should* answer 401. Left at k6's default, every one
// of those counts as a transport failure and the error-rate threshold measures
// nothing. 5xx and transport errors remain failures.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 401 }));

const origin = __ENV.LO_LOAD_ORIGIN;
if (!origin) throw new Error("LO_LOAD_ORIGIN_REQUIRED");

export const options = {
  // One teacher and four students is the pilot's real shape; the ramp exists
  // to find the knee, not to claim a scale this system does not target.
  scenarios: {
    read_surface: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "20s", target: 5 },
        { duration: "40s", target: 5 },
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
  },
  // Thresholds are the assertion. A run that breaches one exits non-zero, so
  // the harness cannot report a passing load test that missed its budget.
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<750", "p(99)<2000"],
    checks: ["rate>0.99"],
  },
  insecureSkipTLSVerify: true,
  noConnectionReuse: false,
  summaryTrendStats: ["avg", "min", "med", "p(95)", "p(99)", "max"],
};

export default function readSurface() {
  // An unauthenticated read must be refused, and refused fast: this is the
  // path an unauthenticated flood would take, so its cost is worth measuring.
  const session = http.get(`${origin}/v1/auth/session`, {
    tags: { surface: "session" },
    redirects: 0,
  });
  check(session, {
    "session answers": (response) => response.status === 200 || response.status === 401,
    "session is json": (response) => (response.headers["Content-Type"] ?? "").includes("application/json"),
    "session is never cached": (response) => (response.headers["Cache-Control"] ?? "").includes("no-store"),
  });
}
