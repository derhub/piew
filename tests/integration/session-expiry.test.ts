import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ReviewServer } from "../../src/server/server";
import { Store } from "../../src/server/store";

describe("session retention", () => {
  it("restores an old session until explicit prune", () => {
    const source = path.join(process.env.PIEW_DIR!, "retained.md");
    fs.writeFileSync(source, "# Retained\n");
    const store = new Store();
    const created = store.createSession([source]);
    store.mutate(created.id, (session) => {
      session.lastSeen = Date.now() - 365 * 24 * 60 * 60 * 1000;
    });

    const restored = new Store();

    expect(restored.has(created.id)).toBe(true);
  });

  it("serves a swept session from disk on the next read", () => {
    const source = path.join(process.env.PIEW_DIR!, "swept.md");
    fs.writeFileSync(source, "# Swept\n");
    const server = new ReviewServer();
    const created = server.store.createSession([source]);

    server.sweepIdle(Date.now() + 24 * 60 * 60 * 1000);

    expect({
      onDisk: server.store.has(created.id),
      served: server.store.read(created.id)?.id,
    }).toEqual({ onDisk: true, served: created.id });
    server.stop();
  });
});

describe("sweep an idle session with an unflushed edit", () => {
  let server: ReviewServer;
  let sessionId: string;
  let pageId: string;
  let abort: AbortController;

  beforeAll(async () => {
    const source = path.join(process.env.PIEW_DIR!, "idle-sweep.md");
    fs.writeFileSync(source, "# Idle sweep\n");
    server = new ReviewServer();
    const port = await server.start(5915);
    const created = server.store.createSession([source]);
    sessionId = created.id;
    pageId = created.activePageId;

    abort = new AbortController();
    const events = await fetch(`http://127.0.0.1:${port}/events?session=${sessionId}`, {
      signal: abort.signal,
    });
    await events.body!.getReader().read();
    server.store.addComment(sessionId, pageId, {
      id: "c_idle",
      kind: "general",
      feedback: "Swept before the flush",
      createdAt: 1,
    });

    server.sweepIdle(Date.now() + 24 * 60 * 60 * 1000);
  });

  afterAll(() => {
    abort.abort();
    server.stop();
  });

  it("writes the edit before dropping it from memory", () => {
    const record = path.join(process.env.PIEW_DIR!, "state-v4", "sessions", `${sessionId}.json`);
    const stored = JSON.parse(fs.readFileSync(record, "utf8")).session;

    expect(
      stored.pages[pageId].comments.map((item: { feedback: string }) => item.feedback)
    ).toEqual(["Swept before the flush"]);
  });

  it("serves the edit again on the next read", () => {
    expect(
      server.store.read(sessionId)?.pages[pageId].comments.map((item) => item.feedback)
    ).toEqual(["Swept before the flush"]);
  });
});
