import { readFile } from "node:fs/promises";

interface PilotResult {
  fixture?: string;
  rooms?: number;
  studentsPerRoom?: number;
  teacherPerRoom?: number;
  measurements?: Array<{ name: string; p50Ms: number; p95Ms: number; samples: number }>;
}

const file = process.argv[2];
if (!file) throw new Error("USAGE: assert-pilot-results <json>");
const value = JSON.parse(await readFile(file, "utf8")) as PilotResult;
if (value.fixture !== "controlled-pilot" || value.rooms !== 10 || value.studentsPerRoom !== 4 || value.teacherPerRoom !== 1) {
  throw new Error("PILOT_FIXTURE_MISMATCH");
}
if (!Array.isArray(value.measurements) || value.measurements.length === 0) throw new Error("PILOT_MEASUREMENTS_MISSING");
for (const measurement of value.measurements) {
  if (!measurement.name || !Number.isSafeInteger(measurement.samples) || measurement.samples < 1
    || !Number.isFinite(measurement.p50Ms) || !Number.isFinite(measurement.p95Ms)
    || measurement.p50Ms < 0 || measurement.p95Ms < measurement.p50Ms) {
    throw new Error("PILOT_MEASUREMENT_INVALID");
  }
}
console.log(JSON.stringify({ ok: true, fixture: value.fixture, measurements: value.measurements.length }));
