import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { ReviewMapError, Store } from "./store";
import { FileWatcher } from "./watcher";
import { readDiffBlobs, type ResolvedDiff } from "../cli/git";
import { canonicalTarget, ensureStateDir, SERVER_PROTOCOL, serverRecordPath } from "../cli/paths";
import { discoverToolPackages } from "../lib/tools";
import {
  CompilerError,
  compileTool,
  deleteToolArtifact,
  readToolArtifact,
  writeToolArtifact,
  type CompilerSource,
} from "./tool-files";
import type {
  FeedbackTurnItem,
  ItemStatus,
  JsonValue,
  PageFeedback,
  PageMeta,
  ReviewBatch,
  ReviewComment,
  ReviewEdit,
} from "../lib/types";

const STATUSES = new Set<ItemStatus>(["applied", "skipped", "question"]);
const MAX_TOOL_JSON_BYTES = 64 * 1024;
const TOOL_TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".svg",
  ".ts",
  ".tsx",
  ".txt",
]);
const TOOL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "media-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    !!value &&
    typeof value === "object" &&
    Object.values(value as Record<string, unknown>).every(isJsonValue)
  );
}

function toolContentType(file: string): string {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".avif") return "image/avif";
  return "application/octet-stream";
}

function readToolSource(file: string): CompilerSource {
  const content = fs.readFileSync(file);
  return TOOL_TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())
    ? content.toString("utf8")
    : { encoding: "base64", content: content.toString("base64") };
}

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
    Set<{
      resolve: (batch: ReviewBatch | null) => void;
      timer: ReturnType<typeof setTimeout> | null;
    }>
  >();
  private serverInstance: any = null;
  private staticDir: string;

  constructor(staticDir?: string) {
    this.staticDir = staticDir || path.resolve(__dirname, "../../dist");
    this.watcher = new FileWatcher((file, content, hash) => {
      for (const [sessionId, session] of this.store.sessions) {
        for (const page of Object.values(session.pages)) {
          if (page.file !== file) continue;
          if (page.kind === "diff") {
            if (!page.liveHead) continue;
            page.stale = true;
            this.store.persist(sessionId);
            this.emitToSession(sessionId, "stale", { pageId: page.id, file });
          } else {
            this.store.reloadPage(sessionId, page, content, hash);
            this.emitToSession(sessionId, "reload", { pageId: page.id, file });
          }
        }
      }
    });
    for (const session of this.store.sessions.values()) this.watchSessionSources(session);
  }

  private watchSessionSources(session: {
    pages: Record<string, { file: string; kind: string; liveHead?: boolean }>;
  }): void {
    for (const page of Object.values(session.pages)) {
      if (page.kind === "diff" && !page.liveHead) continue;
      if (fs.existsSync(page.file)) this.watcher.watch(page.file);
    }
    const referenced = new Set(
      [...this.store.sessions.values()].flatMap((stored) =>
        Object.values(stored.pages)
          .filter((page) => page.kind !== "diff" || page.liveHead)
          .map((page) => page.file)
      )
    );
    for (const file of this.watcher.paths()) {
      if (!referenced.has(file)) this.watcher.unwatch(file);
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
      if (clients.size === 0) this.sseClients.delete(sessionId);
    }
  }

  private releaseSessionResources(sessionId: string) {
    const clients = this.sseClients.get(sessionId);
    if (clients) {
      for (const client of clients) {
        try {
          client.close();
        } catch {}
      }
      this.sseClients.delete(sessionId);
    }

    const pollSet = this.pollers.get(sessionId);
    if (pollSet) {
      for (const poller of pollSet) {
        if (poller.timer) clearTimeout(poller.timer);
        poller.resolve(null);
      }
      this.pollers.delete(sessionId);
    }
  }

  public pruneAllSessions(): { sessions: number; files: number } {
    for (const sessionId of this.store.sessions.keys()) this.releaseSessionResources(sessionId);
    this.watcher.closeAll();
    const result = this.store.pruneAll();
    return result;
  }

  public resourceCounts() {
    let sse = 0;
    let pollers = 0;
    let timers = 0;
    for (const clients of this.sseClients.values()) sse += clients.size;
    for (const pollSet of this.pollers.values()) {
      pollers += pollSet.size;
      for (const poller of pollSet) timers += poller.timer ? 1 : 0;
    }
    return {
      sessions: this.store.sessions.size,
      watchers: this.watcher.count(),
      sse,
      pollers,
      timers,
    };
  }

  public agentState(sessionId: string): "listening" | "working" | "stranded" | "idle" {
    const pending = this.store.getBatch(sessionId);
    if (pending && pending.delivered) return "working";
    const pollSet = this.pollers.get(sessionId);
    if (pollSet && pollSet.size > 0) return "listening";
    return pending ? "stranded" : "idle";
  }

  public broadcastAgentState(sessionId: string) {
    this.emitToSession(sessionId, "agent", { state: this.agentState(sessionId) });
  }

  /**
   * A delivered annotation is the agent's copy of the record; changing it here
   * would leave the two disagreeing with no way to reconcile.
   */
  private sentAnnotation(
    sessionId: string,
    pageId: string,
    id: string,
    kind: "comment" | "edit"
  ): Response | null {
    const page = this.store.getPage(sessionId, pageId);
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

  public pageMeta(sessionId: string, pageId: string): PageMeta {
    const page = this.store.getPage(sessionId, pageId)!;
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
    for (const page of Object.values(session.pages)) {
      for (const comment of page.comments) comment.sent = true;
      for (const edit of page.edits) edit.sent = true;
    }
    this.store.markToolsSent(
      sessionId,
      Object.values(session.tools)
        .filter((tool) => tool.state === "ready")
        .map((tool) => tool.id)
    );
  }

  /** Each Send carries only what the agent has not seen, so a second press never re-delivers. */
  public collectFeedback(sessionId: string): PageFeedback[] {
    const session = this.store.sessions.get(sessionId);
    if (!session) return [];

    const pagesFeedback: PageFeedback[] = [];
    for (const page of Object.values(session.pages)) {
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
    for (const [key, page] of Object.entries(session.pages)) {
      for (const c of page.comments) {
        if (c.sent) continue;
        items.push({
          id: c.id,
          kind: "comment",
          pageId: key,
          filename: page.filename,
          file: c.file,
          startLine: c.startLine,
          endLine: c.endLine,
          side: c.side,
          quote: c.quote,
          feedback: c.feedback,
          orphaned: c.orphaned,
        });
      }
      for (const e of page.edits) {
        if (e.sent) continue;
        items.push({
          id: e.id,
          kind: "edit",
          pageId: key,
          filename: page.filename,
          file: e.file,
          startLine: e.startLine,
          endLine: e.endLine,
          side: e.side,
          originalText: e.originalText,
          suggestedText: e.suggestedText,
          orphaned: e.orphaned,
        });
      }
    }
    for (const tool of Object.values(session.tools)) {
      if (tool.state !== "ready") continue;
      items.push({
        id: tool.id,
        kind: "tool",
        tool: tool.tool,
        result: tool.result,
        replies: tool.replies,
        anchor: tool.request.anchor,
      });
    }
    return items;
  }

  public deliverBatch(sessionId: string, batch: ReviewBatch): boolean {
    const pollSet = this.pollers.get(sessionId);
    if (!pollSet || pollSet.size === 0) return false;

    // Copied: the loop deletes from the set it walks.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const poller of [...pollSet]) {
      clearTimeout(poller.timer);
      pollSet.delete(poller);
      poller.resolve(batch);
    }
    this.pollers.delete(sessionId);
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

        if (route === "/shutdown" && req.method === "POST") {
          if (req.headers.get("x-piew-token") !== this.token) {
            return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
          }
          setTimeout(() => this.stop(), 10);
          return Response.json({ ok: true }, { headers: corsHeaders });
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
              const state = session ? this.agentState(sid) : "idle";
              const initPayload = `event: agent\ndata: ${JSON.stringify({ state })}\n\n`;
              controller.enqueue(new TextEncoder().encode(initPayload));
            },
            cancel: () => {
              const clients = this.sseClients.get(sid);
              if (clients) {
                clients.delete(controllerRef);
                if (clients.size === 0) this.sseClients.delete(sid);
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
            const captured: ResolvedDiff = { ...body.diff, files: [] };
            for (const file of body.diff.files) {
              try {
                captured.files.push(readDiffBlobs(body.diff, file));
              } catch (error) {
                const name = file.newPath || file.oldPath || "unknown page";
                const message = error instanceof Error ? error.message : String(error);
                return Response.json(
                  { error: `Failed to capture ${name}: ${message}` },
                  { status: 500, headers: corsHeaders }
                );
              }
            }
            const sessionInfo = this.store.createDiffSession(captured);
            const session = this.store.sessions.get(sessionInfo.id)!;
            this.watchSessionSources(session);
            return Response.json(
              {
                sessionId: sessionInfo.id,
                activePageId: sessionInfo.activePageId,
                reviewMap: sessionInfo.reviewMap,
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
            }
          }

          if (filePaths.length === 0) {
            return Response.json(
              { error: "No valid files provided" },
              { status: 400, headers: corsHeaders }
            );
          }

          const sessionInfo = this.store.createSession(filePaths);
          this.watchSessionSources(this.store.sessions.get(sessionInfo.id)!);
          return Response.json(
            {
              sessionId: sessionInfo.id,
              activePageId: sessionInfo.activePageId,
              reviewMap: sessionInfo.reviewMap,
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
              title: session.reviewMap.title,
              kind: session.pages[session.activePageId]?.kind ?? "markdown",
              files: session.reviewMap.items
                .map((item) => session.pages[item.pageId]?.filename)
                .filter(Boolean),
            }))
            .filter((session) => session.files.length > 0);

          return Response.json({ sessions }, { headers: corsHeaders });
        }

        if (route === "/api/sessions" && req.method === "DELETE") {
          if (req.headers.get("x-piew-token") !== this.token) {
            return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
          }
          return Response.json(this.pruneAllSessions(), { headers: corsHeaders });
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

          // Metadata only. Content is fetched per page on open, so a 500-file
          // range costs the same first render as a single document.
          const pages: Record<string, PageMeta> = {};
          for (const pageId of Object.keys(session.pages)) {
            pages[pageId] = this.pageMeta(sid, pageId);
          }

          return Response.json(
            {
              id: session.id,
              activePageId: session.activePageId,
              reviewMap: session.reviewMap,
              pages,
              turns: session.turns,
              tools: session.tools,
              agentState: this.agentState(sid),
            },
            { headers: corsHeaders }
          );
        }

        const mapMatch = route.match(/^\/api\/session\/([a-zA-Z0-9_]+)\/map$/);
        if (mapMatch && req.method === "PUT") {
          try {
            const info = this.store.replaceReviewMap(mapMatch[1], await req.json());
            const session = this.store.sessions.get(info.id)!;
            const reloadedPageIds: string[] = [];
            for (const page of Object.values(session.pages)) {
              if (page.kind === "diff") continue;
              try {
                const content = fs.readFileSync(page.file, "utf8");
                const hash = this.watcher.hash(content);
                if (hash === page.hash) continue;
                this.store.reloadPage(info.id, page, content, hash);
                this.watcher.setLastHash(page.file, hash);
                reloadedPageIds.push(page.id);
              } catch {
                // Keep the captured page when its source is temporarily unavailable.
              }
            }
            this.watchSessionSources(session);
            this.emitToSession(info.id, "refresh", { reviewMap: info.reviewMap });
            for (const pageId of reloadedPageIds) {
              this.emitToSession(info.id, "reload", { pageId });
            }
            return Response.json(
              { reviewMap: info.reviewMap, activePageId: info.activePageId },
              { headers: corsHeaders }
            );
          } catch (error) {
            if (error instanceof ReviewMapError) {
              return Response.json(
                { error: error.message },
                { status: error.status, headers: corsHeaders }
              );
            }
            return Response.json(
              { error: "Invalid Review Map" },
              { status: 400, headers: corsHeaders }
            );
          }
        }

        const mediaMatch = route.match(
          /^\/api\/session\/([a-zA-Z0-9_]+)\/page\/([a-zA-Z0-9_]+)\/media$/
        );
        if (mediaMatch && req.method === "GET") {
          const [, sid, pageId] = mediaMatch;
          const page = this.store.getPage(sid, pageId);
          const requested = url.searchParams.get("path");
          if (!page || !requested) return new Response(null, { status: 404, headers: corsHeaders });

          try {
            const root = fs.realpathSync(path.dirname(page.file));
            const filePath = fs.realpathSync(path.resolve(root, requested));
            const relative = path.relative(root, filePath);
            if (
              relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative) ||
              !fs.statSync(filePath).isFile()
            ) {
              return new Response(null, { status: 404, headers: corsHeaders });
            }

            const file = Bun.file(filePath);
            const type = file.type.split(";", 1)[0];
            if (
              !type.startsWith("image/") &&
              !type.startsWith("video/") &&
              !type.startsWith("audio/") &&
              type !== "text/vtt"
            ) {
              return new Response(null, { status: 404, headers: corsHeaders });
            }
            return new Response(file, {
              headers: { ...corsHeaders, "Cache-Control": "no-store" },
            });
          } catch {
            return new Response(null, { status: 404, headers: corsHeaders });
          }
        }

        const pageMatch = route.match(/^\/api\/session\/([a-zA-Z0-9_]+)\/page\/([a-zA-Z0-9_]+)$/);
        if (pageMatch && req.method === "GET") {
          const [, sid, pageId] = pageMatch;
          const page = this.store.getPage(sid, pageId);
          if (!page)
            return Response.json(
              {
                code: "page-missing",
                message: "Page not found",
                retryable: false,
              },
              { status: 404, headers: corsHeaders }
            );

          if (page.kind === "diff") {
            if (!page.diff) {
              return Response.json(
                {
                  code: "page-corrupt",
                  message: `Captured diff is missing for ${page.filename}`,
                  retryable: false,
                },
                { status: 500, headers: corsHeaders }
              );
            }
            return Response.json(
              { id: page.id, kind: page.kind, diff: page.diff, hash: page.hash },
              { headers: corsHeaders }
            );
          }

          return Response.json(
            { id: page.id, kind: page.kind, content: page.content, hash: page.hash },
            { headers: corsHeaders }
          );
        }

        const refreshMatch = route.match(
          /^\/api\/session\/([a-zA-Z0-9_]+)\/page\/([a-zA-Z0-9_]+)\/refresh$/
        );
        if (refreshMatch && req.method === "POST") {
          const [, sid, pageId] = refreshMatch;
          const page = this.store.getPage(sid, pageId);
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

          const source = {
            repoRoot: page.repoRoot!,
            range: page.range!,
            staged: !!page.staged,
            liveHead: true,
          };
          let diff;
          try {
            diff = readDiffBlobs(source, page.diff);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return Response.json(
              { code: "page-missing", message, retryable: true },
              { status: 500, headers: corsHeaders }
            );
          }

          page.comments = [];
          page.edits = [];
          page.diff = diff;
          page.stale = false;
          this.store.persist(sid);
          this.emitToSession(sid, "refresh", { pageId });
          return Response.json({ ok: true }, { headers: corsHeaders });
        }

        const commentMatch = route.match(
          /^\/api\/session\/([a-zA-Z0-9_]+)\/page\/([a-zA-Z0-9_]+)\/comment$/
        );
        if (commentMatch && req.method === "POST") {
          const [, sid, pageId] = commentMatch;
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

          const commentPage = this.store.getPage(sid, pageId);
          if (commentPage?.kind === "diff" && commentPage.diff) {
            // A one-sided file has only one answer, so an omitted or wrong side
            // is corrected rather than left pointing at a path that does not exist.
            const { oldPath, newPath } = commentPage.diff;
            const side = !newPath ? "old" : !oldPath ? "new" : body.side === "old" ? "old" : "new";
            comment.side = side;
            comment.file = side === "old" ? oldPath : newPath;
          }

          const page = this.store.addComment(sid, pageId, comment);
          if (!page)
            return Response.json(
              { error: "Page not found" },
              { status: 404, headers: corsHeaders }
            );

          this.emitToSession(sid, "refresh", { pageId });
          return Response.json({ comment, page }, { headers: corsHeaders });
        }

        const commentPatchMatch = route.match(
          /^\/api\/session\/([a-zA-Z0-9_]+)\/page\/([a-zA-Z0-9_]+)\/comment\/([a-zA-Z0-9_]+)$/
        );
        if (commentPatchMatch && req.method === "PATCH") {
          const [, sid, pageId, commentId] = commentPatchMatch;
          const body = (await req.json().catch(() => ({}))) as { feedback?: string };
          if (!body.feedback?.trim()) {
            return Response.json(
              { error: "Feedback cannot be empty" },
              { status: 400, headers: corsHeaders }
            );
          }
          const frozen = this.sentAnnotation(sid, pageId, commentId, "comment");
          if (frozen) return frozen;

          const page = this.store.updateComment(sid, pageId, commentId, body.feedback.trim());
          if (!page)
            return Response.json(
              { error: "Comment not found" },
              { status: 404, headers: corsHeaders }
            );

          this.emitToSession(sid, "refresh", { pageId });
          return Response.json({ ok: true, page }, { headers: corsHeaders });
        }

        const editPatchMatch = route.match(
          /^\/api\/session\/([a-zA-Z0-9_]+)\/page\/([a-zA-Z0-9_]+)\/edit\/([a-zA-Z0-9_]+)$/
        );
        if (editPatchMatch && req.method === "PATCH") {
          const [, sid, pageId, editId] = editPatchMatch;
          const body = (await req.json().catch(() => ({}))) as { suggestedText?: string };
          if (!body.suggestedText?.trim()) {
            return Response.json(
              { error: "Suggestion cannot be empty" },
              { status: 400, headers: corsHeaders }
            );
          }
          const frozen = this.sentAnnotation(sid, pageId, editId, "edit");
          if (frozen) return frozen;

          const page = this.store.updateEdit(sid, pageId, editId, body.suggestedText.trim());
          if (!page)
            return Response.json(
              { error: "Edit not found" },
              { status: 404, headers: corsHeaders }
            );

          this.emitToSession(sid, "refresh", { pageId });
          return Response.json({ ok: true, page }, { headers: corsHeaders });
        }

        const commentDelMatch = commentPatchMatch;
        if (commentDelMatch && req.method === "DELETE") {
          const [, sid, pageId, commentId] = commentDelMatch;
          const frozen = this.sentAnnotation(sid, pageId, commentId, "comment");
          if (frozen) return frozen;

          const page = this.store.removeComment(sid, pageId, commentId);
          if (!page)
            return Response.json(
              { error: "Page not found" },
              { status: 404, headers: corsHeaders }
            );

          this.emitToSession(sid, "refresh", { pageId });
          return Response.json({ ok: true, page }, { headers: corsHeaders });
        }

        const editMatch = route.match(
          /^\/api\/session\/([a-zA-Z0-9_]+)\/page\/([a-zA-Z0-9_]+)\/edit$/
        );
        if (editMatch && req.method === "POST") {
          const [, sid, pageId] = editMatch;
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

          const editPage = this.store.getPage(sid, pageId);
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

          const page = this.store.addEdit(sid, pageId, edit);
          if (!page)
            return Response.json(
              { error: "Page not found" },
              { status: 404, headers: corsHeaders }
            );

          this.emitToSession(sid, "refresh", { pageId });
          return Response.json({ edit, page }, { headers: corsHeaders });
        }

        const editDelMatch = editPatchMatch;
        if (editDelMatch && req.method === "DELETE") {
          const [, sid, pageId, editId] = editDelMatch;
          const frozen = this.sentAnnotation(sid, pageId, editId, "edit");
          if (frozen) return frozen;

          const page = this.store.removeEdit(sid, pageId, editId);
          if (!page)
            return Response.json(
              { error: "Page not found" },
              { status: 404, headers: corsHeaders }
            );

          this.emitToSession(sid, "refresh", { pageId });
          return Response.json({ ok: true, page }, { headers: corsHeaders });
        }

        const toolArtifactMatch = route.match(
          /^\/api\/session\/([a-zA-Z0-9_]+)\/tool\/([a-zA-Z0-9_]+)(?:\/(.+))?$/
        );
        if (toolArtifactMatch && req.method === "GET") {
          const [, sessionId, interactionId, requested = "index.html"] = toolArtifactMatch;
          const interaction = this.store.sessions.get(sessionId)?.tools[interactionId];
          if (!interaction) {
            return Response.json(
              { error: "Tool interaction not found" },
              { status: 404, headers: corsHeaders }
            );
          }
          const content = readToolArtifact(sessionId, interactionId, requested);
          if (!content) {
            return Response.json(
              { error: "Tool artifact not found" },
              { status: 404, headers: corsHeaders }
            );
          }
          return new Response(content, {
            headers: {
              "Content-Type": toolContentType(requested),
              "Content-Security-Policy": TOOL_CSP,
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "private, max-age=31536000, immutable",
            },
          });
        }

        const toolInvokeMatch = route.match(
          /^\/api\/session\/([a-zA-Z0-9_]+)\/tool\/([a-zA-Z0-9_-]+)$/
        );
        if (toolInvokeMatch && req.method === "POST") {
          const [, sessionId, toolName] = toolInvokeMatch;
          const session = this.store.sessions.get(sessionId);
          if (!session) {
            return Response.json(
              { error: "Session not found" },
              { status: 404, headers: corsHeaders }
            );
          }
          const raw = await req.text();
          if (new TextEncoder().encode(raw).byteLength > MAX_TOOL_JSON_BYTES) {
            return Response.json(
              { error: "Tool request exceeds 64 KiB" },
              { status: 413, headers: corsHeaders }
            );
          }
          let request: Record<string, unknown>;
          try {
            request = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            return Response.json(
              { error: "Invalid tool request JSON" },
              { status: 400, headers: corsHeaders }
            );
          }
          if (
            !request ||
            typeof request !== "object" ||
            Array.isArray(request) ||
            typeof request.prompt !== "string" ||
            !("data" in request) ||
            !isJsonValue(request.data)
          ) {
            return Response.json(
              { error: "Tool request requires prompt and JSON data" },
              { status: 400, headers: corsHeaders }
            );
          }
          let anchor: { pageId: string; line: number } | undefined;
          if (request.anchor !== undefined) {
            const value = request.anchor as Record<string, unknown>;
            if (
              !value ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              typeof value.pageId !== "string" ||
              !session.pages[value.pageId] ||
              !Number.isInteger(value.line) ||
              (value.line as number) < 1
            ) {
              return Response.json(
                { error: "Tool anchor must reference a session page and positive line" },
                { status: 400, headers: corsHeaders }
              );
            }
            anchor = { pageId: value.pageId, line: value.line as number };
          }

          const discovery = discoverToolPackages();
          const tool = discovery.packages.find((candidate) => candidate.name === toolName);
          if (!tool) {
            const invalid = discovery.invalid.find((message) => message.startsWith(`${toolName}:`));
            return Response.json(
              { error: invalid || `Unknown tool package: ${toolName}` },
              { status: invalid ? 400 : 404, headers: corsHeaders }
            );
          }

          const interactionId = `ti_${crypto.randomBytes(6).toString("hex")}`;
          let artifactWritten = false;
          try {
            const files = Object.fromEntries(
              tool.files.map((file) => [file, readToolSource(path.join(tool.directory, file))])
            );
            const compiled = await compileTool({ entry: tool.entry, files });
            const artifact = writeToolArtifact(sessionId, interactionId, compiled.contents);
            artifactWritten = true;
            const added = this.store.addTool(sessionId, {
              id: interactionId,
              tool: tool.name,
              state: "open",
              request: {
                prompt: request.prompt,
                data: request.data,
                ...(anchor ? { anchor } : {}),
              },
              artifact,
              createdAt: Date.now(),
              replies: [],
            });
            if (!added) {
              deleteToolArtifact(sessionId, interactionId);
              artifactWritten = false;
              return Response.json(
                { error: "Session was removed while compiling the tool" },
                { status: 404, headers: corsHeaders }
              );
            }
            this.emitToSession(sessionId, "refresh", {});
            return Response.json(
              { status: "open", id: interactionId, tool: tool.name },
              { headers: corsHeaders }
            );
          } catch (error) {
            if (artifactWritten) {
              deleteToolArtifact(sessionId, interactionId);
            }
            const message = error instanceof Error ? error.message : String(error);
            return Response.json(
              { error: message },
              { status: error instanceof CompilerError ? 400 : 500, headers: corsHeaders }
            );
          }
        }

        const toolActionMatch = route.match(
          /^\/api\/session\/([a-zA-Z0-9_]+)\/tool\/([a-zA-Z0-9_]+)\/action$/
        );
        if (toolActionMatch && req.method === "POST") {
          const [, sessionId, interactionId] = toolActionMatch;
          const session = this.store.sessions.get(sessionId);
          if (!session) {
            return Response.json(
              { error: "Session not found" },
              { status: 404, headers: corsHeaders }
            );
          }
          if (!session.tools[interactionId]) {
            return Response.json(
              { error: "Tool interaction not found" },
              { status: 404, headers: corsHeaders }
            );
          }

          const raw = await req.text();
          if (new TextEncoder().encode(raw).byteLength > MAX_TOOL_JSON_BYTES) {
            return Response.json(
              { error: "Tool action exceeds 64 KiB" },
              { status: 413, headers: corsHeaders }
            );
          }
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            return Response.json(
              { error: "Invalid tool action JSON" },
              { status: 400, headers: corsHeaders }
            );
          }

          const action =
            body.action === "submit" && "value" in body && isJsonValue(body.value)
              ? ({ type: "submit", value: body.value } as const)
              : body.action === "dismiss"
                ? ({ type: "dismiss" } as const)
                : body.action === "reset"
                  ? ({ type: "reset" } as const)
                  : body.action === "reply" && typeof body.text === "string"
                    ? ({ type: "reply", text: body.text } as const)
                    : null;
          if (!action) {
            return Response.json(
              { error: "Invalid tool action" },
              { status: 400, headers: corsHeaders }
            );
          }
          const interaction = this.store.actOnTool(sessionId, interactionId, action);
          if (!interaction) {
            return Response.json(
              { error: "Tool action is not valid in the current state" },
              { status: 409, headers: corsHeaders }
            );
          }
          this.emitToSession(sessionId, "refresh", {});
          return Response.json({ ok: true, interaction }, { headers: corsHeaders });
        }

        const sendMatch = route.match(/^\/api\/session\/([a-zA-Z0-9_]+)\/send$/);
        if (sendMatch && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as {
            overallNote?: string;
          };
          const sessionId = sendMatch[1];
          const session = this.store.sessions.get(sessionId);
          if (!session) {
            return Response.json(
              { error: "Session not found" },
              { status: 404, headers: corsHeaders }
            );
          }

          if (session.pendingBatch) {
            return Response.json(
              { error: "A feedback batch is still awaiting acknowledgement" },
              { status: 409, headers: corsHeaders }
            );
          }

          const pagesFeedback = this.collectFeedback(sessionId);
          const toolsFeedback = this.store.readyTools(sessionId);
          if (
            pagesFeedback.length === 0 &&
            toolsFeedback.length === 0 &&
            !body.overallNote?.trim()
          ) {
            return Response.json(
              { error: "No feedback or note to send" },
              { status: 400, headers: corsHeaders }
            );
          }

          const batch: ReviewBatch = {
            status: "feedback",
            pages: pagesFeedback,
            ...(toolsFeedback.length ? { tools: toolsFeedback } : {}),
            overall_note: body.overallNote?.trim() || "",
            sent_at: new Date().toISOString(),
            next_step:
              "Apply this feedback to the respective files. When done, run poll --ack to clear.",
          };

          const turnItems = this.pendingTurnItems(sessionId);
          this.markSent(sessionId);
          this.store.setBatch(sessionId, batch);
          const delivered = this.deliverBatch(sessionId, batch);
          if (delivered) {
            const entry = this.store.getBatch(sessionId);
            if (entry) entry.delivered = true;
          }

          session.turns.push({
            id: `t_${crypto.randomBytes(6).toString("hex")}`,
            sentAt: batch.sent_at,
            note: batch.overall_note || "",
            delivered,
            items: turnItems,
          });

          this.store.persist(sessionId);
          this.broadcastAgentState(sessionId);
          return Response.json({ ok: true, delivered }, { headers: corsHeaders });
        }

        const respondMatch = route.match(/^\/api\/session\/([a-zA-Z0-9_]+)\/respond$/);
        if (respondMatch && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as {
            note?: string;
            items?: Array<{ id: string; status: ItemStatus; note?: string }>;
          };
          const sessionId = respondMatch[1];
          const session = this.store.sessions.get(sessionId);
          if (!session) {
            return Response.json(
              { error: "Session not found" },
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
            const hit = this.store.setItemStatus(sessionId, entry.id, entry.status, entry.note);
            if (hit) {
              const { page, item } = hit;
              items.push({
                id: item.id,
                kind: "suggestedText" in item ? "edit" : "comment",
                status: entry.status,
                pageId: page.id,
                filename: page.filename,
                file: item.file,
                startLine: item.startLine,
                endLine: item.endLine,
                feedback: entry.note,
                orphaned: item.orphaned,
              });
              this.emitToSession(sessionId, "refresh", { pageId: page.id });
              continue;
            }

            const tool = this.store.setToolStatus(sessionId, entry.id, entry.status, entry.note);
            if (!tool || tool.state === "open") {
              unknown.push(entry.id);
              continue;
            }
            items.push({
              id: tool.id,
              kind: "tool",
              status: entry.status,
              tool: tool.tool,
              result: tool.result,
              replies: tool.replies,
              anchor: tool.request.anchor,
            });
            this.emitToSession(sessionId, "refresh", {});
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
            session.turns.push(turn);
            this.store.persist(sessionId);
            this.emitToSession(sessionId, "refresh", {});
          }

          return Response.json({ ok: true, unknown }, { headers: corsHeaders });
        }

        const pollMatch = route.match(/^\/api\/session\/([a-zA-Z0-9_]+)\/poll$/);
        if (pollMatch && req.method === "GET") {
          const sessionId = pollMatch[1];
          if (!this.store.sessions.has(sessionId)) {
            return Response.json(
              { error: "Session not found" },
              { status: 404, headers: corsHeaders }
            );
          }
          const ack = url.searchParams.get("ack") === "1";
          const timeoutSecs = Number(url.searchParams.get("timeout")) || 0;

          const pending = this.store.getBatch(sessionId);

          // ack clears the batch the caller already handled. A batch that was never
          // delivered is not that batch: hand it over instead of destroying it.
          if (ack && pending?.delivered) {
            this.store.clearBatch(sessionId);
            this.store.clearSentFeedback(sessionId);
            this.emitToSession(sessionId, "refresh", {});
            this.broadcastAgentState(sessionId);
          } else if (ack && !pending) {
            this.store.clearSentFeedback(sessionId);
            this.emitToSession(sessionId, "refresh", {});
            this.broadcastAgentState(sessionId);
          }

          // Re-serve an unacked batch as often as asked: a poll whose response was lost
          // must be able to fetch it again.
          const undelivered = this.store.getBatch(sessionId);
          if (undelivered) {
            undelivered.delivered = true;
            this.broadcastAgentState(sessionId);
            return Response.json(undelivered.batch, { headers: corsHeaders });
          }

          // Long poll. Capped under Bun's idleTimeout so the wait always ends in a
          // response; a client wanting longer re-polls.
          const waitSecs = timeoutSecs > 0 ? Math.min(timeoutSecs, MAX_POLL_SECS) : 0;

          return new Promise<Response>((resolve) => {
            if (!this.pollers.has(sessionId)) {
              this.pollers.set(sessionId, new Set());
            }

            let timer: ReturnType<typeof setTimeout> | null = null;
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
              timer: null,
            };

            if (waitSecs > 0) {
              timer = setTimeout(() => {
                const pollSet = this.pollers.get(sessionId);
                if (pollSet) {
                  pollSet.delete(pollerRecord);
                  if (pollSet.size === 0) this.pollers.delete(sessionId);
                }
                pollerRecord.resolve(null);
                this.broadcastAgentState(sessionId);
              }, waitSecs * 1000);
              pollerRecord.timer = timer;
            }

            this.pollers.get(sessionId)!.add(pollerRecord);
            this.broadcastAgentState(sessionId);
          });
        }

        const statusMatch = route.match(/^\/api\/session\/([a-zA-Z0-9_]+)\/status$/);
        if (statusMatch && req.method === "GET") {
          const sessionId = statusMatch[1];
          const session = this.store.sessions.get(sessionId);
          if (!session) {
            return Response.json(
              { error: "Session not found" },
              { status: 404, headers: corsHeaders }
            );
          }
          const pending = this.store.getBatch(sessionId);
          const listening = (this.pollers.get(sessionId) || new Set()).size > 0;

          let unsentComments = 0;
          let unsentEdits = 0;
          for (const p of Object.values(session.pages)) {
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
    for (const sessionId of new Set([...this.sseClients.keys(), ...this.pollers.keys()])) {
      this.releaseSessionResources(sessionId);
    }
    this.watcher.closeAll();
    if (this.serverInstance) {
      this.serverInstance.stop();
      this.serverInstance = null;
    }
  }
}
