/** The daemon under test: its own state dir, a fixed port, no browser launch. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PIEW_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "piew-e2e-"));
process.env.PIEW_NO_OPEN = "1";

const { ReviewServer } = await import("../../src/server/server");

const server = new ReviewServer();
const port = await server.start(Number(process.env.PIEW_E2E_PORT || 5910));
process.stdout.write(`piew e2e server on ${port}, state in ${process.env.PIEW_DIR}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop();
    process.exit(0);
  });
}
