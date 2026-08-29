import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export const SERVER_PROTOCOL = 4;

export function stateDir(): string {
  const custom = process.env.PIEW_DIR;
  if (custom) return path.resolve(custom);
  return path.join(os.homedir(), ".piew");
}

export function ensureStateDir(): string {
  const dir = stateDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function serverRecordPath(): string {
  return path.join(stateDir(), "server.json");
}

export function daemonLockPath(): string {
  return path.join(stateDir(), "daemon.lock");
}

export function daemonLogPath(): string {
  return path.join(stateDir(), "daemon.log");
}

export function stateDataPath(): string {
  return path.join(stateDir(), "state-v3.json");
}

export type Target =
  | { kind: "file"; value: string }
  | { kind: "url"; value: string }
  | { kind: "git"; value: string };

export function gitTarget(repoRoot: string, range: string): string {
  return `git:${repoRoot}:${range}`;
}

export function canonicalTarget(input: string): Target {
  const trimmed = input.trim();
  // A git target names a revision range, not a path: resolving it against cwd
  // would invent a file that never exists.
  if (trimmed.startsWith("git:")) {
    return { kind: "git", value: trimmed };
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: "url", value: trimmed };
  }
  return { kind: "file", value: path.resolve(process.cwd(), trimmed) };
}

export function shellQuote(str: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(str)) return str;
  return `"${str.replace(/"/g, '\\"')}"`;
}
