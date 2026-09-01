import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { ReviewServer } from "../../src/server/server";

describe("ReviewServer HTTP API", () => {
  let server: ReviewServer;
  let port: number;
  let testFile: string;

  beforeAll(async () => {
    testFile = path.resolve(__dirname, "test-doc.md");
    fs.writeFileSync(testFile, "# Test Document\n\nInitial line.", "utf8");

    server = new ReviewServer();
    port = await server.start(5890);
  });

  afterAll(() => {
    server.stop();
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  });

  it("answers /health probe with protocol and port", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.port).toBe(port);
  });

  it("does not mutate durable recency when a session is read", async () => {
    const created = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [testFile] }),
    }).then((response) => response.json());
    const before = server.store.read(created.sessionId)!.lastSeen;

    await fetch(`http://127.0.0.1:${port}/api/session/${created.sessionId}`);

    expect(server.store.read(created.sessionId)!.lastSeen).toBe(before);
  });

  it("creates a session for a document and adds comments", async () => {
    // 1. Create session
    const sessionRes = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [testFile] }),
    });
    expect(sessionRes.status).toBe(200);
    const sessionData = await sessionRes.json();
    expect(sessionData.sessionId).toBeDefined();
    expect(sessionData.activePageId).toBeDefined();

    const pageId = sessionData.activePageId;

    // 2. Add comment
    const commentRes = await fetch(
      `http://127.0.0.1:${port}/api/session/${sessionData.sessionId}/page/${pageId}/comment`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startLine: 1,
          endLine: 1,
          quote: "Test Document",
          feedback: "Please make title more descriptive.",
        }),
      }
    );
    expect(commentRes.status).toBe(200);
    const commentBody = await commentRes.json();
    expect(commentBody.comment.feedback).toBe("Please make title more descriptive.");
    expect(commentBody.page.comments.length).toBe(1);

    // 3. Send feedback
    const sendRes = await fetch(
      `http://127.0.0.1:${port}/api/session/${sessionData.sessionId}/send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          overallNote: "Overall good.",
        }),
      }
    );
    expect(sendRes.status).toBe(200);

    // 4. Poll feedback
    const pollRes = await fetch(
      `http://127.0.0.1:${port}/api/session/${sessionData.sessionId}/poll`
    );
    expect(pollRes.status).toBe(200);
    const pollData = await pollRes.json();
    expect(pollData.status).toBe("feedback");
    expect(pollData.pages.length).toBe(1);
    expect(pollData.pages[0].comments.length).toBe(1);
    expect(pollData.overall_note).toBe("Overall good.");

    // 5. Acknowledge batch
    const ackRes = await fetch(
      `http://127.0.0.1:${port}/api/session/${sessionData.sessionId}/poll?ack=1&timeout=1`
    );
    expect(ackRes.status).toBe(200);
    const ackData = await ackRes.json();
    expect(ackData.status).toBe("timeout");
  });

  it("watches only connected sessions and keeps captured pages with missing sources", async () => {
    const removedFile = path.resolve(__dirname, "removed-after-create.md");
    fs.writeFileSync(removedFile, "# Captured before removal\n", "utf8");
    const created = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [testFile, removedFile] }),
    }).then((response) => response.json());
    server.stop();
    fs.rmSync(removedFile);

    server = new ReviewServer();
    port = await server.start(5891);
    expect(server.resourceCounts()).toEqual({
      sessions: 0,
      watchers: 0,
      sse: 0,
      pollers: 0,
      timers: 0,
    });
    const session = await fetch(`http://127.0.0.1:${port}/api/session/${created.sessionId}`).then(
      (response) => response.json()
    );
    const removedPageId = Object.keys(session.pages).find(
      (pageId) => session.pages[pageId].file === removedFile
    )!;
    const removedPage = await fetch(
      `http://127.0.0.1:${port}/api/session/${created.sessionId}/page/${removedPageId}`
    ).then((response) => response.json());

    expect(removedPage.content).toBe("# Captured before removal\n");

    const abort = new AbortController();
    const events = await fetch(`http://127.0.0.1:${port}/events?session=${created.sessionId}`, {
      signal: abort.signal,
    });
    const reader = events.body!.getReader();
    await reader.read();
    expect(server.resourceCounts()).toEqual({
      sessions: 1,
      watchers: 1,
      sse: 1,
      pollers: 0,
      timers: 0,
    });
    abort.abort();
    await Bun.sleep(10);
    expect(server.resourceCounts()).toEqual({
      sessions: 0,
      watchers: 0,
      sse: 0,
      pollers: 0,
      timers: 0,
    });
  });

  it("reconciles an inactive source when the next SSE client connects", async () => {
    const source = path.resolve(__dirname, "changed-while-inactive.md");
    fs.writeFileSync(source, "# Before\n", "utf8");
    try {
      const created = await fetch(`http://127.0.0.1:${port}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: [source] }),
      }).then((response) => response.json());
      fs.writeFileSync(source, "# After\n", "utf8");

      const captured = await fetch(
        `http://127.0.0.1:${port}/api/session/${created.sessionId}/page/${created.activePageId}`
      ).then((response) => response.json());
      expect(captured.content).toBe("# Before\n");

      const reconcile = server.store.reconcile.bind(server.store);
      let watchersDuringReconcile = 0;
      server.store.reconcile = ((session) => {
        watchersDuringReconcile = server.resourceCounts().watchers;
        return reconcile(session);
      }) as typeof server.store.reconcile;
      const abort = new AbortController();
      const events = await fetch(`http://127.0.0.1:${port}/events?session=${created.sessionId}`, {
        signal: abort.signal,
      });
      server.store.reconcile = reconcile;
      const reader = events.body!.getReader();
      await reader.read();
      const reconciled = await fetch(
        `http://127.0.0.1:${port}/api/session/${created.sessionId}/page/${created.activePageId}`
      ).then((response) => response.json());
      expect(reconciled.content).toBe("# After\n");
      expect(watchersDuringReconcile).toBe(1);
      abort.abort();
      await Bun.sleep(10);
      expect(server.resourceCounts().watchers).toBe(0);
    } finally {
      fs.rmSync(source, { force: true });
    }
  });

  it("keeps poll-only sessions free of source watches", async () => {
    const created = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [testFile] }),
    }).then((response) => response.json());

    const poll = fetch(
      `http://127.0.0.1:${port}/api/session/${created.sessionId}/poll?timeout=0.05`
    );
    await Bun.sleep(10);
    expect(server.resourceCounts()).toEqual({
      sessions: 1,
      watchers: 0,
      sse: 0,
      pollers: 1,
      timers: 1,
    });
    expect((await poll).status).toBe(200);
    expect(server.resourceCounts()).toEqual({
      sessions: 0,
      watchers: 0,
      sse: 0,
      pollers: 0,
      timers: 0,
    });
  });

  it("releases a long poll when its client aborts", async () => {
    const created = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [testFile] }),
    }).then((response) => response.json());
    const abort = new AbortController();
    const poll = fetch(
      `http://127.0.0.1:${port}/api/session/${created.sessionId}/poll?timeout=60`,
      { signal: abort.signal }
    ).catch(() => undefined);

    await Bun.sleep(10);
    expect(server.resourceCounts()).toMatchObject({ pollers: 1, timers: 1 });
    abort.abort();
    await poll;
    await Bun.sleep(10);
    expect(server.resourceCounts()).toEqual({
      sessions: 0,
      watchers: 0,
      sse: 0,
      pollers: 0,
      timers: 0,
    });
  });

  it("marks restored deletions and changed binary diffs stale on activation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piew-live-diff-"));
    const deleted = path.join(root, "deleted.bin");
    const binary = path.join(root, "changed.bin");
    const capturedBinary = Buffer.from([0, 1, 2]);
    fs.writeFileSync(binary, Buffer.from([0, 1, 3]));
    try {
      const deletedSession = server.store.createDiffSession({
        repoRoot: root,
        range: "working-tree",
        staged: false,
        liveHead: true,
        files: [{ status: "deleted", oldPath: "deleted.bin", oldContent: "before" }],
      });
      const binarySession = server.store.createDiffSession({
        repoRoot: root,
        range: "working-tree",
        staged: false,
        liveHead: true,
        files: [
          {
            status: "modified",
            oldPath: "changed.bin",
            newPath: "changed.bin",
            newHash: crypto.createHash("sha1").update(capturedBinary).digest("hex"),
          },
        ],
      });
      expect(
        server.store.read(binarySession.id)!.pages[binarySession.activePageId].diff!.newHash
      ).toBeUndefined();
      fs.writeFileSync(deleted, Buffer.from([3, 4, 5]));

      const activate = async (info: typeof deletedSession) => {
        const abort = new AbortController();
        const events = await fetch(`http://127.0.0.1:${port}/events?session=${info.id}`, {
          signal: abort.signal,
        });
        await events.body!.getReader().read();
        expect(server.store.read(info.id)!.pages[info.activePageId].stale).toBe(true);
        abort.abort();
        await Bun.sleep(10);
      };
      await Promise.all([activate(deletedSession), activate(binarySession)]);

      const refreshedBytes = Buffer.from([0, 1, 3]);
      fs.writeFileSync(binary, Buffer.from([0, 1, 4]));
      server.store.refreshDiff(binarySession.id, binarySession.activePageId, {
        status: "modified",
        oldPath: "changed.bin",
        newPath: "changed.bin",
        newHash: crypto.createHash("sha1").update(refreshedBytes).digest("hex"),
      });
      const refreshed = server.store.read(binarySession.id)!;
      expect(refreshed.pages[binarySession.activePageId].stale).toBe(false);
      expect(refreshed.pages[binarySession.activePageId].diff!.newHash).toBeUndefined();
      server.store.reconcile(refreshed);
      expect(server.store.read(binarySession.id)!.pages[binarySession.activePageId].stale).toBe(
        true
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not rewrite a session when Send rejects empty feedback", async () => {
    const created = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [testFile] }),
    }).then((response) => response.json());
    const record = path.join(
      process.env.PIEW_DIR!,
      "state-v4",
      "sessions",
      `${created.sessionId}.json`
    );
    const before = fs.statSync(record).mtimeMs;
    await Bun.sleep(10);

    const response = await fetch(`http://127.0.0.1:${port}/api/session/${created.sessionId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(400);
    expect(fs.statSync(record).mtimeMs).toBe(before);
  });

  it("returns typed errors for missing and corrupt pages", async () => {
    const created = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [testFile] }),
    }).then((response) => response.json());
    server.stop();

    const recordPath = path.join(
      process.env.PIEW_DIR!,
      "state-v4",
      "sessions",
      `${created.sessionId}.json`
    );
    const stored = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    stored.session.pages[created.activePageId].kind = "diff";
    delete stored.session.pages[created.activePageId].diff;
    fs.writeFileSync(recordPath, JSON.stringify(stored));

    server = new ReviewServer();
    port = await server.start(5892);
    const missing = await fetch(
      `http://127.0.0.1:${port}/api/session/${created.sessionId}/page/p_missing`
    );
    const corrupt = await fetch(
      `http://127.0.0.1:${port}/api/session/${created.sessionId}/page/${created.activePageId}`
    );

    expect({
      missing: { status: missing.status, body: await missing.json() },
      corrupt: { status: corrupt.status, body: await corrupt.json() },
    }).toEqual({
      missing: {
        status: 404,
        body: { code: "page-missing", message: "Page not found", retryable: false },
      },
      corrupt: {
        status: 500,
        body: {
          code: "page-corrupt",
          message: `Captured diff is missing for ${path.basename(testFile)}`,
          retryable: false,
        },
      },
    });
  });

  it("serves confined media with native byte ranges", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piew-media-"));
    const reviewDir = path.join(root, "review");
    const artifactsDir = path.join(reviewDir, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });

    const reviewFile = path.join(reviewDir, "plan.md");
    fs.writeFileSync(reviewFile, "# Media review\n", "utf8");
    fs.writeFileSync(
      path.join(artifactsDir, "diagram.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>',
      "utf8"
    );
    fs.writeFileSync(path.join(artifactsDir, "demo.mp4"), "0123456789", "utf8");
    fs.writeFileSync(path.join(artifactsDir, "narration.mp3"), "0123456789", "utf8");
    fs.writeFileSync(
      path.join(artifactsDir, "captions.vtt"),
      "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n",
      "utf8"
    );
    fs.writeFileSync(path.join(artifactsDir, "notes.txt"), "private", "utf8");
    const outside = path.join(root, "outside.svg");
    fs.writeFileSync(outside, "<svg></svg>", "utf8");
    fs.symlinkSync(outside, path.join(artifactsDir, "escaped.svg"));

    try {
      const created = await fetch(`http://127.0.0.1:${port}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: [reviewFile] }),
      }).then((response) => response.json());
      const mediaUrl = (relativePath: string) => {
        const url = new URL(
          `http://127.0.0.1:${port}/api/session/${created.sessionId}/page/${created.activePageId}/media`
        );
        url.searchParams.set("path", relativePath);
        return url;
      };

      const allowed = await Promise.all(
        [
          ["artifacts/diagram.svg", "image/svg+xml"],
          ["artifacts/demo.mp4", "video/mp4"],
          ["artifacts/narration.mp3", "audio/mpeg"],
          ["artifacts/captions.vtt", "text/vtt"],
        ].map(async ([relativePath, contentType]) => {
          const response = await fetch(mediaUrl(relativePath));
          return [
            response.status,
            response.headers.get("content-type")?.split(";")[0],
            contentType,
          ];
        })
      );
      const rejected = await Promise.all(
        [
          "artifacts/missing.svg",
          "../outside.svg",
          "artifacts/escaped.svg",
          "artifacts/notes.txt",
        ].map((relativePath) => fetch(mediaUrl(relativePath)).then((response) => response.status))
      );
      const ranges = await Promise.all(
        ["artifacts/demo.mp4", "artifacts/narration.mp3"].map(async (relativePath) => {
          const response = await fetch(mediaUrl(relativePath), {
            headers: { Range: "bytes=2-5" },
          });
          return {
            status: response.status,
            range: response.headers.get("content-range"),
            accepts: response.headers.get("accept-ranges"),
            body: await response.text(),
          };
        })
      );

      expect({ allowed, rejected, ranges }).toEqual({
        allowed: [
          [200, "image/svg+xml", "image/svg+xml"],
          [200, "video/mp4", "video/mp4"],
          [200, "audio/mpeg", "audio/mpeg"],
          [200, "text/vtt", "text/vtt"],
        ],
        rejected: [404, 404, 404, 404],
        ranges: [
          { status: 206, range: "bytes 2-5/10", accepts: "bytes", body: "2345" },
          { status: 206, range: "bytes 2-5/10", accepts: "bytes", body: "2345" },
        ],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
