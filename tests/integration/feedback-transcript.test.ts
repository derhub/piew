import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import { ReviewServer } from "../../src/server/server";

describe("Feedback Transcript", () => {
  let server: ReviewServer;
  let port: number;
  let file: string;
  let sessionId: string;
  let pageId: string;

  const base = () => `http://127.0.0.1:${port}`;

  const post = (route: string, body: unknown) =>
    fetch(base() + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const readSession = () => fetch(`${base()}/api/session/${sessionId}`).then((r) => r.json());

  beforeAll(async () => {
    file = path.resolve(__dirname, "doc-transcript.md");
    fs.writeFileSync(file, "# Doc\n\nContent.", "utf8");

    server = new ReviewServer();
    port = await server.start(5899);

    const session = await (await post("/api/session", { files: [file] })).json();
    sessionId = session.sessionId;
    pageId = session.reviewMap.items[0].pageId;
  });

  afterAll(() => {
    server.stop();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  it("records each send as its own turn", async () => {
    await post(`/api/session/${sessionId}/page/${pageId}/comment`, {
      startLine: 1,
      feedback: "first",
    });
    await post(`/api/session/${sessionId}/send`, { overallNote: "round one" });

    const { turns } = await readSession();

    expect(turns).toHaveLength(1);
    expect(turns[0].note).toBe("round one");
    expect(turns[0].items.map((i: { feedback: string }) => i.feedback)).toEqual(["first"]);
  });

  it("carries only the annotations the agent has not seen", async () => {
    await fetch(`${base()}/api/session/${sessionId}/poll?timeout=1`);
    await fetch(`${base()}/api/session/${sessionId}/poll?ack=1&timeout=1`);

    await post(`/api/session/${sessionId}/page/${pageId}/comment`, {
      startLine: 2,
      feedback: "second",
    });
    const sent = await (
      await post(`/api/session/${sessionId}/send`, { overallNote: "round two" })
    ).json();

    expect(sent.ok).toBe(true);

    const { turns } = await readSession();
    expect(turns).toHaveLength(2);
    expect(turns[1].items.map((i: { feedback: string }) => i.feedback)).toEqual(["second"]);
  });

  it("keeps the transcript after the agent acks the batch", async () => {
    await fetch(`${base()}/api/session/${sessionId}/poll?timeout=1`);
    await fetch(`${base()}/api/session/${sessionId}/poll?ack=1&timeout=1`);

    const session = await readSession();

    expect(session.turns).toHaveLength(2);
    expect(session.pages[pageId].comments).toHaveLength(0);
  });
});
