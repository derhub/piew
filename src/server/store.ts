import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureStateDir, stateDataPath } from "../cli/paths";
import type { ResolvedDiff } from "../cli/git";
import type {
  ItemStatus,
  PageData,
  PageKind,
  ReplaceReviewMapRequest,
  ReviewBatch,
  ReviewComment,
  ReviewEdit,
  ReviewMap,
  ReviewSession,
  SessionInfo,
} from "../lib/types";

export type { ResolvedDiff, DiffSource } from "../cli/git";

const MARKDOWN_EXT = new Set([".md", ".markdown"]);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
      segments.length > 5 ||
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

interface StoredState {
  sessions: Record<string, ReviewSession>;
}

function isTerminal(item: ReviewComment | ReviewEdit): boolean {
  return item.status === "applied" || item.status === "skipped";
}

export class Store {
  public sessions = new Map<string, ReviewSession>();

  constructor() {
    this.loadFromDisk();
  }

  private hash(content: string): string {
    return crypto.createHash("sha1").update(content).digest("hex");
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
      const base = makePath(page);
      const segments = base.split("/");
      const leaf = segments.pop()!;
      let mapPath = base;
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
    };
    this.sessions.set(id, session);
    this.saveToDisk();
    return this.sessionInfo(session);
  }

  public reloadPage(page: PageData, content: string, hash = this.hash(content)) {
    page.content = content;
    page.hash = hash;
    for (const comment of page.comments) reanchor(comment, comment.quote, content);
    for (const edit of page.edits) reanchor(edit, edit.originalText, content);
    this.syncTurnAnchors(page);
    this.saveToDisk();
  }

  private syncTurnAnchors(page: PageData) {
    const anchors = new Map(
      [...page.comments, ...page.edits].map((item) => [item.id, item] as const)
    );
    for (const session of this.sessions.values()) {
      if (!session.pages[page.id]) continue;
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
  }

  public createDiffSession(resolved: ResolvedDiff): SessionInfo {
    const pages = resolved.files.map((diff) => {
      const shown = diff.newPath || diff.oldPath || "";
      const id = this.pageId();
      return {
        id,
        file: path.join(resolved.repoRoot, shown),
        filename: shown,
        kind: "diff" as const,
        content: "",
        diff,
        repoRoot: resolved.repoRoot,
        range: resolved.range,
        staged: resolved.staged,
        liveHead: resolved.liveHead,
        comments: [],
        edits: [],
        hash: this.hash(`${resolved.range}#${shown}#${diff.status}`),
      } satisfies PageData;
    });
    const id = this.sessionId();
    const session: ReviewSession = {
      id,
      activePageId: pages[0]?.id ?? "",
      reviewMap: this.defaultMap(
        `${path.basename(resolved.repoRoot)} ${resolved.range}`,
        pages,
        (page) =>
          [path.basename(resolved.repoRoot), ...page.filename.split("/").slice(-4)].join("/")
      ),
      pages: Object.fromEntries(pages.map((page) => [page.id, page])),
      lastSeen: Date.now(),
      turns: [],
    };
    this.sessions.set(id, session);
    this.saveToDisk();
    return this.sessionInfo(session);
  }

  public getPage(sessionId: string, pageId: string): PageData | undefined {
    return this.sessions.get(sessionId)?.pages[pageId];
  }

  public replaceReviewMap(sessionId: string, input: unknown): SessionInfo {
    const request = normalizeReviewMapRequest(input);
    const session = this.sessions.get(sessionId);
    if (!session) throw new ReviewMapError("Review session not found", 404);

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
      if (pages[page.id]) throw new ReviewMapError(`Duplicate Review Map page: ${page.id}`, 409);
      pages[page.id] = page;
      items.push({ pageId: page.id, path: item.path });
    }

    for (const [pageId, page] of Object.entries(session.pages)) {
      if (pages[pageId]) continue;
      if ([...page.comments, ...page.edits].some((item) => !isTerminal(item))) {
        throw new ReviewMapError(`Page has unresolved annotations: ${page.filename}`, 409);
      }
    }

    const nextSession: ReviewSession = {
      ...session,
      reviewMap: { title: request.title, items },
      pages,
      activePageId: pages[session.activePageId] ? session.activePageId : items[0].pageId,
      lastSeen: Date.now(),
    };
    this.sessions.set(sessionId, nextSession);
    try {
      this.saveToDisk();
    } catch (error) {
      this.sessions.set(sessionId, session);
      throw error;
    }
    return this.sessionInfo(nextSession);
  }

  public addComment(sessionId: string, pageId: string, comment: ReviewComment): PageData | null {
    const page = this.getPage(sessionId, pageId);
    if (!page) return null;
    page.comments.push(comment);
    this.saveToDisk();
    return page;
  }

  public updateComment(
    sessionId: string,
    pageId: string,
    commentId: string,
    feedback: string
  ): PageData | null {
    const page = this.getPage(sessionId, pageId);
    const comment = page?.comments.find((candidate) => candidate.id === commentId);
    if (!page || !comment) return null;
    comment.feedback = feedback;
    this.saveToDisk();
    return page;
  }

  public removeComment(sessionId: string, pageId: string, commentId: string): PageData | null {
    const page = this.getPage(sessionId, pageId);
    if (!page) return null;
    page.comments = page.comments.filter((comment) => comment.id !== commentId);
    this.saveToDisk();
    return page;
  }

  public addEdit(sessionId: string, pageId: string, edit: ReviewEdit): PageData | null {
    const page = this.getPage(sessionId, pageId);
    if (!page) return null;
    page.edits.push(edit);
    this.saveToDisk();
    return page;
  }

  public updateEdit(
    sessionId: string,
    pageId: string,
    editId: string,
    suggestedText: string
  ): PageData | null {
    const page = this.getPage(sessionId, pageId);
    const edit = page?.edits.find((candidate) => candidate.id === editId);
    if (!page || !edit) return null;
    edit.suggestedText = suggestedText;
    this.saveToDisk();
    return page;
  }

  public removeEdit(sessionId: string, pageId: string, editId: string): PageData | null {
    const page = this.getPage(sessionId, pageId);
    if (!page) return null;
    page.edits = page.edits.filter((edit) => edit.id !== editId);
    this.saveToDisk();
    return page;
  }

  public setItemStatus(
    sessionId: string,
    id: string,
    status: ItemStatus,
    note?: string
  ): { page: PageData; item: ReviewComment | ReviewEdit } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    for (const page of Object.values(session.pages)) {
      const item =
        page.comments.find((comment) => comment.id === id) ??
        page.edits.find((edit) => edit.id === id);
      if (!item?.sent) continue;
      item.status = status;
      if (note?.trim()) {
        item.replies = [
          ...(item.replies ?? []),
          { from: "agent", text: note.trim(), at: Date.now() },
        ];
      }
      this.saveToDisk();
      return { page, item };
    }
    return null;
  }

  public setBatch(sessionId: string, batch: ReviewBatch): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pendingBatch = { batch, delivered: false };
    this.saveToDisk();
  }

  public getBatch(sessionId: string) {
    return this.sessions.get(sessionId)?.pendingBatch;
  }

  public clearBatch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    delete session.pendingBatch;
    this.saveToDisk();
  }

  public clearSentFeedback(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const page of Object.values(session.pages)) {
      page.comments = [];
      page.edits = [];
    }
    this.saveToDisk();
  }

  public saveToDisk(): void {
    ensureStateDir();
    const target = stateDataPath();
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify(
          { sessions: Object.fromEntries(this.sessions) } satisfies StoredState,
          null,
          2
        ),
        "utf8"
      );
      fs.renameSync(temporary, target);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
  }

  private loadFromDisk(): void {
    try {
      const data = JSON.parse(fs.readFileSync(stateDataPath(), "utf8")) as StoredState;
      const cutoff = Date.now() - SESSION_TTL_MS;
      for (const session of Object.values(data.sessions ?? {})) {
        if (session.lastSeen >= cutoff && session.reviewMap && session.pages) {
          this.sessions.set(session.id, session);
        }
      }
      for (const session of this.sessions.values()) {
        for (const page of Object.values(session.pages)) {
          if (page.kind === "diff") continue;
          if (fs.existsSync(page.file)) {
            page.content = fs.readFileSync(page.file, "utf8");
            page.hash = this.hash(page.content);
          }
          for (const comment of page.comments) reanchor(comment, comment.quote, page.content);
          for (const edit of page.edits) reanchor(edit, edit.originalText, page.content);
          this.syncTurnAnchors(page);
        }
      }
    } catch {}
  }
}
