import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import { ReviewServer } from "../../src/server/server";

describe("Answering an agent question", () => {
  let server: ReviewServer;
  let port: number;
  let file: string;

  beforeAll(async () => {
    file = path.resolve(__dirname, "doc-question.md");
    fs.writeFileSync(file, "# Doc\n\nContent.\n\nMore.", "utf8");
    server = new ReviewServer();
    port = await server.start(5901);
  });

  afterAll(() => {
    server.stop();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  const api = (route: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });

  async function askedQuestion(status: "question" | "applied") {
    const session = await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ files: [file] }),
    }).then((r) => r.json());
    const pageKey = session.pageKeys[0];

    const posted = await api(`/api/page/${pageKey}/comment`, {
      method: "POST",
      body: JSON.stringify({ startLine: 3, feedback: "rewrite this" }),
    }).then((r) => r.json());
    const commentId = posted.page.comments.at(-1).id as string;

    await api("/api/send", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.sessionId }),
    });
    await api("/api/respond", {
      method: "POST",
      body: JSON.stringify({
        target: file,
        items: [{ id: commentId, status, note: "which paragraph?" }],
      }),
    });

    return { session, pageKey, commentId };
  }

  it("takes the answer as a new unsent comment on the same line", async () => {
    const { session, pageKey } = await askedQuestion("question");

    await api(`/api/page/${pageKey}/comment`, {
      method: "POST",
      body: JSON.stringify({ startLine: 3, feedback: "the second one" }),
    });

    const state = await api(`/api/session/${session.sessionId}`).then((r) => r.json());
    const unsent = state.pages[pageKey].comments.filter((c: any) => !c.sent);
    expect(unsent).toHaveLength(1);
    expect(unsent[0]).toMatchObject({ startLine: 3, feedback: "the second one" });
  });

  it("keeps the answered item itself frozen", async () => {
    const { pageKey, commentId } = await askedQuestion("question");

    const res = await api(`/api/page/${pageKey}/comment/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ feedback: "changed my mind" }),
    });

    expect(res.status).toBe(409);
  });

  it("keeps an applied item frozen too", async () => {
    const { pageKey, commentId } = await askedQuestion("applied");

    const res = await api(`/api/page/${pageKey}/comment/${commentId}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(409);
  });
});
