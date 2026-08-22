import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { Store } from "./store";
import { FileWatcher } from "./watcher";
import { readDiffBlobs, type ResolvedDiff } from "../cli/git";
import {
  canonicalTarget,
  ensureStateDir,
  SERVER_PROTOCOL,
  serverRecordPath,
  targetKey,
} from "../cli/paths";
import type {
  FeedbackTurnItem,
  ItemStatus,
  PageFeedback,
  PageMeta,
  ReviewBatch,
  ReviewComment,
  ReviewEdit,
} from "../lib/types";

const STATUSES = new Set<ItemStatus>(["applied", "skipped", "question"]);

const withoutSent = <T extends { sent?: boolean }>({ sent, ...rest }: T) => rest;

/** Bun.serve caps idleTimeout at 255s; a single long poll must finish inside that. */
export const MAX_IDLE_SECS = 255;
/** Server-side long-poll ceiling, under MAX_IDLE_SECS. Longer client waits re-poll. */
export const MAX_POLL_SECS = 240;

export class ReviewServer {
  public store = new Store();
  public watcher: FileWatcher;
  public token = crypto.randomBytes(16).toString("hex");
  public port = 4173;
  private sseClients = new Map<string, Set<ReadableStreamDefaultController>>();
  private pollers = new Map<
    string,
    Set<{ resolve: (batch: ReviewBatch | null) => void; timer: any }>
  >();
  private serverInstance: any = null;
  private staticDir: string;

  constructor(staticDir?: string) {
    this.staticDir = staticDir || path.resolve(__dirname, "../../dist");
    this.watcher = new FileWatcher((file, content, hash) => {
      const key = targetKey(file);
      const page = this.store.pages.get(key);
      if (page) {
        page.content = content;
        page.hash = hash;
        this.emitSessionEvent(key, "reload", { key, file });
      }

      // A diff page is keyed by its range, not its path, so it is found by scan.
      // It only ever gets a staleness flag: swapping its bytes under live
      // comments would move every anchor they point at. A range whose new side is
      // a commit cannot drift, so a working-tree edit says nothing about it.
      for (const [pageKey, candidate] of this.store.pages.entries()) {
        if (candidate.kind !== "diff" || candidate.file !== file || !candidate.liveHead) continue;
        candidate.stale = true;
        this.emitSessionEvent(pageKey, "stale", { key: pageKey, file });
      }
    });
  }

  public emitSessionEvent(pageKey: string, event: string, data: any) {
    for (const [sid, session] of this.store.sessions.entries()) {
      if (session.pageKeys.has(pageKey) || session.entryKey === pageKey) {
        const clients = this.sseClients.get(sid);
        if (clients) {
          const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          for (const c of clients) {
            try {
              c.enqueue(new TextEncoder().encode(payload));
            } catch {
              clients.delete(c);
            }
          }
        }
      }
    }
  }

  private emitToSession(sessionId: string, event: string, data: any) {
    const clients = this.sseClients.get(sessionId);
    if (clients) {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const c of clients) {
        try {
          c.enqueue(new TextEncoder().encode(payload));
        } catch {
          clients.delete(c);
        }
      }
    }
  }

  public agentState(entryKey: string): "listening" | "working" | "stranded" | "idle" {
    const pending = this.store.getBatch(entryKey);
    if (pending && pending.delivered) return "working";
    const pollSet = this.pollers.get(entryKey);
    if (pollSet && pollSet.size > 0) return "listening";
    return pending ? "stranded" : "idle";
  }

  public broadcastAgentState(entryKey: string) {
    const state = this.agentState(entryKey);
    for (const [sid, s] of this.store.sessions.entries()) {
      if (s.entryKey === entryKey) {
        this.emitToSession(sid, "agent", { state });
      }
    }
  }

  /**
   * A delivered annotation is the agent's copy of the record; changing it here
   * would leave the two disagreeing with no way to reconcile.
   */
  private sentAnnotation(key: string, id: string, kind: "comment" | "edit"): Response | null {
    const page = this.store.pages.get(key);
    const found =
      kind === "comment"
        ? page?.comments.find((c) => c.id === id)
        : page?.edits.find((e) => e.id === id);
    if (!found?.sent) return null;
    return Response.json(
      { error: "Already sent to the agent; it can no longer be changed" },
      { status: 409 }
    );
  }

  public pageMeta(key: string): PageMeta {
    const page = this.store.pages.get(key)!;
    const { content, diff, ...meta } = page;
    return {
      ...meta,
      ...(diff ? { status: diff.status } : {}),
    };
  }

  /** Freezes what the agent now holds, so the browser cannot edit it out from under it. */
  private markSent(sessionId: string) {
    const session = this.store.sessions.get(sessionId);
    if (!session) return;
    for (const key of session.pageKeys) {
      const page = this.store.pages.get(key);
      if (!page) continue;
      for (const comment of page.comments) comment.sent = true;
      for (const edit of page.edits) edit.sent = true;
    }
  }

  /** Each Send carries only what the agent has not seen, so a second press never re-delivers. */
  public collectFeedback(sessionId: string): PageFeedback[] {
    const session = this.store.sessions.get(sessionId);
    if (!session) return [];

    const pagesFeedback: PageFeedback[] = [];
    for (const key of session.pageKeys) {
      const page = this.store.pages.get(key);
      if (!page) continue;
      const pending = page.comments.filter((c) => !c.sent);
      const pendingEdits = page.edits.filter((e) => !e.sent);
      if (pending.length === 0 && pendingEdits.length === 0) continue;

      if (page.kind !== "diff" || !page.diff) {
        pagesFeedback.push({
          file: page.file,
          comments: pending.map(withoutSent),
          ...(pendingEdits.length > 0 ? { edits: pendingEdits.map(withoutSent) } : {}),
        });
        continue;
      }

      // A rename has two paths. Old-side comments describe the pre-image, so they
      // are reported against it; everything appliable lands on the new path.
      const oldFile =
        page.diff.oldPath && page.repoRoot
          ? path.join(page.repoRoot, page.diff.oldPath)
          : page.file;
      const oldComments = pending.filter((c) => c.side === "old");
      const newComments = pending.filter((c) => c.side !== "old");

      if (newComments.length > 0 || pendingEdits.length > 0) {
        pagesFeedback.push({
          file: page.file,
          comments: newComments.map(withoutSent),
          ...(pendingEdits.length > 0 ? { edits: pendingEdits.map(withoutSent) } : {}),
        });
      }
      if (oldComments.length > 0) {
        pagesFeedback.push({ file: oldFile, comments: oldComments.map(withoutSent) });
      }
    }
    return pagesFeedback;
  }

  /** The transcript copy of a Send. Must run before markSent, which erases the pending set. */
  private pendingTurnItems(sessionId: string): FeedbackTurnItem[] {
    const session = this.store.sessions.get(sessionId);
    if (!session) return [];

    const items: FeedbackTurnItem[] = [];
    for (const key of session.pageKeys) {
      const page = this.store.pages.get(key);
      if (!page) continue;
      for (const c of page.comments) {
        if (c.sent) continue;
        items.push({
          id: c.id,
          kind: "comment",
          pageKey: key,
          filename: page.filename,
          file: c.file,
          startLine: c.startLine,
          endLine: c.endLine,
          side: c.side,
          quote: c.quote,
          feedback: c.feedback,
        });
      }
      for (const e of page.edits) {
        if (e.sent) continue;
        items.push({
          id: e.id,
          kind: "edit",
          pageKey: key,
          filename: page.filename,
          file: e.file,
          startLine: e.startLine,
          endLine: e.endLine,
          side: e.side,
          originalText: e.originalText,
          suggestedText: e.suggestedText,
        });
      }
    }
    return items;
  }

  public deliverBatch(entryKey: string, batch: ReviewBatch): boolean {
    const pollSet = this.pollers.get(entryKey);
    if (!pollSet || pollSet.size === 0) return false;

    // Copied: the loop deletes from the set it walks.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const poller of [...pollSet]) {
      clearTimeout(poller.timer);
      pollSet.delete(poller);
      poller.resolve(batch);
    }
    return true;
  }

  public async start(requestedPort = 4173): Promise<number> {
    ensureStateDir();
    this.port = requestedPort;

    const findAvailablePort = async (startPort: number): Promise<number> => {
      for (let p = startPort; p < startPort + 50; p++) {
        try {
          const testServer = Bun.serve({
            port: p,
            fetch() {
              return new Response("ok");
            },
          });
          testServer.stop();
          return p;
        } catch {
          // Port taken
        }
      }
      throw new Error("No available port found");
    };

    this.port = await findAvailablePort(this.port);

    this.serverInstance = Bun.serve({
      port: this.port,
      // Long polls hold a request open. Bun's default idleTimeout is 10s and closes
      // the socket mid-wait; 255 is the maximum it accepts.
      idleTimeout: MAX_IDLE_SECS,
      fetch: async (req) => {
        const url = new URL(req.url);
        const route = url.pathname;

        // CORS headers
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, PATCH, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, x-piew-token",
        };

        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        // Health check
        if (route === "/health") {
          return Response.json(
            { ok: true, pid: process.pid, protocol: SERVER_PROTOCOL, port: this.port },
            { headers: corsHeaders }
          );
        }

        // SSE stream: /events?session=s_123
        if (route === "/events") {
          const sid = url.searchParams.get("session") || "default";
          let controllerRef: ReadableStreamDefaultController;

          const stream = new ReadableStream({
            start: (controller) => {
              controllerRef = controller;
              if (!this.sseClients.has(sid)) {
                this.sseClients.set(sid, new Set());
              }
              this.sseClients.get(sid)!.add(controller);

              const session = this.store.sessions.get(sid);
              const state = session ? this.agentState(session.entryKey) : "idle";
              const initPayload = `event: agent\ndata: ${JSON.stringify({ state })}\n\n`;
              controller.enqueue(new TextEncoder().encode(initPayload));
            },
            cancel: () => {
              const clients = this.sseClients.get(sid);
              if (clients) {
                clients.delete(controllerRef);
              }
            },
          });

          return new Response(stream, {
            headers: {
              ...corsHeaders,
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }

        // API routes
        if (route.startsWith("/api/")) {
          // Verify token for state-mutating requests from external callers if needed
          // Local CLI and same-origin browser share session
        }

        // POST /api/session
        if (route === "/api/session" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as {
            files?: string[];
            target?: string;
            file?: string;
            diff?: ResolvedDiff;
          };

          if (body.diff) {
            const sessionInfo = this.store.createDiffSession(body.diff);
            // Watching is only a staleness signal: a diff page's bytes come from
            // git, never from a reload.
            for (const key of sessionInfo.pageKeys) {
              const page = this.store.pages.get(key);
              if (page && fs.existsSync(page.file)) this.watcher.watch(page.file);
            }
            return Response.json(
              {
                sessionId: sessionInfo.id,
                entryKey: sessionInfo.entryKey,
                activeKey: sessionInfo.activeKey,
                pageKeys: sessionInfo.pageKeys,
                path: `/review/${sessionInfo.id}`,
              },
              { headers: corsHeaders }
            );
          }

          const targets = body.files || [body.target || body.file || ""];
          const filePaths: string[] = [];

          for (const t of targets) {
            if (!t) continue;
            const canonical = canonicalTarget(t);
            if (canonical.kind === "file") {
              if (!fs.existsSync(canonical.value)) {
                return Response.json(
                  { error: `File not found: ${canonical.value}` },
                  { status: 404, headers: corsHeaders }
                );
              }
              filePaths.push(canonical.value);
              this.watcher.watch(canonical.value);
            }
          }

          if (filePaths.length === 0) {
            return Response.json(
              { error: "No valid files provided" },
              { status: 400, headers: corsHeaders }
            );
          }

          const sessionInfo = this.store.createSession(filePaths);
          return Response.json(
            {
              sessionId: sessionInfo.id,
              entryKey: sessionInfo.entryKey,
              activeKey: sessionInfo.activeKey,
              pageKeys: sessionInfo.pageKeys,
              path: `/review/${sessionInfo.id}`,
            },
            { headers: corsHeaders }
          );
        }

        // GET /api/sessions (what the landing page lists)
        if (route === "/api/sessions" && req.method === "GET") {
          const sessions = [...this.store.sessions.values()]
            .sort((a, b) => b.lastSeen - a.lastSeen)
            .map((session) => ({
              id: session.id,
              lastSeen: session.lastSeen,
              kind: this.store.pages.get(session.activeKey)?.kind ?? "markdown",
              files: [...session.pageKeys]
                .map((key) => this.store.pages.get(key)?.filename)
                .filter((name): name is string => !!name),
            }))
            .filter((session) => session.files.length > 0);

          return Response.json({ sessions }, { headers: corsHeaders });
        }

        // GET /api/session/:id
        const sessionMatch = route.match(/^\/api\/session\/([a-zA-Z0-9_]+)$/);
        if (sessionMatch && req.method === "GET") {
          const sid = sessionMatch[1];
          const session = this.store.sessions.get(sid);
          if (!session) {
            return Response.json(
              { error: "Session not found" },
              { status: 404, headers: corsHeaders }
            );
          }

          session.lastSeen = Date.now();
          // Metadata only. Content is fetched per page on open, so a 500-file
          // range costs the same first render as a single document.
          const pages: Record<string, PageMeta> = {};
          for (const key of session.pageKeys) {
            const p = this.store.pages.get(key);
            if (p) pages[key] = this.pageMeta(key);
          }

          return Response.json(
            {
              id: session.id,
              entryKey: session.entryKey,
              activeKey: session.activeKey,
              pageKeys: [...session.pageKeys],
              pages,
              turns: session.turns,
              agentState: this.agentState(session.entryKey),
            },
            { headers: corsHeaders }
          );
        }

        // POST /api/session/:id/page (open sibling file)
        const sessionAddMatch = route.match(/^\/api\/session\/([a-zA-Z0-9_]+)\/page$/);
        if (sessionAddMatch && req.method === "POST") {
          const sid = sessionAddMatch[1];
          const body = (await req.json().catch(() => ({}))) as { file: string };
          if (!body.file) {
            return Response.json(
              { error: "Missing file path" },
              { status: 400, headers: corsHeaders }
            );
          }

          const session = this.store.sessions.get(sid);
          if (!session) {
            return Response.json(
              { error: "Session not found" },
              { status: 404, headers: corsHeaders }
            );
          }

          let resolvedPath = body.file;
          if (!path.isAbsolute(body.file)) {
            const activePage = this.store.pages.get(session.activeKey);
            const baseDir = activePage ? path.dirname(activePage.file) : process.cwd();
            resolvedPath = path.resolve(baseDir, body.file);
          }

          const canonical = canonicalTarget(resolvedPath);
          if (!fs.existsSync(canonical.value)) {
            return Response.json(
              { error: `File not found: ${canonical.value}` },
              { status: 404, headers: corsHeaders }
            );
          }

          this.watcher.watch(canonical.value);
          const page = this.store.addPageToSession(sid, canonical.value);
          if (!page) {
            return Response.json(
              { error: "Could not open document" },
              { status: 500, headers: corsHeaders }
            );
          }

          this.emitToSession(sid, "refresh", { activeKey: page.key });
          return Response.json({ page }, { headers: corsHeaders });
        }

        // GET /api/page/:key (content, fetched when a page is opened)
        const pageMatch = route.match(/^\/api\/page\/([a-f0-9]+)$/);
        if (pageMatch && req.method === "GET") {
          const page = this.store.pages.get(pageMatch[1]);
          if (!page)
            return Response.json(
              { error: "Page not found" },
              { status: 404, headers: corsHeaders }
            );

          // Blobs are read here, not at session creation, so opening a 500-file
          // range costs one file's bytes rather than the whole range's.
          if (page.kind === "diff" && page.diff && page.repoRoot && page.range) {
            const source = {
              repoRoot: page.repoRoot,
              range: page.range,
              staged: !!page.staged,
              liveHead: !!page.liveHead,
            };
            // A range against a commit is immutable, so its blobs stay lazy. A
            // working-tree side can move under the comments anchored to it, so the
            // first read freezes it: without that, a restart would re-read the file
            // and point every anchor at whatever it says now.
            // ponytail: frozen blobs ride in state.json; a blob store is only worth
            // it once ranges over huge files start hurting.
            const frozen =
              page.liveHead &&
              (page.diff.newContent !== undefined || page.diff.oldContent !== undefined);

            let diff = page.diff;
            if (!frozen) {
              try {
                diff = readDiffBlobs(source, page.diff);
              } catch (err: any) {
                return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
              }
              if (page.liveHead) {
                page.diff = diff;
                this.store.saveToDisk();
              }
            }
            return Response.json(
              { key: page.key, kind: page.kind, diff, hash: page.hash },
              { headers: corsHeaders }
            );
          }

          return Response.json(
            { key: page.key, kind: page.kind, content: page.content, hash: page.hash },
            { headers: corsHeaders }
          );
        }

        // POST /api/page/:key/refresh (re-run the diff for one stale page)
        const refreshMatch = route.match(/^\/api\/page\/([a-f0-9]+)\/refresh$/);
        if (refreshMatch && req.method === "POST") {
          const key = refreshMatch[1];
          const page = this.store.pages.get(key);
          if (!page || page.kind !== "diff" || !page.diff) {
            return Response.json(
              { error: "Not a diff page" },
              { status: 400, headers: corsHeaders }
            );
          }
          // A committed new side cannot have moved, so re-reading the working
          // tree would quietly turn a historical range into a worktree diff.
          if (!page.liveHead) {
            return Response.json(
              { error: `Range ${page.range} is fixed; nothing to refresh` },
              { status: 400, headers: corsHeaders }
            );
          }

          // Anchors are line numbers into the old content. Refreshing moves them,
          // so the annotations they point at go with it. Blobs are re-read by the
          // next content fetch, which is where every diff page gets its bytes.
          page.comments = [];
          page.edits = [];
          page.stale = false;
          this.emitSessionEvent(key, "refresh", {});
          return Response.json({ ok: true }, { headers: corsHeaders });
        }

        // POST /api/page/:key/comment
        const commentMatch = route.match(/^\/api\/page\/([a-f0-9]+)\/comment$/);
        if (commentMatch && req.method === "POST") {
          const key = commentMatch[1];
          const body = (await req.json().catch(() => ({}))) as Partial<ReviewComment>;
          if (!body.feedback?.trim()) {
            return Response.json(
              { error: "Feedback cannot be empty" },
              { status: 400, headers: corsHeaders }
            );
          }

          const comment: ReviewComment = {
            id: `c_${crypto.randomBytes(4).toString("hex")}`,
            kind: body.kind || "general",
            startLine: body.startLine,
            endLine: body.endLine,
            quote: body.quote,
            feedback: body.feedback.trim(),
            createdAt: Date.now(),
          };

          const commentPage = this.store.pages.get(key);
          if (commentPage?.kind === "diff" && commentPage.diff) {
            // A one-sided file has only one answer, so an omitted or wrong side
            // is corrected rather than left pointing at a path that does not exist.
            const { oldPath, newPath } = commentPage.diff;
            const side = !newPath ? "old" : !oldPath ? "new" : body.side === "old" ? "old" : "new";
            comment.side = side;
            comment.file = side === "old" ? oldPath : newPath;
          }

          const page = this.store.addComment(key, comment);
          if (!page)
            return Response.json(
              { error: "Page not found" },
              { status: 404, headers: corsHeaders }
            );

          this.emitSessionEvent(key, "refresh", { page });
          return Response.json({ comment, page }, { headers: corsHeaders });
        }

        // PATCH /api/page/:key/comment/:id
        const commentPatchMatch = route.match(
          /^\/api\/page\/([a-f0-9]+)\/comment\/([a-zA-Z0-9_]+)$/
        );
        if (commentPatchMatch && req.method === "PATCH") {
          const [, key, commentId] = commentPatchMatch;
          const body = (await req.json().catch(() => ({}))) as { feedback?: string };
          if (!body.feedback?.trim()) {
            return Response.json(
              { error: "Feedback cannot be empty" },
              { status: 400, headers: corsHeaders }
            );
          }
          const frozen = this.sentAnnotation(key, commentId, "comment");
          if (frozen) return frozen;

          const page = this.store.updateComment(key, commentId, body.feedback.trim());
          if (!page)
            return Response.json(
              { error: "Comment not found" },
              { status: 404, headers: corsHeaders }
            );

          this.emitSessionEvent(key, "refresh", { page });
          return Response.json({ ok: true, page }, { headers: corsHeaders });
        }

        // PATCH /api/page/:key/edit/:id
        const editPatchMatch = route.match(/^\/api\/page\/([a-f0-9]+)\/edit\/([a-zA-Z0-9_]+)$/);
        if (editPatchMatch && req.method === "PATCH") {
          const [, key, editId] = editPatchMatch;
          const body = (await req.json().catch(() => ({}))) as { suggestedText?: string };
          if (!body.suggestedText?.trim()) {
            return Response.json(
              { error: "Suggestion cannot be empty" },
              { status: 400, headers: corsHeaders }
            );
          }
          const frozen = this.sentAnnotation(key, editId, "edit");
          if (frozen) return frozen;

          const page = this.store.updateEdit(key, editId, body.suggestedText.trim());
          if (!page)
            return Response.json(
              { error: "Edit not found" },
              { status: 404, headers: corsHeaders }
            );

          this.emitSessionEvent(key, "refresh", { page });
          return Response.json({ ok: true, page }, { headers: corsHeaders });
        }

        // DELETE /api/page/:key/comment/:id
        const commentDelMatch = route.match(/^\/api\/page\/([a-f0-9]+)\/comment\/([a-zA-Z0-9_]+)$/);
        if (commentDelMatch && req.method === "DELETE") {
          const [, key, commentId] = commentDelMatch;
          const frozen = this.sentAnnotation(key, commentId, "comment");
          if (frozen) return frozen;

          const page = this.store.removeComment(key, commentId);
          if (!page)
            return Response.json(
              { error: "Page not found" },
              { status: 404, headers: corsHeaders }
            );

          this.emitSessionEvent(key, "refresh", { page });
          return Response.json({ ok: true, page }, { headers: corsHeaders });
        }

        // POST /api/page/:key/edit
        const editMatch = route.match(/^\/api\/page\/([a-f0-9]+)\/edit$/);
        if (editMatch && req.method === "POST") {
          const key = editMatch[1];
          // `side` arrives from the client unvalidated: an "old" here is a bug to
          // reject, not a value ReviewEdit is allowed to hold.
          const body = (await req.json().catch(() => ({}))) as Omit<Partial<ReviewEdit>, "side"> & {
            side?: "old" | "new";
          };
          if (body.startLine === undefined || body.endLine === undefined || !body.suggestedText) {
            return Response.json(
              { error: "Missing required edit fields" },
              { status: 400, headers: corsHeaders }
            );
          }

          const edit: ReviewEdit = {
            id: `e_${crypto.randomBytes(4).toString("hex")}`,
            startLine: body.startLine,
            endLine: body.endLine,
            originalText: body.originalText || "",
            suggestedText: body.suggestedText,
          };

          const editPage = this.store.pages.get(key);
          if (editPage?.kind === "diff" && editPage.diff) {
            // An old-side line has no post-image counterpart, so no edit can name
            // a line to patch. Comments carry that feedback instead.
            if (body.side === "old" || !editPage.diff.newPath) {
              return Response.json(
                { error: "Suggested edits are only available on the new side of a diff" },
                { status: 400, headers: corsHeaders }
              );
            }
            edit.side = "new";
            if (editPage.diff.newPath) edit.file = editPage.diff.newPath;
          }

          const page = this.store.addEdit(key, edit);
          if (!page)
            return Response.json(
              { error: "Page not found" },
              { status: 404, headers: corsHeaders }
            );

          this.emitSessionEvent(key, "refresh", { page });
          return Response.json({ edit, page }, { headers: corsHeaders });
        }

        // DELETE /api/page/:key/edit/:id
        const editDelMatch = route.match(/^\/api\/page\/([a-f0-9]+)\/edit\/([a-zA-Z0-9_]+)$/);
        if (editDelMatch && req.method === "DELETE") {
          const [, key, editId] = editDelMatch;
          const frozen = this.sentAnnotation(key, editId, "edit");
          if (frozen) return frozen;

          const page = this.store.removeEdit(key, editId);
          if (!page)
            return Response.json(
              { error: "Page not found" },
              { status: 404, headers: corsHeaders }
            );

          this.emitSessionEvent(key, "refresh", { page });
          return Response.json({ ok: true, page }, { headers: corsHeaders });
        }

        // POST /api/send
        if (route === "/api/send" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as {
            sessionId: string;
            overallNote?: string;
          };
          const session = this.store.sessions.get(body.sessionId);
          if (!session) {
            return Response.json(
              { error: "Session not found" },
              { status: 404, headers: corsHeaders }
            );
          }

          const pagesFeedback = this.collectFeedback(body.sessionId);
          if (pagesFeedback.length === 0 && !body.overallNote?.trim()) {
            return Response.json(
              { error: "No feedback or note to send" },
              { status: 400, headers: corsHeaders }
            );
          }

          const batch: ReviewBatch = {
            status: "feedback",
            pages: pagesFeedback,
            overall_note: body.overallNote?.trim() || "",
            sent_at: new Date().toISOString(),
            next_step:
              "Apply this feedback to the respective files. When done, run poll --ack to clear.",
          };

          const turnItems = this.pendingTurnItems(body.sessionId);
          this.markSent(body.sessionId);
          this.store.setBatch(session.entryKey, batch);
          const delivered = this.deliverBatch(session.entryKey, batch);
          if (delivered) {
            const entry = this.store.batches.get(session.entryKey);
            if (entry) entry.delivered = true;
          }

          session.turns.push({
            id: `t_${crypto.randomBytes(6).toString("hex")}`,
            sentAt: batch.sent_at,
            note: batch.overall_note || "",
            delivered,
            items: turnItems,
          });

          this.store.saveToDisk();
          this.broadcastAgentState(session.entryKey);
          return Response.json({ ok: true, delivered }, { headers: corsHeaders });
        }

        // POST /api/respond
        if (route === "/api/respond" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as {
            target?: string;
            note?: string;
            items?: Array<{ id: string; status: ItemStatus; note?: string }>;
          };

          const entryKey = targetKey(canonicalTarget(body.target || "").value);
          const sessions = [...this.store.sessions.values()].filter((s) => s.entryKey === entryKey);
          if (sessions.length === 0) {
            return Response.json(
              { error: "No session for that target" },
              { status: 404, headers: corsHeaders }
            );
          }

          const unknown: string[] = [];
          const items: FeedbackTurnItem[] = [];
          for (const entry of body.items ?? []) {
            if (!entry?.id || !STATUSES.has(entry.status)) {
              unknown.push(entry?.id ?? "");
              continue;
            }
            const hit = this.store.setItemStatus(entryKey, entry.id, entry.status, entry.note);
            if (!hit) {
              unknown.push(entry.id);
              continue;
            }
            const { page, item } = hit;
            items.push({
              id: item.id,
              kind: "suggestedText" in item ? "edit" : "comment",
              status: entry.status,
              pageKey: page.key,
              filename: page.filename,
              file: item.file,
              startLine: item.startLine,
              endLine: item.endLine,
              feedback: entry.note,
            });
            this.emitSessionEvent(page.key, "refresh", { page });
          }

          if (items.length || body.note?.trim()) {
            const turn = {
              id: `t_${crypto.randomBytes(6).toString("hex")}`,
              from: "agent" as const,
              sentAt: new Date().toISOString(),
              note: body.note?.trim() || "",
              delivered: true,
              items,
            };
            // Every browser on this target is looking at the same exchange.
            for (const session of sessions) session.turns.push({ ...turn });
            this.store.saveToDisk();
            this.emitSessionEvent(entryKey, "refresh", {});
          }

          return Response.json({ ok: true, unknown }, { headers: corsHeaders });
        }

        // GET /api/poll?target=<path>&ack=<1|0>&timeout=<seconds>
        if (route === "/api/poll" && req.method === "GET") {
          const target = url.searchParams.get("target") || url.searchParams.get("file") || "";
          if (!target) {
            return Response.json(
              { error: "Missing target parameter" },
              { status: 400, headers: corsHeaders }
            );
          }

          const canonical = canonicalTarget(target);
          const entryKey = targetKey(canonical.value);
          const ack = url.searchParams.get("ack") === "1";
          const timeoutSecs = Number(url.searchParams.get("timeout")) || 0;

          const pending = this.store.getBatch(entryKey);

          // ack clears the batch the caller already handled. A batch that was never
          // delivered is not that batch: hand it over instead of destroying it.
          if (ack && pending?.delivered) {
            this.store.clearBatch(entryKey);
            this.store.clearSentFeedback(entryKey);
            this.emitSessionEvent(entryKey, "refresh", {});
            this.broadcastAgentState(entryKey);
          } else if (ack && !pending) {
            this.store.clearSentFeedback(entryKey);
            this.emitSessionEvent(entryKey, "refresh", {});
            this.broadcastAgentState(entryKey);
          }

          // Re-serve an unacked batch as often as asked: a poll whose response was lost
          // must be able to fetch it again.
          const undelivered = this.store.getBatch(entryKey);
          if (undelivered) {
            undelivered.delivered = true;
            this.broadcastAgentState(entryKey);
            return Response.json(undelivered.batch, { headers: corsHeaders });
          }

          // Long poll. Capped under Bun's idleTimeout so the wait always ends in a
          // response; a client wanting longer re-polls.
          const waitSecs = timeoutSecs > 0 ? Math.min(timeoutSecs, MAX_POLL_SECS) : 0;

          return new Promise<Response>((resolve) => {
            if (!this.pollers.has(entryKey)) {
              this.pollers.set(entryKey, new Set());
            }

            let timer: any = null;
            const pollerRecord = {
              resolve: (batch: ReviewBatch | null) => {
                if (batch) {
                  resolve(Response.json(batch, { headers: corsHeaders }));
                } else {
                  resolve(
                    Response.json(
                      {
                        status: "timeout",
                        waited_seconds: waitSecs,
                        next_step: "No feedback arrived within timeout. Poll again when ready.",
                      },
                      { headers: corsHeaders }
                    )
                  );
                }
              },
              timer: null as any,
            };

            if (waitSecs > 0) {
              timer = setTimeout(() => {
                const pollSet = this.pollers.get(entryKey);
                if (pollSet) pollSet.delete(pollerRecord);
                pollerRecord.resolve(null);
                this.broadcastAgentState(entryKey);
              }, waitSecs * 1000);
              pollerRecord.timer = timer;
            }

            this.pollers.get(entryKey)!.add(pollerRecord);
            this.broadcastAgentState(entryKey);
          });
        }

        // GET /api/status?target=<path>
        if (route === "/api/status" && req.method === "GET") {
          const target = url.searchParams.get("target") || url.searchParams.get("file") || "";
          const canonical = canonicalTarget(target);
          const entryKey = targetKey(canonical.value);

          const pending = this.store.getBatch(entryKey);
          const listening = (this.pollers.get(entryKey) || new Set()).size > 0;

          let unsentComments = 0;
          let unsentEdits = 0;
          for (const p of this.store.pages.values()) {
            unsentComments += p.comments.filter((c) => !c.sent).length;
            unsentEdits += p.edits.filter((e) => !e.sent).length;
          }

          return Response.json(
            {
              status: pending ? "feedback-waiting" : "idle",
              feedback_waiting: !!pending,
              agent_listening: listening,
              server_running: true,
              unsent: {
                comments: unsentComments,
                edits: unsentEdits,
              },
            },
            { headers: corsHeaders }
          );
        }

        // Static files & SPA fallback
        if (fs.existsSync(this.staticDir)) {
          let filePath = path.join(this.staticDir, route === "/" ? "index.html" : route);
          if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            filePath = path.join(this.staticDir, "index.html");
          }

          if (fs.existsSync(filePath)) {
            const file = Bun.file(filePath);
            return new Response(file);
          }
        }

        return new Response("piew", { headers: corsHeaders });
      },
    });

    // Write server.json
    fs.writeFileSync(
      serverRecordPath(),
      JSON.stringify(
        {
          port: this.port,
          protocol: SERVER_PROTOCOL,
          pid: process.pid,
          token: this.token,
          updatedAt: Date.now(),
        },
        null,
        2
      ),
      "utf8"
    );

    return this.port;
  }

  public stop() {
    this.watcher.closeAll();
    if (this.serverInstance) {
      this.serverInstance.stop();
    }
  }
}
