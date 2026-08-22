import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureStateDir, SERVER_PROTOCOL, serverRecordPath } from "./paths";

export interface ServerRecord {
  port: number;
  protocol: number;
  pid: number;
  token: string;
}

export function readServerRecord(): ServerRecord | null {
  try {
    const raw = fs.readFileSync(serverRecordPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function isServerAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => ({}))) as { protocol?: number };
    return body.protocol === SERVER_PROTOCOL;
  } catch {
    return false;
  }
}

export async function ensureDaemonRunning(): Promise<ServerRecord> {
  ensureStateDir();
  const existing = readServerRecord();
  if (existing && (await isServerAlive(existing.port))) {
    return existing;
  }

  // Spawn daemon
  const serverScript = path.resolve(__dirname, "../server/daemon-entry.ts");
  const child = spawn(process.execPath, [serverScript], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  // Wait for server to become healthy
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const record = readServerRecord();
    if (record && (await isServerAlive(record.port))) {
      return record;
    }
  }

  throw new Error("Could not start local review daemon");
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
