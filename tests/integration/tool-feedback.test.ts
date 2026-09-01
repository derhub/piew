import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { toolsDir } from "../../src/cli/paths";
import type { ToolInteraction } from "../../src/lib/types";
import { ReviewServer } from "../../src/server/server";

describe("tool feedback lifecycle", () => {
  let server: ReviewServer;
  let port: number;
  let file: string;
  let sessionId: string;

  const api = (route: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });

  beforeAll(async () => {
    file = path.join(process.env.PIEW_DIR!, "tool-feedback.md");
    fs.writeFileSync(file, "# Tool feedback\n", "utf8");
    server = new ReviewServer();
    port = await server.start(5910);
  });

  afterAll(() => server.stop());
  afterEach(() => fs.rmSync(path.join(toolsDir(), "blocked"), { recursive: true, force: true }));

  beforeEach(async () => {
    const response = await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ files: [file] }),
    });
    sessionId = (await response.json()).sessionId;
  });

  function addQuestion(): ToolInteraction {
    const pageId = server.store.read(sessionId)!.activePageId;
    const interaction: ToolInteraction = {
      id: "ti_question",
      tool: "question",
      state: "open",
      request: { prompt: "Choose a release channel", data: null, anchor: { pageId, line: 1 } },
      artifact: { digest: "test", files: ["index.html"], bytes: 1 },
      createdAt: Date.now(),
      replies: [],
    };
    expect(server.store.addTool(sessionId, interaction)).toBe(true);
    return interaction;
  }

  const action = (body: unknown) =>
    api(`/api/session/${sessionId}/tool/ti_question/action`, {
      method: "POST",
      body: JSON.stringify(body),
    });

  it("resets an unsent result", async () => {
    addQuestion();
    expect((await action({ action: "submit", value: "stable" })).status).toBe(200);
    expect(server.store.read(sessionId)!.tools.ti_question.state).toBe("ready");

    expect((await action({ action: "reset" })).status).toBe(200);
    expect(server.store.read(sessionId)!.tools.ti_question.state).toBe("open");
  });

  it("preserves concurrent page and tool mutations", async () => {
    const question = addQuestion();
    const pageId = server.store.read(sessionId)!.activePageId;
    const [toolResponse, commentResponse] = await Promise.all([
      action({ action: "submit", value: "stable" }),
      api(`/api/session/${sessionId}/page/${pageId}/comment`, {
        method: "POST",
        body: JSON.stringify({ feedback: "Keep the release note concise" }),
      }),
    ]);

    expect([toolResponse.status, commentResponse.status]).toEqual([200, 200]);
    const stored = server.store.read(sessionId)!;
    expect(stored.tools[question.id].state).toBe("ready");
    expect(stored.pages[pageId].comments[0].feedback).toBe("Keep the release note concise");
  });

  it("emits no success event when a durable mutation fails", async () => {
    const pageId = server.store.read(sessionId)!.activePageId;
    await api(`/api/session/${sessionId}/page/${pageId}/comment`, {
      method: "POST",
      body: JSON.stringify({ feedback: "Persist this first" }),
    });
    const abort = new AbortController();
    const events = await fetch(`http://127.0.0.1:${port}/events?session=${sessionId}`, {
      signal: abort.signal,
    });
    const reader = events.body!.getReader();
    await reader.read();

    const mutate = server.store.mutate.bind(server.store);
    server.store.mutate = (() => {
      throw new Error("disk unavailable");
    }) as typeof server.store.mutate;
    try {
      const response = await api(`/api/session/${sessionId}/send`, {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(500);
      const next = await Promise.race([
        reader.read().then(() => "event"),
        Bun.sleep(30).then(() => "timeout"),
      ]);
      expect(next).toBe("timeout");
    } finally {
      server.store.mutate = mutate;
      abort.abort();
      await Bun.sleep(10);
    }
  });

  it("invokes a validated package and rejects compiler failures without session mutation", async () => {
    const pageId = server.store.read(sessionId)!.activePageId;
    const opened = await api(`/api/session/${sessionId}/tool/button`, {
      method: "POST",
      body: JSON.stringify({
        prompt: "Approve",
        data: { label: "Approve", value: "approve" },
        anchor: { pageId, line: 1 },
      }),
    });
    expect(opened.status).toBe(200);
    const result = await opened.json();
    expect(server.store.read(sessionId)!.tools[result.id]).toMatchObject({
      state: "open",
      request: { anchor: { pageId, line: 1 } },
    });
    const artifact = await api(`/api/session/${sessionId}/tool/${result.id}`);
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get("content-security-policy")).toContain("connect-src 'none'");

    const blocked = path.join(toolsDir(), "blocked");
    fs.mkdirSync(blocked, { recursive: true });
    fs.writeFileSync(
      path.join(blocked, "tool.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "blocked",
        description: "Blocked compiler fixture",
        when: "Testing compiler rejection",
        entry: "Tool.tsx",
        instructions: "instructions.md",
      })
    );
    fs.writeFileSync(path.join(blocked, "instructions.md"), "Do not use.\n");
    fs.writeFileSync(
      path.join(blocked, "Tool.tsx"),
      'import fs from "node:fs"; export default fs;\n'
    );
    const before = Object.keys(server.store.read(sessionId)!.tools);
    const rejected = await api(`/api/session/${sessionId}/tool/blocked`, {
      method: "POST",
      body: JSON.stringify({ prompt: "Reject", data: null }),
    });
    expect(rejected.status).toBe(400);
    expect(Object.keys(server.store.read(sessionId)!.tools)).toEqual(before);
    fs.rmSync(blocked, { recursive: true, force: true });
  });

  it("removes a compiled artifact when the session disappears before attachment", async () => {
    const addTool = server.store.addTool.bind(server.store);
    server.store.addTool = () => false;
    try {
      const response = await api(`/api/session/${sessionId}/tool/button`, {
        method: "POST",
        body: JSON.stringify({ prompt: "Approve", data: { label: "Approve" } }),
      });
      expect(response.status).toBe(404);
      const directory = path.join(process.env.PIEW_DIR!, "state-v4", "tool-artifacts", sessionId);
      expect(fs.existsSync(directory) ? fs.readdirSync(directory) : []).toEqual([]);
    } finally {
      server.store.addTool = addTool;
    }
  });

  it("keeps a question alive across acknowledgement and delivers the host reply", async () => {
    addQuestion();
    expect((await action({ action: "submit", value: "stable" })).status).toBe(200);

    const sent = await api(`/api/session/${sessionId}/send`, {
      method: "POST",
      body: "{}",
    });
    expect(sent.status).toBe(200);

    const blocked = await api(`/api/session/${sessionId}/send`, {
      method: "POST",
      body: "{}",
    });
    expect(blocked.status).toBe(409);

    const first = await api(`/api/session/${sessionId}/poll?timeout=1`).then((response) =>
      response.json()
    );
    expect(first.tools).toEqual([
      expect.objectContaining({
        id: "ti_question",
        result: { kind: "submitted", value: "stable" },
      }),
    ]);

    const questioned = await api(`/api/session/${sessionId}/respond`, {
      method: "POST",
      body: JSON.stringify({
        items: [{ id: "ti_question", status: "question", note: "Stable or preview?" }],
      }),
    });
    expect(questioned.status).toBe(200);

    await api(`/api/session/${sessionId}/poll?ack=1&timeout=1`);
    expect(server.store.read(sessionId)!.tools.ti_question.state).toBe("awaiting-answer");

    expect((await action({ action: "reply", text: "Use stable" })).status).toBe(200);
    expect(server.store.read(sessionId)!.tools.ti_question.state).toBe("ready");
    expect((await action({ action: "reset" })).status).toBe(409);

    expect(
      (
        await api(`/api/session/${sessionId}/send`, {
          method: "POST",
          body: "{}",
        })
      ).status
    ).toBe(200);
    const second = await api(`/api/session/${sessionId}/poll?timeout=1`).then((response) =>
      response.json()
    );
    expect(second.tools[0]).toMatchObject({
      id: "ti_question",
      replies: [
        { from: "agent", text: "Stable or preview?" },
        { from: "user", text: "Use stable" },
      ],
    });

    await api(`/api/session/${sessionId}/respond`, {
      method: "POST",
      body: JSON.stringify({ items: [{ id: "ti_question", status: "applied" }] }),
    });
    expect(server.store.read(sessionId)!.tools.ti_question).toMatchObject({
      state: "resolved",
      status: "applied",
    });
  });
});
