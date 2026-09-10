import { acquireDaemonLock, releaseDaemonLock } from "../cli/daemon";
import { ReviewServer } from "./server";
import { Telemetry } from "./telemetry";
import { stateDir } from "../cli/paths";
import path from "node:path";

if (!acquireDaemonLock()) process.exit(0);

const telemetry =
  process.env.PIEW_TELEMETRY === "1"
    ? new Telemetry({ logPath: path.join(stateDir(), "telemetry.log") })
    : undefined;
const server = new ReviewServer(undefined, telemetry);
let stopping = false;

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  try {
    await server.stop();
  } finally {
    releaseDaemonLock();
    process.exit(exitCode);
  }
}

process.once("exit", () => releaseDaemonLock());
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

try {
  await server.start(4173);
} catch (error) {
  console.error(error);
  await stop(1);
}
