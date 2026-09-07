import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../cli/paths";

export function blobsDir(): string {
  return path.join(stateDir(), "state-v4", "blobs");
}

export function atomicWrite(directory: string, target: string, data: string): void {
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "w");
    fs.writeFileSync(descriptor, data, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
    if (process.platform !== "win32") {
      const dirDescriptor = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(dirDescriptor);
      } finally {
        fs.closeSync(dirDescriptor);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeBlob(text: string): string {
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  const directory = blobsDir();
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, hash);
  if (fs.existsSync(target)) return hash;

  atomicWrite(directory, target, text);
  return hash;
}

export function readBlob(hash: string): string {
  return fs.readFileSync(path.join(blobsDir(), hash), "utf8");
}

export function collectBlobs(live: Set<string>): number {
  const directory = blobsDir();
  if (!fs.existsSync(directory)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(directory)) {
    if (live.has(name)) continue;
    fs.rmSync(path.join(directory, name), { force: true });
    removed++;
  }
  return removed;
}
