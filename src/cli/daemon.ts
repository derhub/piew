import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  daemonLockPath,
  daemonLogPath,
  ensureStateDir,
  SERVER_PROTOCOL,
  serverRecordPath,
} from "./paths";

const MAX_DAEMON_LOG_BYTES = 1024 * 1024;
const DAEMON_START_GRACE_MS = 5_000;

export interface ServerRecord {
  port: number;
  protocol: number;
  pid: number;
  token: string;
}

interface DaemonLock {
  pid: number;
  startedAt: number;
}

interface ServerHealth {
  pid?: number;
  protocol?: number;
}

function readDaemonLock(): DaemonLock | null {
  try {
    const lock = JSON.parse(fs.readFileSync(daemonLockPath(), "utf8")) as Partial<DaemonLock>;
    if (!Number.isInteger(lock.pid) || !Number.isFinite(lock.startedAt)) return null;
    return lock as DaemonLock;
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return;
  return String(error.code);
}

function isProcessRunning(pid: number): boolean {
  if (pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

export function acquireDaemonLock(pid = process.pid): boolean {
  ensureStateDir();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(
        daemonLockPath(),
        JSON.stringify({ pid, startedAt: Date.now() } satisfies DaemonLock),
        { encoding: "utf8", flag: "wx" }
      );
      return true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const owner = readDaemonLock();
      if (owner && isProcessRunning(owner.pid)) return owner.pid === pid;
      try {
        fs.unlinkSync(daemonLockPath());
      } catch (unlinkError) {
        if (errorCode(unlinkError) !== "ENOENT") return false;
      }
    }
  }
  return false;
}

export function releaseDaemonLock(pid = process.pid): void {
  if (readDaemonLock()?.pid !== pid) return;
  try {
    fs.unlinkSync(daemonLockPath());
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function clearAbandonedDaemonLock(): void {
  const owner = readDaemonLock();
  if (!owner) return;
  if (isProcessRunning(owner.pid) && Date.now() - owner.startedAt <= DAEMON_START_GRACE_MS) return;
  try {
    fs.unlinkSync(daemonLockPath());
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export function readServerRecord(): ServerRecord | null {
  try {
    const raw = fs.readFileSync(serverRecordPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readServerHealth(port: number): Promise<ServerHealth | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as ServerHealth | null;
  } catch {
    return null;
  }
}

export async function isServerAlive(port: number): Promise<boolean> {
  return (await readServerHealth(port))?.protocol === SERVER_PROTOCOL;
}

async function stopDaemon(record: ServerRecord, health: ServerHealth | null): Promise<boolean> {
  let shutdownAccepted = false;
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/shutdown`, {
      method: "POST",
      headers: { "x-piew-token": record.token },
      signal: AbortSignal.timeout(1000),
    });
    shutdownAccepted = response.ok;
  } catch {}

  if (!shutdownAccepted && (health?.pid === record.pid || readDaemonLock()?.pid === record.pid)) {
    try {
      process.kill(record.pid, "SIGTERM");
    } catch {}
  }

  for (let i = 0; i < 40; i++) {
    if (!(await readServerHealth(record.port)) && readDaemonLock()?.pid !== record.pid) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function restartDaemon(): Promise<ServerRecord> {
  const existing = readServerRecord();
  if (existing) {
    const health = await readServerHealth(existing.port);
    if (!(await stopDaemon(existing, health))) {
      throw new Error(`Could not stop review daemon. See ${daemonLogPath()}`);
    }
  }
  return ensureDaemonRunning();
}

export async function ensureDaemonRunning(): Promise<ServerRecord> {
  ensureStateDir();
  const logPath = daemonLogPath();
  const existing = readServerRecord();
  if (existing) {
    const health = await readServerHealth(existing.port);
    if (health?.protocol === SERVER_PROTOCOL && health.pid === existing.pid) return existing;
    if (health && !(await stopDaemon(existing, health))) {
      throw new Error(`Could not stop outdated review daemon. See ${logPath}`);
    }
  }
  clearAbandonedDaemonLock();

  const serverScript = path.resolve(__dirname, "../server/daemon-entry.ts");
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_DAEMON_LOG_BYTES) {
      fs.truncateSync(logPath, 0);
    }
    const logFd = fs.openSync(logPath, "a");
    try {
      const child = spawn(process.execPath, [serverScript], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env },
      });
      child.unref();
    } finally {
      fs.closeSync(logFd);
    }
  } catch (error) {
    throw new Error(`Could not start local review daemon. See ${logPath}`, { cause: error });
  }

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const record = readServerRecord();
    const health = record ? await readServerHealth(record.port) : null;
    if (record && health?.protocol === SERVER_PROTOCOL && health.pid === record.pid) {
      return record;
    }
  }

  throw new Error(`Could not start local review daemon. See ${logPath}`);
}

export function openBrowser(url: string) {
  // A headless run has nowhere to put a window; the URL on stdout is the whole point.
  if (process.env.PIEW_NO_OPEN) return;

  const cmd =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

  const child = spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
