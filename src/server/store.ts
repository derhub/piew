import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gitTarget, stateDataPath, targetKey } from "../cli/paths";
import type { ResolvedDiff } from "../cli/git";
import type {
  FeedbackTurn,
  ItemStatus,
  PageData,
  PageKind,
  ReviewBatch,
  ReviewComment,
  ReviewEdit,
  SessionInfo,
} from "../lib/types";

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

export interface StoredState {
  pages: Record<string, { file: string; comments: ReviewComment[]; edits: ReviewEdit[] }>;
  /** Diff pages carry their own bytes: the working tree has already moved on. */
  diffPages: Record<
    string,
    Omit<PageData, "key" | "content"> & { comments: ReviewComment[]; edits: ReviewEdit[] }
  >;
  sessions: Record<
    string,
    {
      entryKey: string;
      activeKey: string;
      pageKeys: string[];
      lastSeen: number;
      turns: FeedbackTurn[];
    }
  >;
  batches: Record<string, { batch: ReviewBatch; delivered: boolean }>;
}

/** A session older than this is a browser tab nobody came back to. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class Store {
  public pages = new Map<string, PageData>();
  public sessions = new Map<
    string,
    {
      id: string;
      entryKey: string;
      activeKey: string;
      pageKeys: Set<string>;
      lastSeen: number;
      turns: FeedbackTurn[];
    }
  >();
  public batches = new Map<string, { batch: ReviewBatch; delivered: boolean }>();

  constructor() {
    this.loadFromDisk();
  }

  private hash(content: string): string {
    return crypto.createHash("sha1").update(content).digest("hex");
  }

  public openPage(filePath: string): PageData {
    const absPath = path.resolve(filePath);
    const key = targetKey(absPath);
    let content = "";
    if (fs.existsSync(absPath)) {
      content = fs.readFileSync(absPath, "utf8");
    }

    const existing = this.pages.get(key);
    if (existing) {
      this.reloadPage(existing, content);
      return existing;
    }

    const page: PageData = {
      key,
      file: absPath,
      filename: path.basename(absPath),
      kind: kindForFile(absPath),
      content,
      comments: [],
      edits: [],
      hash: this.hash(content),
    };
    this.pages.set(key, page);
    this.saveToDisk();
    return page;
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
      if (!session.pageKeys.has(page.key)) continue;
      for (const turn of session.turns) {
        for (const item of turn.items) {
          if (item.pageKey !== page.key) continue;
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
    const id = `s_${crypto.randomBytes(6).toString("hex")}`;
    const entryKey = targetKey(gitTarget(resolved.repoRoot, resolved.range));
    const pageKeys = new Set<string>();

    for (const diff of resolved.files) {
      const shown = diff.newPath || diff.oldPath || "";
      const abs = path.join(resolved.repoRoot, shown);
      const key = targetKey(`${gitTarget(resolved.repoRoot, resolved.range)}#${shown}`);

      // The key is a pure function of range and path so `piew poll` can rebuild
      // it. Re-running the same range must therefore refresh a page in place,
      // never replace it: a fresh object would drop comments a browser still shows.
      const existing = this.pages.get(key);
      if (existing) {
        existing.diff = diff;
        existing.stale = false;
        pageKeys.add(key);
        continue;
      }

      this.pages.set(key, {
        key,
        file: abs,
        filename: shown,
        kind: "diff",
        content: "",
        diff,
        repoRoot: resolved.repoRoot,
        range: resolved.range,
        staged: resolved.staged,
        liveHead: resolved.liveHead,
        comments: [],
        edits: [],
        hash: this.hash(`${resolved.range}#${shown}#${diff.status}`),
      });
      pageKeys.add(key);
    }

    this.sessions.set(id, {
      id,
      entryKey,
      activeKey: [...pageKeys][0] || entryKey,
      pageKeys,
      lastSeen: Date.now(),
      turns: [],
    });

    // The blobs are frozen with the page, so a restart restores the exact bytes
    // that were reviewed rather than re-running the range against a moved tree.
    this.saveToDisk();
    return { id, entryKey, activeKey: [...pageKeys][0] || entryKey, pageKeys: [...pageKeys] };
  }

  public createSession(files: string[]): SessionInfo {
    const id = `s_${crypto.randomBytes(6).toString("hex")}`;
    const pageKeys = new Set<string>();

    for (const f of files) {
      const page = this.openPage(f);
      pageKeys.add(page.key);
    }

    const firstKey = [...pageKeys][0] || "";
    this.sessions.set(id, {
      id,
      entryKey: firstKey,
      activeKey: firstKey,
      pageKeys,
      lastSeen: Date.now(),
      turns: [],
    });
    this.saveToDisk();

    return {
      id,
      entryKey: firstKey,
      activeKey: firstKey,
      pageKeys: [...pageKeys],
    };
  }

  public addPageToSession(sessionId: string, filePath: string): PageData | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const page = this.openPage(filePath);
    session.pageKeys.add(page.key);
    session.activeKey = page.key;
    return page;
  }

  public addComment(key: string, comment: ReviewComment): PageData | null {
    const page = this.pages.get(key);
    if (!page) return null;
    page.comments.push(comment);
    this.saveToDisk();
    return page;
  }

  public updateComment(key: string, commentId: string, feedback: string): PageData | null {
    const page = this.pages.get(key);
    const comment = page?.comments.find((c) => c.id === commentId);
    if (!page || !comment) return null;
    comment.feedback = feedback;
    this.saveToDisk();
    return page;
  }

  public updateEdit(key: string, editId: string, suggestedText: string): PageData | null {
    const page = this.pages.get(key);
    const edit = page?.edits.find((e) => e.id === editId);
    if (!page || !edit) return null;
    edit.suggestedText = suggestedText;
    this.saveToDisk();
    return page;
  }

  public removeComment(key: string, commentId: string): PageData | null {
    const page = this.pages.get(key);
    if (!page) return null;
    page.comments = page.comments.filter((c) => c.id !== commentId);
    this.saveToDisk();
    return page;
  }

  public addEdit(key: string, edit: ReviewEdit): PageData | null {
    const page = this.pages.get(key);
    if (!page) return null;
    page.edits.push(edit);
    this.saveToDisk();
    return page;
  }

  public removeEdit(key: string, editId: string): PageData | null {
    const page = this.pages.get(key);
    if (!page) return null;
    page.edits = page.edits.filter((e) => e.id !== editId);
    this.saveToDisk();
    return page;
  }

  /**
   * The agent's verdict on one delivered annotation. An item it never received
   * is refused: a status on unsent work would claim an exchange that never happened.
   */
  public setItemStatus(
    entryKey: string,
    id: string,
    status: ItemStatus,
    note?: string
  ): { page: PageData; item: ReviewComment | ReviewEdit } | null {
    // One target can be open in several browser sessions; the annotation lives on
    // the page, so any session that shows it can be the one that found it.
    const keys = new Set<string>([entryKey]);
    for (const session of this.sessions.values()) {
      if (session.entryKey === entryKey) for (const key of session.pageKeys) keys.add(key);
    }

    for (const key of keys) {
      const page = this.pages.get(key);
      if (!page) continue;

      const item = page.comments.find((c) => c.id === id) ?? page.edits.find((e) => e.id === id);
      if (!item || !item.sent) continue;

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

  public setBatch(entryKey: string, batch: ReviewBatch) {
    this.batches.set(entryKey, { batch, delivered: false });
    this.saveToDisk();
  }

  public getBatch(entryKey: string) {
    return this.batches.get(entryKey);
  }

  public clearBatch(entryKey: string) {
    this.batches.delete(entryKey);
    this.saveToDisk();
  }

  public clearSentFeedback(entryKey: string) {
    const session = [...this.sessions.values()].find((s) => s.entryKey === entryKey);
    const keysToClean = session ? session.pageKeys : new Set([entryKey]);
    for (const key of keysToClean) {
      const page = this.pages.get(key);
      if (page) {
        page.comments = [];
        page.edits = [];
      }
    }
    this.saveToDisk();
  }

  /** Called by the server too: a turn is state the browser must get back after a restart. */
  public saveToDisk() {
    try {
      const data: StoredState = {
        pages: {},
        diffPages: {},
        sessions: {},
        batches: {},
      };
      for (const [key, p] of this.pages.entries()) {
        if (p.kind === "diff") {
          const { key: _key, content: _content, ...rest } = p;
          data.diffPages[key] = rest;
          continue;
        }
        if (p.comments.length || p.edits.length) {
          data.pages[key] = { file: p.file, comments: p.comments, edits: p.edits };
        }
      }
      for (const [id, session] of this.sessions.entries()) {
        data.sessions[id] = {
          entryKey: session.entryKey,
          activeKey: session.activeKey,
          pageKeys: [...session.pageKeys],
          lastSeen: session.lastSeen,
          turns: session.turns,
        };
      }
      for (const [k, b] of this.batches.entries()) {
        data.batches[k] = b;
      }
      fs.writeFileSync(stateDataPath(), JSON.stringify(data, null, 2), "utf8");
    } catch {
      // Disk write error ignored
    }
  }

  private loadFromDisk() {
    try {
      const raw = fs.readFileSync(stateDataPath(), "utf8");
      const data: StoredState = JSON.parse(raw);
      if (data.pages) {
        for (const [key, p] of Object.entries(data.pages)) {
          if (fs.existsSync(p.file)) {
            const content = fs.readFileSync(p.file, "utf8");
            this.pages.set(key, {
              key,
              file: p.file,
              filename: path.basename(p.file),
              kind: kindForFile(p.file),
              content,
              comments: p.comments || [],
              edits: p.edits || [],
              hash: this.hash(content),
            });
          }
        }
      }
      if (data.diffPages) {
        for (const [key, p] of Object.entries(data.diffPages)) {
          this.pages.set(key, { ...p, key, content: "" });
        }
      }
      if (data.sessions) {
        const cutoff = Date.now() - SESSION_TTL_MS;
        for (const [id, session] of Object.entries(data.sessions)) {
          if (session.lastSeen < cutoff) continue;
          // A page the store could not restore would render as an empty tab.
          const pageKeys = new Set(session.pageKeys.filter((k) => this.pages.has(k)));
          if (pageKeys.size === 0) continue;
          this.sessions.set(id, {
            id,
            entryKey: session.entryKey,
            activeKey: pageKeys.has(session.activeKey) ? session.activeKey : [...pageKeys][0],
            pageKeys,
            lastSeen: session.lastSeen,
            turns: session.turns || [],
          });
        }
      }
      for (const page of this.pages.values()) {
        if (page.kind === "diff") continue;
        for (const comment of page.comments) reanchor(comment, comment.quote, page.content);
        for (const edit of page.edits) reanchor(edit, edit.originalText, page.content);
        this.syncTurnAnchors(page);
      }
      if (data.batches) {
        for (const [k, b] of Object.entries(data.batches)) {
          this.batches.set(k, b);
        }
      }
    } catch {
      // First run or missing state file
    }
  }
}
