import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import { ReviewServer } from "../../src/server/server";

describe("Multi-File Review Integration", () => {
  let server: ReviewServer;
  let port: number;
  let fileA: string;
  let fileB: string;

  beforeAll(async () => {
    fileA = path.resolve(__dirname, "doc-a.md");
    fileB = path.resolve(__dirname, "doc-b.md");
    fs.writeFileSync(fileA, "# Doc A\n\nContent A.", "utf8");
    fs.writeFileSync(fileB, "# Doc B\n\nContent B.", "utf8");

    server = new ReviewServer();
    port = await server.start(5895);
  });

  afterAll(() => {
    server.stop();
    if (fs.existsSync(fileA)) fs.unlinkSync(fileA);
    if (fs.existsSync(fileB)) fs.unlinkSync(fileB);
  });

  it("opens multiple files in one session and delivers combined feedback", async () => {
    // 1. Create multi-file session
    const sessionRes = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [fileA, fileB] }),
    });
    expect(sessionRes.status).toBe(200);
    const sessionData = await sessionRes.json();
    expect(sessionData.reviewMap.items.length).toBe(2);

    const [keyA, keyB] = sessionData.reviewMap.items.map((item: { pageId: string }) => item.pageId);

    // 2. Add comment to file A
    await fetch(
      `http://127.0.0.1:${port}/api/session/${sessionData.sessionId}/page/${keyA}/comment`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startLine: 1,
          feedback: "Comment on Doc A",
        }),
      }
    );

    // 3. Add comment to file B
    await fetch(
      `http://127.0.0.1:${port}/api/session/${sessionData.sessionId}/page/${keyB}/comment`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startLine: 1,
          feedback: "Comment on Doc B",
        }),
      }
    );

    // 4. Send feedback
    await fetch(`http://127.0.0.1:${port}/api/session/${sessionData.sessionId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        overallNote: "Review complete for both documents.",
      }),
    });

    // 5. Poll feedback on file A
    const pollRes = await fetch(
      `http://127.0.0.1:${port}/api/session/${sessionData.sessionId}/poll`
    );
    expect(pollRes.status).toBe(200);
    const pollData = await pollRes.json();

    expect(pollData.status).toBe("feedback");
    expect(pollData.pages.length).toBe(2);
    expect(pollData.pages[0].comments.length).toBe(1);
    expect(pollData.pages[1].comments.length).toBe(1);
    expect(pollData.overall_note).toBe("Review complete for both documents.");
  });
});
