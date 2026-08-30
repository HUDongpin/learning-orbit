import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("pilot governance migrations", () => {
  it("keeps governance tables content-free and rerunnable", async () => {
    const migration = await readFile(new URL("../../../../infra/postgres/migrations/005_pilot_governance.sql", import.meta.url), "utf8");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS pilot_retention_policy");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS deletion_job");
    expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS deletion_job_one_unfinished_room_idx");
    expect(migration).not.toMatch(/prompt|transcript|cookie|token|provider_url/i);
  });

  it("enforces new-room policy binding while permitting an explicit legacy backfill", async () => {
    const migration = await readFile(new URL("../../../../infra/postgres/migrations/006_enforce_pilot_governance.sql", import.meta.url), "utf8");
    expect(migration).toContain("CHECK (retention_policy_id IS NOT NULL) NOT VALID");
    expect(migration).toContain("RETENTION_POLICY_IMMUTABLE");
  });

  it("keeps future multimodal artifact references room-scoped", async () => {
    const migration = await readFile(new URL("../../../../infra/postgres/migrations/009_analytics_media_integrity.sql", import.meta.url), "utf8");
    expect(migration).toContain("derived_text_artifact_room_media_fk");
    expect(migration).toContain("extraction_artifact_room_artifact_fk");
    expect(migration).toContain("NOT VALID");
  });

  it("persists immutable projection snapshot warnings instead of relying on a fabricated default", async () => {
    const migration = await readFile(new URL("../../../../infra/postgres/migrations/010_projection_snapshot_warnings.sql", import.meta.url), "utf8");
    expect(migration).toContain("ADD COLUMN warnings jsonb NOT NULL");
    expect(migration).toContain("ADD COLUMN warnings_sha256 char(64) NOT NULL");
    expect(migration).toContain("jsonb_typeof(warnings) = 'array'");
    expect(migration).toContain("ALTER COLUMN warnings DROP DEFAULT");
    expect(migration).toContain("ALTER COLUMN warnings_sha256 DROP DEFAULT");
  });
});
