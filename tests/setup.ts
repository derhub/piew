import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Servers started by tests write server.json and state-v3.json through stateDir().
// Without this they overwrite the developer's live ~/.piew and hijack the running daemon.
process.env.PIEW_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "piew-test-"));
