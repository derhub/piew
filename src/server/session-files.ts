import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureStateDir, stateDataPath, stateDir } from "../cli/paths";
import type { DiffFile, PageData, ReviewSession } from "../lib/types";
import { atomicWrite, blobsDir, collectBlobs, readBlob, writeBlob } from "./blob-files";
import { deleteToolArtifacts, pruneToolArtifacts } from "./tool-files";

type StoredDiff = Omit<DiffFile, "oldContent" | "newContent"> & {
  oldContentHash?: string;
  newContentHash?: string;
};

type StoredPage = Omit<PageData, "content" | "diff"> & {
  contentHash: string;
  diff?: StoredDiff;
};

type StoredSession = Omit<ReviewSession, "pages"> & {
  pages: Record<string, StoredPage>;
};

export interface StoredSessionV5 {
  schemaVersion: 5;
  session: StoredSession;
}

export interface SessionSummary {
  id: string;
  lastSeen: number;
  title: string;
  kind: ReviewSession["pages"][string]["kind"];
  files: string[];
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

interface ListedSession {
  id: string;
  toolIds: string[];
  summary?: SessionSummary;
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

function dehydrate(session: ReviewSession): StoredSession {
  const pages: Record<string, StoredPage> = {};
  for (const [pageId, page] of Object.entries(session.pages)) {
    const { content, diff, ...rest } = page;
    const stored: StoredPage = { ...rest, contentHash: writeBlob(content) };
    if (diff) {
      const { oldContent, newContent, ...diffRest } = diff;
      stored.diff = { ...diffRest };
      if (oldContent !== undefined) stored.diff.oldContentHash = writeBlob(oldContent);
      if (newContent !== undefined) stored.diff.newContentHash = writeBlob(newContent);
    }
    pages[pageId] = stored;
  }
  return { ...session, pages };
}

function hydrate(session: StoredSession, pageBytes: (hash: string) => string): ReviewSession {
  const pages: Record<string, PageData> = {};
  for (const [pageId, stored] of Object.entries(session.pages)) {
    const { contentHash, diff, ...rest } = stored;
    const page: PageData = { ...rest, content: pageBytes(contentHash) };
    if (diff) {
      const { oldContentHash, newContentHash, ...diffRest } = diff;
      page.diff = { ...diffRest };
      if (oldContentHash !== undefined) page.diff.oldContent = pageBytes(oldContentHash);
      if (newContentHash !== undefined) page.diff.newContent = pageBytes(newContentHash);
    }
    pages[pageId] = page;
  }
  return { ...session, pages };
}

// A v4 record carries its bytes inline, so only a v5 record consults pageBytes: a
// summary can read one with no blob at all and still migrate a v4 file correctly.
function readStoredSession(
  file: string,
  name: string,
  pageBytes: (hash: string) => string = readBlob
): ReviewSession | undefined {
  let stored: { schemaVersion?: number; session?: ReviewSession & StoredSession } | undefined;
  try {
    stored = JSON.parse(fs.readFileSync(file, "utf8"));
    const version = stored?.schemaVersion;
    if (version !== 4 && version !== 5) {
      console.error(`Ignored session schema in ${name}`);
      return undefined;
    }
    const raw = stored?.session;
    if (raw && typeof raw === "object") raw.tools ??= {};
    const session = version === 5 && raw ? hydrate(raw, pageBytes) : raw;
    if (!isReviewSession(session) || name !== `${session.id}.json`) {
      throw new Error(`invalid schema-v${version} session record`);
    }
    if (version === 4) saveSession(session);
    return session;
  } catch (error) {
    const sessionId =
      stored?.session && typeof stored.session === "object" && typeof stored.session.id === "string"
        ? stored.session.id
        : undefined;
    quarantine(file, error, sessionId);
    return undefined;
  }
}

export function readSession(sessionId: string): ReviewSession | undefined {
  if (!/^s_[a-zA-Z0-9_]+$/.test(sessionId)) return undefined;
  ensureSessionDirs();
  const file = sessionPath(sessionId);
  if (!fs.existsSync(file)) return undefined;
  return readStoredSession(file, path.basename(file));
}

function summarize(session: ReviewSession): ListedSession {
  const files = session.reviewMap.items
    .map((item) => session.pages[item.pageId]?.filename)
    .filter((entry): entry is string => !!entry);
  return {
    id: session.id,
    toolIds: Object.keys(session.tools),
    summary: files.length
      ? {
          id: session.id,
          lastSeen: session.lastSeen,
          title: session.reviewMap.title,
          kind: session.pages[session.activePageId]?.kind ?? "markdown",
          files,
        }
      : undefined,
  };
}

export function listSessionSummaries(
  loaded: (sessionId: string) => ReviewSession | undefined
): SessionSummary[] {
  ensureSessionDirs();
  const summaries: SessionSummary[] = [];
  const tools = new Map<string, string[]>();

  for (const name of fs.readdirSync(sessionsDir())) {
    if (!name.endsWith(".json")) continue;
    const session =
      loaded(name.slice(0, -".json".length)) ??
      readStoredSession(path.join(sessionsDir(), name), name, () => "");
    if (!session) continue;
    const listed = summarize(session);
    tools.set(listed.id, listed.toolIds);
    if (listed.summary) summaries.push(listed.summary);
  }

  pruneToolArtifacts(tools);
  return summaries.sort((a, b) => b.lastSeen - a.lastSeen);
}

export function saveSession(session: ReviewSession): void {
  ensureSessionDirs();
  atomicWrite(
    sessionsDir(),
    sessionPath(session.id),
    JSON.stringify(
      { schemaVersion: 5, session: dehydrate(session) } satisfies StoredSessionV5,
      null,
      2
    )
  );
}

function referencedBlobs(): Set<string> {
  const live = new Set<string>();
  for (const name of fs.readdirSync(sessionsDir())) {
    if (!name.endsWith(".json")) continue;
    let stored: Partial<StoredSessionV5>;
    try {
      stored = JSON.parse(fs.readFileSync(path.join(sessionsDir(), name), "utf8"));
    } catch {
      continue;
    }
    for (const page of Object.values(stored.session?.pages ?? {})) {
      for (const hash of [page.contentHash, page.diff?.oldContentHash, page.diff?.newContentHash]) {
        if (typeof hash === "string") live.add(hash);
      }
    }
  }
  return live;
}

export function deleteSession(sessionId: string): void {
  fs.rmSync(sessionPath(sessionId), { force: true });
  deleteToolArtifacts(sessionId);
  collectBlobs(referencedBlobs());
}

export function pruneSessionFiles(): number {
  ensureSessionDirs();
  fs.rmSync(blobsDir(), { recursive: true, force: true });
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
