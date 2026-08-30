import { runMigrations } from "./migrate.js";

const useTestDatabase = process.argv.includes("--test");
const connectionString = useTestDatabase ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(useTestDatabase ? "TEST_DATABASE_URL is required" : "DATABASE_URL is required");
}

await runMigrations(connectionString, "infra/postgres/migrations");
