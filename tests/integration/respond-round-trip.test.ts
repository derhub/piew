import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import { ReviewServer } from "../../src/server/server";

describe("Respond round trip", () => {
  let server: ReviewServer;
  let port: number;
  let file: string;

  beforeAll(async () => {
    file = path.resolve(__dirname, "doc-respond.md");
    fs.writeFileSync(file, "# Doc\n\nContent.\n\nMore.", "utf8");
    server = new ReviewServer();
    port = await server.start(5899);
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

  /** A session with one comment, delivered, so the agent has something to answer. */
  async function deliveredComment(feedback: string) {
    const session = await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ files: [file] }),
    }).then((r) => r.json());

    const page = await api(`/api/page/${session.pageKeys[0]}/comment`, {
      method: "POST",
      body: JSON.stringify({ startLine: 3, feedback }),
    }).then((r) => r.json());

    await api("/api/send", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.sessionId }),
    });

    const comment = page.page.comments.at(-1);
    return { session, commentId: comment.id as string };
  }

  const sessionState = (id: string) => api(`/api/session/${id}`).then((r) => r.json());

  async function waitForComment(sessionId: string, pageKey: string, commentId: string) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const state = await sessionState(sessionId);
      const comment = state.pages[pageKey].comments.find((item: any) => item.id === commentId);
      if (comment?.startLine === 5 || comment?.orphaned) return comment;
      await Bun.sleep(25);
    }
    throw new Error("Timed out waiting for the comment anchor to refresh");
  }

  it("records the agent's verdict on a delivered comment", async () => {
    const { session, commentId } = await deliveredComment("tighten this");

    const result = await api("/api/respond", {
      method: "POST",
      body: JSON.stringify({
        target: file,
        note: "applied both",
        items: [{ id: commentId, status: "applied", note: "rewrote the opening" }],
      }),
    }).then((r) => r.json());

    expect(result.unknown).toEqual([]);

    const state = await sessionState(session.sessionId);
    const comment = state.pages[session.pageKeys[0]].comments.find((c: any) => c.id === commentId);
    expect(comment.status).toBe("applied");
    expect(comment.replies[0]).toMatchObject({ from: "agent", text: "rewrote the opening" });
  });

  it("reports an id it was never sent and writes nothing for it", async () => {
    const { session } = await deliveredComment("second pass");

    const result = await api("/api/respond", {
      method: "POST",
      body: JSON.stringify({
        target: file,
        items: [{ id: "c_notreal", status: "applied" }],
      }),
    }).then((r) => r.json());

    expect(result.unknown).toEqual(["c_notreal"]);

    const state = await sessionState(session.sessionId);
    const agentTurns = state.turns.filter((t: any) => t.from === "agent");
    expect(agentTurns.every((t: any) => !t.items.some((i: any) => i.id === "c_notreal"))).toBe(
      true
    );
  });

  it("refuses a status it does not recognise", async () => {
    const { commentId } = await deliveredComment("third pass");

    const result = await api("/api/respond", {
      method: "POST",
      body: JSON.stringify({
        target: file,
        items: [{ id: commentId, status: "done" }],
      }),
    }).then((r) => r.json());

    expect(result.unknown).toEqual([commentId]);
  });

  it("appends the agent turn to the transcript the browser reads", async () => {
    const { session, commentId } = await deliveredComment("fourth pass");

    await api("/api/respond", {
      method: "POST",
      body: JSON.stringify({
        target: file,
        note: "one open question",
        items: [{ id: commentId, status: "question", note: "which heading do you mean?" }],
      }),
    });

    const state = await sessionState(session.sessionId);
    const turn = state.turns.at(-1);
    expect(turn.from).toBe("agent");
    expect(turn.note).toBe("one open question");
    expect(turn.items[0]).toMatchObject({ id: commentId, status: "question" });
  });

  it("moves a line comment with its unique quote", async () => {
    fs.writeFileSync(file, "# Doc\n\nContent.\n\nMore.", "utf8");
    const session = await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ files: [file] }),
    }).then((r) => r.json());
    const pageKey = session.pageKeys[0];
    const { comment } = await api(`/api/page/${pageKey}/comment`, {
      method: "POST",
      body: JSON.stringify({ startLine: 3, endLine: 3, quote: "Content.", feedback: "move me" }),
    }).then((r) => r.json());
    await api("/api/send", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.sessionId }),
    });

    fs.writeFileSync(file, "# Doc\n\nNew line.\n\nContent.\n\nMore.", "utf8");
    await waitForComment(session.sessionId, pageKey, comment.id);
    await api("/api/respond", {
      method: "POST",
      body: JSON.stringify({
        target: file,
        items: [{ id: comment.id, status: "applied", note: "moved it" }],
      }),
    });

    const state = await sessionState(session.sessionId);
    expect({
      comment: state.pages[pageKey].comments.find((item: any) => item.id === comment.id),
      userTurn: state.turns.at(-2).items[0],
      agentTurn: state.turns.at(-1).items[0],
    }).toMatchObject({
      comment: { startLine: 5, endLine: 5, orphaned: false },
      userTurn: { startLine: 5, endLine: 5, orphaned: false },
      agentTurn: { startLine: 5, endLine: 5, orphaned: false },
    });
  });

  it("marks a line comment unplaced when its quote disappears", async () => {
    fs.writeFileSync(file, "# Doc\n\nContent.\n\nMore.", "utf8");
    const session = await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ files: [file] }),
    }).then((r) => r.json());
    const pageKey = session.pageKeys[0];
    const { comment } = await api(`/api/page/${pageKey}/comment`, {
      method: "POST",
      body: JSON.stringify({ startLine: 3, endLine: 3, quote: "Content.", feedback: "keep me" }),
    }).then((r) => r.json());
    await api("/api/send", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.sessionId }),
    });

    fs.writeFileSync(file, "# Doc\n\nReplacement.\n\nMore.", "utf8");
    await waitForComment(session.sessionId, pageKey, comment.id);
    await api("/api/respond", {
      method: "POST",
      body: JSON.stringify({
        target: file,
        items: [{ id: comment.id, status: "applied", note: "replaced it" }],
      }),
    });

    const state = await sessionState(session.sessionId);
    expect({
      comment: state.pages[pageKey].comments.find((item: any) => item.id === comment.id),
      userTurn: state.turns.at(-2).items[0],
      agentTurn: state.turns.at(-1).items[0],
    }).toMatchObject({
      comment: { startLine: 3, endLine: 3, orphaned: true },
      userTurn: { startLine: 3, endLine: 3, orphaned: true },
      agentTurn: { startLine: 3, endLine: 3, orphaned: true },
    });
  });
});
