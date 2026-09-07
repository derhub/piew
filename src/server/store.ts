import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ResolvedDiff } from "../cli/git";
import type {
  JsonValue,
  DiffFile,
  PageData,
  PageKind,
  ReplaceReviewMapRequest,
  ReviewComment,
  ReviewEdit,
  ReviewMap,
  ReviewSession,
  SessionInfo,
  ToolInteraction,
} from "../lib/types";
import {
  deleteSession,
  listSessionSummaries,
  pruneSessionFiles,
  readSession,
  saveSession,
  type SessionSummary,
} from "./session-files";

export type { ResolvedDiff, DiffSource } from "../cli/git";

const MARKDOWN_EXT = new Set([".md", ".markdown"]);

// Write-behind window. Long enough that a burst of keystrokes is one write, short
// enough that a SIGKILL loses at most this much of a browser-side edit.
const FLUSH_DELAY_MS = 250;

type LineAnchor = {
  startLine?: number;
  endLine?: number;
  orphaned?: boolean;
};

function anchorRanges(content: string, quote: string) {
  const ranges: Array<{ startLine: number; endLine: number }> = [];
  const lineSpan = quote.split("\n").length - 1;
  let line = 1;
  let scanned = 0;
  let from = 0;
  let index = content.indexOf(quote, from);
  while (index !== -1) {
    while (scanned < index) {
      if (content.charCodeAt(scanned) === 10) line++;
      scanned++;
    }
    const range = { startLine: line, endLine: line + lineSpan };
    const previous = ranges.at(-1);
    if (!previous || previous.startLine !== range.startLine || previous.endLine !== range.endLine) {
      ranges.push(range);
    }
    from = index + Math.max(quote.length, 1);
    index = content.indexOf(quote, from);
  }
  return ranges;
}

function reanchor(item: LineAnchor, quote: string | undefined, content: string) {
  if (item.startLine === undefined) return;
  if (!quote) {
    item.orphaned = true;
    return;
  }

  const ranges = anchorRanges(content, quote);
  const current = ranges.find(
    (range) =>
      range.startLine === item.startLine &&
      (item.endLine === undefined || range.endLine === item.endLine)
  );
  const match = current ?? (ranges.length === 1 ? ranges[0] : undefined);
  item.orphaned = !match;
  if (match) {
    item.startLine = match.startLine;
    item.endLine = match.endLine;
  }
}

export function kindForFile(filePath: string): PageKind {
  return MARKDOWN_EXT.has(path.extname(filePath).toLowerCase()) ? "markdown" : "file";
}

// Wide enough for a repo-relative path of any real depth, narrow enough to keep the tree sane.
const MAX_MAP_SEGMENTS = 32;
const MAX_MAP_PATH_LENGTH = 512;

export class ReviewMapError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 = 400
  ) {
    super(message);
  }
}

export function normalizeReviewMapRequest(input: unknown): ReplaceReviewMapRequest {
  if (!input || typeof input !== "object") throw new ReviewMapError("Invalid Review Map");
  const value = input as Partial<ReplaceReviewMapRequest>;
  if (typeof value.title !== "string" || !value.title.trim()) {
    throw new ReviewMapError("Review Map title is required");
  }
  if (!Array.isArray(value.items) || value.items.length === 0) {
    throw new ReviewMapError("Review Map items are required");
  }

  const paths = new Set<string>();
  const pageIds = new Set<string>();
  const items = value.items.map((item) => {
    if (!item || typeof item !== "object" || typeof item.path !== "string") {
      throw new ReviewMapError("Invalid Review Map item");
    }
    const segments = item.path.split("/");
    if (
      item.path.startsWith("/") ||
      item.path.includes("\\") ||
      [...item.path].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) ||
      segments.length > MAX_MAP_SEGMENTS ||
      item.path.length > MAX_MAP_PATH_LENGTH ||
      segments.some((segment) => !segment.trim() || segment === "." || segment === "..")
    ) {
      throw new ReviewMapError(`Invalid Review Map path: ${item.path}`);
    }
    if (paths.has(item.path)) {
      throw new ReviewMapError(`Duplicate Review Map path: ${item.path}`, 409);
    }
    paths.add(item.path);

    const source = item.source;
    if (!source || typeof source !== "object") throw new ReviewMapError("Invalid page source");
    if (source.kind === "page") {
      if (typeof source.pageId !== "string" || !source.pageId) {
        throw new ReviewMapError("Invalid page source");
      }
      if (pageIds.has(source.pageId)) {
        throw new ReviewMapError(`Duplicate Review Map page: ${source.pageId}`, 409);
      }
      pageIds.add(source.pageId);
      return { path: item.path, source: { kind: "page" as const, pageId: source.pageId } };
    }
    if (source.kind === "file" && typeof source.file === "string" && source.file) {
      return {
        path: item.path,
        source: { kind: "file" as const, file: path.resolve(source.file) },
      };
    }
    throw new ReviewMapError("Invalid page source");
  });

  return { title: value.title.trim(), items };
}

function isTerminal(item: ReviewComment | ReviewEdit): boolean {
  return item.status === "applied" || item.status === "skipped";
}

export class Store {
  private sessions = new Map<string, ReviewSession>();
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  public read(sessionId: string): ReviewSession | undefined {
    const live = this.sessions.get(sessionId);
    if (live) return live;
    const session = readSession(sessionId);
    if (session) this.sessions.set(sessionId, session);
    return session;
  }

  public has(sessionId: string): boolean {
    return !!this.read(sessionId);
  }

  public list(): SessionSummary[] {
    return listSessionSummaries((sessionId) => this.sessions.get(sessionId));
  }

  public count(): number {
    return this.list().length;
  }

  public loadedCount(): number {
    return this.sessions.size;
  }

  private markDirty(sessionId: string): void {
    if (this.pending.has(sessionId)) return;
    const timer = setTimeout(() => this.flush(sessionId), FLUSH_DELAY_MS);
    timer.unref?.();
    this.pending.set(sessionId, timer);
  }

  public flush(sessionId: string): void {
    const timer = this.pending.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.pending.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) saveSession(session);
  }

  public flushAll(): void {
    for (const sessionId of this.pending.keys()) this.flush(sessionId);
  }

  public evict(sessionId: string): void {
    this.flush(sessionId);
    this.sessions.delete(sessionId);
  }

  public mutate<T>(
    sessionId: string,
    change: (session: ReviewSession) => T,
    commit: (result: T) => boolean = () => true
  ): T | undefined {
    const session = this.read(sessionId);
    if (!session) return undefined;
    const result = change(session);
    if (commit(result)) this.markDirty(sessionId);
    return result;
  }

  private hash(content: string | Buffer): string {
    return crypto.createHash("sha1").update(content).digest("hex");
  }

  private liveDiffHash(file: string): string {
    try {
      const content = fs.lstatSync(file).isSymbolicLink()
        ? fs.readlinkSync(file)
        : fs.readFileSync(file);
      return `live:${this.hash(content)}`;
    } catch {
      return "live:missing";
    }
  }

  private capturedLiveDiffHash(file: string, diff: DiffFile): string {
    if (!diff.newPath) return "live:missing";
    if (diff.newHash) return `live:${diff.newHash}`;
    if (diff.newContent !== undefined) return `live:${this.hash(diff.newContent)}`;
    return this.liveDiffHash(file);
  }

  private pageId(): string {
    return `p_${crypto.randomBytes(6).toString("hex")}`;
  }

  private sessionId(): string {
    return `s_${crypto.randomBytes(6).toString("hex")}`;
  }

  private filePage(filePath: string): PageData {
    const file = path.resolve(filePath);
    const content = fs.readFileSync(file, "utf8");
    const id = this.pageId();
    return {
      id,
      file,
      filename: path.basename(file),
      kind: kindForFile(file),
      content,
      comments: [],
      edits: [],
      hash: this.hash(content),
    };
  }

  private defaultMap(
    title: string,
    pages: PageData[],
    makePath = (page: PageData) => `${path.basename(path.dirname(page.file))}/${page.filename}`
  ): ReviewMap {
    const used = new Set<string>();
    const items = pages.map((page) => {
      let mapPath = makePath(page);
      // A collision means two files with the same name; the parent that tells them apart is
      // the next real directory above what the path already shows.
      const parents = path.dirname(page.file).split(path.sep).filter(Boolean);
      let shown = mapPath.split("/").length - 1;
      while (used.has(mapPath) && shown < parents.length) {
        shown++;
        mapPath = `${parents[parents.length - shown]}/${mapPath}`;
      }
      const segments = mapPath.split("/");
      const leaf = segments.pop()!;
      for (let suffix = 2; used.has(mapPath); suffix++) {
        mapPath = [...segments, `${suffix}-${leaf}`].join("/");
      }
      used.add(mapPath);
      return { pageId: page.id, path: mapPath };
    });
    return { title, items };
  }

  private sessionInfo(session: ReviewSession): SessionInfo {
    return {
      id: session.id,
      activePageId: session.activePageId,
      reviewMap: session.reviewMap,
    };
  }

  private addSession(session: ReviewSession): SessionInfo {
    this.sessions.set(session.id, session);
    saveSession(session);
    return this.sessionInfo(session);
  }

  public createSession(files: string[]): SessionInfo {
    const pages = files.map((file) => this.filePage(file));
    const id = this.sessionId();
    const session: ReviewSession = {
      id,
      activePageId: pages[0]?.id ?? "",
      reviewMap: this.defaultMap("Review Map", pages),
      pages: Object.fromEntries(pages.map((page) => [page.id, page])),
      lastSeen: Date.now(),
      turns: [],
      tools: {},
    };
    return this.addSession(session);
  }

  private reloadFilePage(
    session: ReviewSession,
    page: PageData,
    content: string,
    hash: string
  ): void {
    page.content = content;
    page.hash = hash;
    for (const comment of page.comments) reanchor(comment, comment.quote, content);
    for (const edit of page.edits) reanchor(edit, edit.originalText, content);
    this.syncTurnAnchors(session, page);
  }

  public reloadSource(
    sessionId: string,
    file: string,
    content: string,
    hash = this.hash(content)
  ): Array<{ event: "reload" | "stale"; pageId: string }> {
    const session = this.read(sessionId);
    if (!session) return [];
    const events: Array<{ event: "reload" | "stale"; pageId: string }> = [];
    for (const page of Object.values(session.pages)) {
      if (page.file !== file) continue;
      if (page.kind === "diff") {
        if (!page.liveHead || page.stale) continue;
        page.stale = true;
        events.push({ event: "stale", pageId: page.id });
        continue;
      }
      this.reloadFilePage(session, page, content, hash);
      events.push({ event: "reload", pageId: page.id });
    }
    if (events.length) this.markDirty(sessionId);
    return events;
  }

  private reconcileSession(
    session: ReviewSession
  ): Array<{ event: "reload" | "stale"; pageId: string }> {
    const events: Array<{ event: "reload" | "stale"; pageId: string }> = [];
    for (const page of Object.values(session.pages)) {
      if (page.kind === "diff") {
        if (!page.liveHead || page.stale) continue;
        let changed = this.liveDiffHash(page.file) !== page.hash;
        if (!page.hash.startsWith("live:")) {
          if (!page.diff?.newPath) {
            changed = fs.existsSync(page.file);
          } else if (page.diff.newContent !== undefined) {
            try {
              changed = fs.readFileSync(page.file, "utf8") !== page.diff.newContent;
            } catch {
              changed = true;
            }
          }
        }
        if (changed) {
          page.stale = true;
          events.push({ event: "stale", pageId: page.id });
        }
        continue;
      }
      if (!fs.existsSync(page.file)) continue;
      let content: string;
      try {
        content = fs.readFileSync(page.file, "utf8");
      } catch {
        continue;
      }
      const hash = this.hash(content);
      if (hash === page.hash) continue;
      this.reloadFilePage(session, page, content, hash);
      events.push({ event: "reload", pageId: page.id });
    }
    return events;
  }

  public reconcile(session: ReviewSession): Array<{ event: "reload" | "stale"; pageId: string }> {
    const events = this.reconcileSession(session);
    if (events.length) this.markDirty(session.id);
    return events;
  }

  private syncTurnAnchors(session: ReviewSession, page: PageData) {
    const anchors = new Map(
      [...page.comments, ...page.edits].map((item) => [item.id, item] as const)
    );
    for (const turn of session.turns) {
      for (const item of turn.items) {
        if (item.pageId !== page.id) continue;
        const anchor = anchors.get(item.id);
        if (!anchor) continue;
        item.startLine = anchor.startLine;
        item.endLine = anchor.endLine;
        item.orphaned = anchor.orphaned;
      }
    }
  }

  public createDiffSession(resolved: ResolvedDiff): SessionInfo {
    const pages = resolved.files.map((diff) => {
      const shown = diff.newPath || diff.oldPath || "";
      const file = path.join(resolved.repoRoot, shown);
      const hash = resolved.liveHead
        ? this.capturedLiveDiffHash(file, diff)
        : this.hash(`${resolved.range}#${shown}#${diff.status}`);
      const storedDiff = { ...diff };
      delete storedDiff.newHash;
      const id = this.pageId();
      return {
        id,
        file,
        filename: shown,
        kind: "diff" as const,
        content: "",
        diff: storedDiff,
        repoRoot: resolved.repoRoot,
        range: resolved.range,
        staged: resolved.staged,
        liveHead: resolved.liveHead,
        comments: [],
        edits: [],
        hash,
      } satisfies PageData;
    });
    const id = this.sessionId();
    const session: ReviewSession = {
      id,
      activePageId: pages[0]?.id ?? "",
      reviewMap: this.defaultMap(
        `${path.basename(resolved.repoRoot)} ${resolved.range}`,
        pages,
        (page) => `${path.basename(resolved.repoRoot)}/${page.filename}`
      ),
      pages: Object.fromEntries(pages.map((page) => [page.id, page])),
      lastSeen: Date.now(),
      turns: [],
      tools: {},
    };
    return this.addSession(session);
  }

  public getPage(sessionId: string, pageId: string): PageData | undefined {
    return this.read(sessionId)?.pages[pageId];
  }

  public refreshDiff(sessionId: string, pageId: string, diff: DiffFile): boolean {
    return !!this.mutate(sessionId, (session) => {
      const page = session.pages[pageId];
      if (!page || page.kind !== "diff") return false;
      page.comments = [];
      page.edits = [];
      page.hash = this.capturedLiveDiffHash(page.file, diff);
      page.diff = { ...diff };
      delete page.diff.newHash;
      page.stale = false;
      return true;
    });
  }

  public replaceReviewMap(
    sessionId: string,
    input: unknown
  ): {
    info: SessionInfo;
    session: ReviewSession;
    events: Array<{ event: "reload" | "stale"; pageId: string }>;
  } {
    const request = normalizeReviewMapRequest(input);
    const result = this.mutate(sessionId, (session) => {
      const pages: Record<string, PageData> = {};
      const items: ReviewMap["items"] = [];
      for (const item of request.items) {
        let page: PageData | undefined;
        if (item.source.kind === "page") {
          page = session.pages[item.source.pageId];
          if (!page) throw new ReviewMapError(`Review page not found: ${item.source.pageId}`, 404);
        } else {
          const file = item.source.file;
          if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            throw new ReviewMapError(`File not found: ${file}`, 404);
          }
          page = [...Object.values(session.pages), ...Object.values(pages)].find(
            (candidate) => candidate.file === file
          );
          page ??= this.filePage(file);
        }
        if (pages[page.id]) {
          throw new ReviewMapError(`Duplicate Review Map page: ${page.id}`, 409);
        }
        pages[page.id] = page;
        items.push({ pageId: page.id, path: item.path });
      }

      for (const [pageId, page] of Object.entries(session.pages)) {
        if (pages[pageId]) continue;
        if ([...page.comments, ...page.edits].some((item) => !isTerminal(item))) {
          throw new ReviewMapError(`Page has unresolved annotations: ${page.filename}`, 409);
        }
      }

      session.reviewMap = { title: request.title, items };
      session.pages = pages;
      session.activePageId = pages[session.activePageId] ? session.activePageId : items[0].pageId;
      session.lastSeen = Date.now();
      return {
        info: this.sessionInfo(session),
        session,
        events: this.reconcileSession(session),
      };
    });
    if (!result) throw new ReviewMapError("Review session not found", 404);
    return result;
  }

  public setViewed(sessionId: string, pageId: string, viewed: boolean): PageData | null {
    return (
      this.mutate(sessionId, (session) => {
        const page = session.pages[pageId];
        if (!page) return null;
        page.viewed = viewed;
        return page;
      }) ?? null
    );
  }

  public addComment(sessionId: string, pageId: string, comment: ReviewComment): PageData | null {
    return (
      this.mutate(sessionId, (session) => {
        const page = session.pages[pageId];
        if (!page) return null;
        page.comments.push(comment);
        return page;
      }) ?? null
    );
  }

  public updateComment(
    sessionId: string,
    pageId: string,
    commentId: string,
    feedback: string
  ): PageData | null {
    return (
      this.mutate(sessionId, (session) => {
        const page = session.pages[pageId];
        const comment = page?.comments.find((candidate) => candidate.id === commentId);
        if (!page || !comment) return null;
        comment.feedback = feedback;
        return page;
      }) ?? null
    );
  }

  public removeComment(sessionId: string, pageId: string, commentId: string): PageData | null {
    return (
      this.mutate(sessionId, (session) => {
        const page = session.pages[pageId];
        if (!page) return null;
        page.comments = page.comments.filter((comment) => comment.id !== commentId);
        return page;
      }) ?? null
    );
  }

  public addEdit(sessionId: string, pageId: string, edit: ReviewEdit): PageData | null {
    return (
      this.mutate(sessionId, (session) => {
        const page = session.pages[pageId];
        if (!page) return null;
        page.edits.push(edit);
        return page;
      }) ?? null
    );
  }

  public updateEdit(
    sessionId: string,
    pageId: string,
    editId: string,
    suggestedText: string
  ): PageData | null {
    return (
      this.mutate(sessionId, (session) => {
        const page = session.pages[pageId];
        const edit = page?.edits.find((candidate) => candidate.id === editId);
        if (!page || !edit) return null;
        edit.suggestedText = suggestedText;
        return page;
      }) ?? null
    );
  }

  public removeEdit(sessionId: string, pageId: string, editId: string): PageData | null {
    return (
      this.mutate(sessionId, (session) => {
        const page = session.pages[pageId];
        if (!page) return null;
        page.edits = page.edits.filter((edit) => edit.id !== editId);
        return page;
      }) ?? null
    );
  }

  public addTool(sessionId: string, interaction: ToolInteraction): boolean {
    return (
      this.mutate(sessionId, (session) => {
        if (session.tools[interaction.id]) return false;
        session.tools[interaction.id] = interaction;
        return true;
      }) ?? false
    );
  }

  public actOnTool(
    sessionId: string,
    id: string,
    action:
      | { type: "submit"; value: JsonValue }
      | { type: "dismiss" }
      | { type: "reset" }
      | { type: "reply"; text: string }
  ): ToolInteraction | null {
    return (
      this.mutate(sessionId, (session) => {
        const tool = session.tools[id];
        if (!tool) return null;

        let next: ToolInteraction | null = null;
        if (action.type === "submit" && tool.state === "open") {
          next = { ...tool, state: "ready", result: { kind: "submitted", value: action.value } };
        } else if (action.type === "dismiss" && tool.state === "open") {
          next = { ...tool, state: "ready", result: { kind: "dismissed" } };
        } else if (action.type === "reset" && tool.state === "ready" && tool.replies.length === 0) {
          const { result: _result, ...base } = tool;
          next = { ...base, state: "open" };
        } else if (
          action.type === "reply" &&
          tool.state === "awaiting-answer" &&
          action.text.trim()
        ) {
          next = {
            ...tool,
            state: "ready",
            replies: [...tool.replies, { from: "user", text: action.text.trim(), at: Date.now() }],
          };
        }
        if (!next) return null;
        session.tools[id] = next;
        return next;
      }) ?? null
    );
  }

  public getBatch(sessionId: string) {
    return this.read(sessionId)?.pendingBatch;
  }

  public remove(sessionId: string): void {
    const timer = this.pending.get(sessionId);
    if (timer) clearTimeout(timer);
    this.pending.delete(sessionId);
    this.sessions.delete(sessionId);
    deleteSession(sessionId);
  }

  public pruneAll(): { sessions: number; files: number } {
    const sessions = this.count();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.sessions.clear();
    const files = pruneSessionFiles();
    return { sessions, files };
  }
}
