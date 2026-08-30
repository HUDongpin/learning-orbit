import { buildApp } from "./app.js";
import { loadServerConfig } from "./config.js";
import { loadServiceAssertionTrust } from "./modules/security/service-assertion.js";
import { superviseServerApp } from "./server-process.js";

try {
  const config = loadServerConfig();
  if (!config.serviceAssertionTrustFile) throw new Error("LO_SERVICE_ASSERTION_TRUST_FILE_REQUIRED");
  loadServiceAssertionTrust({ trustFile: config.serviceAssertionTrustFile });
  const app = await buildApp({ config });
  const port = Number(process.env.PORT ?? "3001");
  process.exitCode = await superviseServerApp({ app, port });
  if (process.exitCode !== 0) process.stderr.write("SERVER_PROCESS_FAILED\n");
} catch {
  process.stderr.write("SERVER_START_FAILED\n");
  process.exitCode = 1;
}
