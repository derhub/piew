import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureStateDir, stateDataPath, stateDir } from "../cli/paths";
import type { ReviewSession } from "../lib/types";
import { deleteToolArtifacts, pruneToolArtifacts } from "./tool-files";

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

function isJsonValue(value: unknown): boolean {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJsonValue)
  );
}

function isArtifactPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !!value &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value) &&
    !value.split("/").some((part) => !part || part === "." || part === "..")
  );
}

function isToolInteraction(id: string, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const tool = value as Record<string, any>;
  const request = tool.request as Record<string, any> | undefined;
  const artifact = tool.artifact as Record<string, any> | undefined;
  const anchor = request?.anchor as Record<string, any> | undefined;
  const replies = tool.replies;
  const validState = ["open", "ready", "sent", "awaiting-answer", "resolved"].includes(tool.state);
  const validResult =
    tool.result?.kind === "dismissed" ||
    (tool.result?.kind === "submitted" && isJsonValue(tool.result.value));
  return (
    tool.id === id &&
    typeof tool.tool === "string" &&
    typeof tool.createdAt === "number" &&
    validState &&
    !!request &&
    typeof request.prompt === "string" &&
    "data" in request &&
    isJsonValue(request.data) &&
    (!anchor ||
      (typeof anchor.pageId === "string" && Number.isInteger(anchor.line) && anchor.line > 0)) &&
    !!artifact &&
    typeof artifact.digest === "string" &&
    Array.isArray(artifact.files) &&
    artifact.files.every(isArtifactPath) &&
    Number.isInteger(artifact.bytes) &&
    artifact.bytes >= 0 &&
    Array.isArray(replies) &&
    replies.every(
      (reply: any) =>
        !!reply &&
        (reply.from === "agent" || reply.from === "user") &&
        typeof reply.text === "string" &&
        typeof reply.at === "number"
    ) &&
    (tool.state === "open" ? !("result" in tool) : validResult) &&
    (tool.state !== "resolved" || tool.status === "applied" || tool.status === "skipped")
  );
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
          (item) =>
            !!item &&
            typeof item.id === "string" &&
            (item.kind === "tool" ? typeof item.tool === "string" : typeof item.pageId === "string")
        )
    ) &&
    !!session.tools &&
    !Array.isArray(session.tools) &&
    Object.entries(session.tools).every(([id, tool]) => isToolInteraction(id, tool)) &&
    typeof session.lastSeen === "number"
  );
}

function quarantine(file: string, reason: unknown, sessionId?: string): void {
  ensureSessionDirs();
  const target = path.join(
    quarantineDir(),
    `${path.basename(file, ".json")}.${Date.now()}.${crypto.randomUUID()}.json`
  );
  fs.renameSync(file, target);
  if (sessionId) deleteToolArtifacts(sessionId);
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
      if (stored.session && typeof stored.session === "object") stored.session.tools ??= {};
      if (!isReviewSession(stored.session) || name !== `${stored.session.id}.json`) {
        throw new Error("invalid schema-v4 session record");
      }
      sessions.set(stored.session.id, stored.session);
    } catch (error) {
      let sessionId: string | undefined;
      try {
        const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { session?: { id?: unknown } };
        if (typeof stored.session?.id === "string") sessionId = stored.session.id;
      } catch {}
      quarantine(file, error, sessionId);
    }
  }

  pruneToolArtifacts(
    new Map([...sessions].map(([id, session]) => [id, Object.keys(session.tools)]))
  );

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
  deleteToolArtifacts(sessionId);
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
  removed += pruneToolArtifacts([]);
  return removed;
}
