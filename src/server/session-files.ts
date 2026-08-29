import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureStateDir, stateDataPath, stateDir } from "../cli/paths";
import type { ReviewSession } from "../lib/types";

export interface StoredSessionV4 {
  schemaVersion: 4;
  session: ReviewSession;
}

function sessionStateDir(): string {
  return path.join(stateDir(), "state-v4");
}

function sessionsDir(): string {
  return path.join(sessionStateDir(), "sessions");
}

function quarantineDir(): string {
  return path.join(sessionStateDir(), "quarantine");
}

function ensureSessionDirs(): void {
  ensureStateDir();
  fs.mkdirSync(sessionsDir(), { recursive: true });
  fs.mkdirSync(quarantineDir(), { recursive: true });
}

function sessionPath(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

function isReviewSession(value: unknown): value is ReviewSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<ReviewSession>;
  const reviewMap = session.reviewMap as Partial<ReviewSession["reviewMap"]> | undefined;
  const pages = session.pages;
  return (
    typeof session.id === "string" &&
    typeof session.activePageId === "string" &&
    !!reviewMap &&
    typeof reviewMap.title === "string" &&
    Array.isArray(reviewMap.items) &&
    reviewMap.items.every(
      (item) => !!item && typeof item.pageId === "string" && typeof item.path === "string"
    ) &&
    !!pages &&
    !Array.isArray(pages) &&
    Object.entries(pages).every(
      ([pageId, page]) =>
        !!page &&
        page.id === pageId &&
        typeof page.file === "string" &&
        typeof page.filename === "string" &&
        (page.kind === "markdown" || page.kind === "file" || page.kind === "diff") &&
        typeof page.content === "string" &&
        Array.isArray(page.comments) &&
        page.comments.every((item) => !!item && typeof item.id === "string") &&
        Array.isArray(page.edits) &&
        page.edits.every((item) => !!item && typeof item.id === "string") &&
        typeof page.hash === "string"
    ) &&
    Array.isArray(session.turns) &&
    session.turns.every(
      (turn) =>
        !!turn &&
        Array.isArray(turn.items) &&
        turn.items.every(
          (item) => !!item && typeof item.id === "string" && typeof item.pageId === "string"
        )
    ) &&
    typeof session.lastSeen === "number"
  );
}

function quarantine(file: string, reason: unknown): void {
  ensureSessionDirs();
  const target = path.join(
    quarantineDir(),
    `${path.basename(file, ".json")}.${Date.now()}.${crypto.randomUUID()}.json`
  );
  fs.renameSync(file, target);
  console.error(`Quarantined invalid session ${path.basename(file)}: ${String(reason)}`);
}

export function loadSessions(): Map<string, ReviewSession> {
  ensureSessionDirs();
  const sessions = new Map<string, ReviewSession>();

  for (const name of fs.readdirSync(sessionsDir())) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(sessionsDir(), name);
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoredSessionV4>;
      if (stored.schemaVersion !== 4) {
        console.error(`Ignored session schema in ${name}`);
        continue;
      }
      if (!isReviewSession(stored.session) || name !== `${stored.session.id}.json`) {
        throw new Error("invalid schema-v4 session record");
      }
      sessions.set(stored.session.id, stored.session);
    } catch (error) {
      quarantine(file, error);
    }
  }

  return sessions;
}

export function saveSession(session: ReviewSession): void {
  ensureSessionDirs();
  const target = sessionPath(session.id);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "w");
    fs.writeFileSync(
      descriptor,
      JSON.stringify({ schemaVersion: 4, session } satisfies StoredSessionV4, null, 2),
      "utf8"
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
    if (process.platform !== "win32") {
      const directory = fs.openSync(sessionsDir(), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function deleteSession(sessionId: string): void {
  fs.rmSync(sessionPath(sessionId), { force: true });
}

export function pruneSessionFiles(): number {
  ensureSessionDirs();
  let removed = 0;
  for (const directory of [sessionsDir(), quarantineDir()]) {
    for (const name of fs.readdirSync(directory)) {
      fs.rmSync(path.join(directory, name), { force: true });
      removed++;
    }
  }
  const legacy = stateDataPath();
  if (fs.existsSync(legacy)) {
    fs.rmSync(legacy, { force: true });
    removed++;
  }
  return removed;
}
