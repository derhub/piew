import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ResolvedDiff } from "../cli/git";
import type {
  ItemStatus,
  JsonValue,
  PageData,
  PageKind,
  ReplaceReviewMapRequest,
  ReviewBatch,
  ReviewComment,
  ReviewEdit,
  ReviewMap,
  ReviewSession,
  SessionInfo,
  ToolFeedback,
  ToolInteraction,
} from "../lib/types";
import { deleteSession, loadSessions, pruneSessionFiles, saveSession } from "./session-files";

export type { ResolvedDiff, DiffSource } from "../cli/git";

const MARKDOWN_EXT = new Set([".md", ".markdown"]);

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

function isTerminal(item: ReviewComment | ReviewEdit): boolean {
  return item.status === "applied" || item.status === "skipped";
}

export class Store {
  public sessions = loadSessions();

  constructor() {
    for (const session of this.sessions.values()) {
      session.tools ??= {};
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

  private addSession(session: ReviewSession): SessionInfo {
    this.sessions.set(session.id, session);
    try {
      this.persist(session.id);
    } catch (error) {
      this.sessions.delete(session.id);
      throw error;
    }
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

  public reloadPage(sessionId: string, page: PageData, content: string, hash = this.hash(content)) {
    page.content = content;
    page.hash = hash;
    for (const comment of page.comments) reanchor(comment, comment.quote, content);
    for (const edit of page.edits) reanchor(edit, edit.originalText, content);
    this.syncTurnAnchors(page);
    this.persist(sessionId);
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
      tools: {},
    };
    return this.addSession(session);
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
      this.persist(sessionId);
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
    this.persist(sessionId);
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
    this.persist(sessionId);
    return page;
  }

  public removeComment(sessionId: string, pageId: string, commentId: string): PageData | null {
    const page = this.getPage(sessionId, pageId);
    if (!page) return null;
    page.comments = page.comments.filter((comment) => comment.id !== commentId);
    this.persist(sessionId);
    return page;
  }

  public addEdit(sessionId: string, pageId: string, edit: ReviewEdit): PageData | null {
    const page = this.getPage(sessionId, pageId);
    if (!page) return null;
    page.edits.push(edit);
    this.persist(sessionId);
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
    this.persist(sessionId);
    return page;
  }

  public removeEdit(sessionId: string, pageId: string, editId: string): PageData | null {
    const page = this.getPage(sessionId, pageId);
    if (!page) return null;
    page.edits = page.edits.filter((edit) => edit.id !== editId);
    this.persist(sessionId);
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
      this.persist(sessionId);
      return { page, item };
    }
    return null;
  }

  public addTool(sessionId: string, interaction: ToolInteraction): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.tools[interaction.id]) return false;
    session.tools[interaction.id] = interaction;
    try {
      this.persist(sessionId);
    } catch (error) {
      delete session.tools[interaction.id];
      throw error;
    }
    return true;
  }

  public readyTools(sessionId: string): ToolFeedback[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return Object.values(session.tools).flatMap((tool) =>
      tool.state === "ready"
        ? [
            {
              id: tool.id,
              tool: tool.tool,
              result: tool.result,
              replies: tool.replies,
              anchor: tool.request.anchor,
            },
          ]
        : []
    );
  }

  public markToolsSent(sessionId: string, ids: string[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const id of ids) {
      const tool = session.tools[id];
      if (tool?.state === "ready") session.tools[id] = { ...tool, state: "sent" };
    }
    this.persist(sessionId);
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
    const session = this.sessions.get(sessionId);
    const tool = session?.tools[id];
    if (!session || !tool) return null;

    let next: ToolInteraction | null = null;
    if (action.type === "submit" && tool.state === "open") {
      next = { ...tool, state: "ready", result: { kind: "submitted", value: action.value } };
    } else if (action.type === "dismiss" && tool.state === "open") {
      next = { ...tool, state: "ready", result: { kind: "dismissed" } };
    } else if (action.type === "reset" && tool.state === "ready" && tool.replies.length === 0) {
      const { result: _result, ...base } = tool;
      next = { ...base, state: "open" };
    } else if (action.type === "reply" && tool.state === "awaiting-answer" && action.text.trim()) {
      next = {
        ...tool,
        state: "ready",
        replies: [...tool.replies, { from: "user", text: action.text.trim(), at: Date.now() }],
      };
    }
    if (!next) return null;
    session.tools[id] = next;
    this.persist(sessionId);
    return next;
  }

  public setToolStatus(
    sessionId: string,
    id: string,
    status: ItemStatus,
    note?: string
  ): ToolInteraction | null {
    const session = this.sessions.get(sessionId);
    const tool = session?.tools[id];
    if (!session || tool?.state !== "sent" || status === "open") return null;
    const replies = note?.trim()
      ? [...tool.replies, { from: "agent" as const, text: note.trim(), at: Date.now() }]
      : tool.replies;
    const next: ToolInteraction =
      status === "question"
        ? { ...tool, state: "awaiting-answer", replies }
        : { ...tool, state: "resolved", status, replies };
    session.tools[id] = next;
    this.persist(sessionId);
    return next;
  }

  public setBatch(sessionId: string, batch: ReviewBatch): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.pendingBatch = { batch, delivered: false };
    this.persist(sessionId);
  }

  public getBatch(sessionId: string) {
    return this.sessions.get(sessionId)?.pendingBatch;
  }

  public clearBatch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    delete session.pendingBatch;
    this.persist(sessionId);
  }

  public clearSentFeedback(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const page of Object.values(session.pages)) {
      page.comments = [];
      page.edits = [];
    }
    this.persist(sessionId);
  }

  public persist(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) saveSession(session);
  }

  public remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    deleteSession(sessionId);
  }

  public pruneAll(): { sessions: number; files: number } {
    const sessions = this.sessions.size;
    const files = pruneSessionFiles();
    this.sessions.clear();
    return { sessions, files };
  }
}
