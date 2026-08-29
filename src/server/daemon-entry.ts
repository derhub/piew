import { acquireDaemonLock, releaseDaemonLock } from "../cli/daemon";
import { ReviewServer } from "./server";

if (!acquireDaemonLock()) process.exit(0);

const server = new ReviewServer();
let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  try {
    server.stop();
  } finally {
    releaseDaemonLock();
    process.exit(exitCode);
  }
}

process.once("exit", () => releaseDaemonLock());
process.once("SIGTERM", () => stop());
process.once("SIGINT", () => stop());

try {
  await server.start(4173);
} catch (error) {
  console.error(error);
  stop(1);
}
