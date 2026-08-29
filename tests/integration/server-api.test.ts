import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import fs from "node:fs";
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
    const before = server.store.sessions.get(created.sessionId)!.lastSeen;

    await fetch(`http://127.0.0.1:${port}/api/session/${created.sessionId}`);

    expect(server.store.sessions.get(created.sessionId)!.lastSeen).toBe(before);
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

  it("restores existing watches and serves a captured page whose source is missing", async () => {
    const watchersBefore = server.resourceCounts().watchers;
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
    const session = await fetch(`http://127.0.0.1:${port}/api/session/${created.sessionId}`).then(
      (response) => response.json()
    );
    const removedPageId = Object.keys(session.pages).find(
      (pageId) => session.pages[pageId].file === removedFile
    )!;
    const removedPage = await fetch(
      `http://127.0.0.1:${port}/api/session/${created.sessionId}/page/${removedPageId}`
    ).then((response) => response.json());

    expect(server.resourceCounts().watchers).toBe(watchersBefore);
    expect(removedPage.content).toBe("# Captured before removal\n");
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
});
