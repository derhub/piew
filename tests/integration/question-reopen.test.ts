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
    const pageId = session.reviewMap.items[0].pageId;

    const posted = await api(`/api/session/${session.sessionId}/page/${pageId}/comment`, {
      method: "POST",
      body: JSON.stringify({ startLine: 3, feedback: "rewrite this" }),
    }).then((r) => r.json());
    const commentId = posted.page.comments.at(-1).id as string;

    await api(`/api/session/${session.sessionId}/send`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    await api(`/api/session/${session.sessionId}/respond`, {
      method: "POST",
      body: JSON.stringify({
        items: [{ id: commentId, status, note: "which paragraph?" }],
      }),
    });

    return { session, pageId, commentId };
  }

  it("takes the answer as a new unsent comment on the same line", async () => {
    const { session, pageId } = await askedQuestion("question");

    await api(`/api/session/${session.sessionId}/page/${pageId}/comment`, {
      method: "POST",
      body: JSON.stringify({ startLine: 3, feedback: "the second one" }),
    });

    const state = await api(`/api/session/${session.sessionId}`).then((r) => r.json());
    const unsent = state.pages[pageId].comments.filter((c: any) => !c.sent);
    expect(unsent).toHaveLength(1);
    expect(unsent[0]).toMatchObject({ startLine: 3, feedback: "the second one" });
  });

  it("keeps the answered item itself frozen", async () => {
    const { session, pageId, commentId } = await askedQuestion("question");

    const res = await api(`/api/session/${session.sessionId}/page/${pageId}/comment/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ feedback: "changed my mind" }),
    });

    expect(res.status).toBe(409);
  });

  it("keeps an applied item frozen too", async () => {
    const { session, pageId, commentId } = await askedQuestion("applied");

    const res = await api(`/api/session/${session.sessionId}/page/${pageId}/comment/${commentId}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(409);
  });
});
