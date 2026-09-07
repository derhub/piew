import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ReviewServer } from "../../src/server/server";
import type { ReviewSession } from "../../src/lib/types";

const AFTER_DEBOUNCE_MS = 400;

function sessionFile(sessionId: string): string {
  return path.join(process.env.PIEW_DIR!, "state-v4", "sessions", `${sessionId}.json`);
}

function storedSession(sessionId: string): ReviewSession {
  return JSON.parse(fs.readFileSync(sessionFile(sessionId), "utf8")).session;
}

describe("session durability", () => {
  let server: ReviewServer;
  let port: number;
  let source: string;

  beforeAll(async () => {
    source = path.join(process.env.PIEW_DIR!, "durability.md");
    fs.writeFileSync(source, "# Durability\n\nBody line.\n", "utf8");
    server = new ReviewServer();
    port = await server.start(5912);
  });

  afterAll(() => {
    server.stop();
    fs.rmSync(source, { force: true });
  });

  function api(route: string, init?: RequestInit) {
    return fetch(`http://127.0.0.1:${port}/api${route}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  }

  async function openSession() {
    const created = await api("/session", {
      method: "POST",
      body: JSON.stringify({ files: [source] }),
    }).then((response) => response.json());
    return { id: created.sessionId as string, pageId: created.reviewMap.items[0].pageId as string };
  }

  function comment(id: string, pageId: string, feedback: string) {
    return api(`/session/${id}/page/${pageId}/comment`, {
      method: "POST",
      body: JSON.stringify({ startLine: 1, feedback }),
    });
  }

  describe("add a comment through the browser API", () => {
    it("answers before the session file is written", async () => {
      const { id, pageId } = await openSession();

      await comment(id, pageId, "Not on disk yet");

      expect(storedSession(id).pages[pageId].comments).toEqual([]);
    });

    it("writes the session file within the debounce window", async () => {
      const { id, pageId } = await openSession();

      await comment(id, pageId, "Written by the debounce");
      await Bun.sleep(AFTER_DEBOUNCE_MS);

      expect(storedSession(id).pages[pageId].comments.map((item) => item.feedback)).toEqual([
        "Written by the debounce",
      ]);
    });

    it("serves the comment from memory on the next read", async () => {
      const { id, pageId } = await openSession();
      await comment(id, pageId, "Served from memory");

      const session = await api(`/session/${id}`).then((response) => response.json());

      expect(
        session.pages[pageId].comments.map((item: { feedback: string }) => item.feedback)
      ).toEqual(["Served from memory"]);
    });

    it("writes the session file once for a burst inside one window", async () => {
      const { id, pageId } = await openSession();
      const target = sessionFile(id);
      const realRename = fs.renameSync;
      let writes = 0;
      fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
        if (String(to) === target) writes++;
        return realRename(from, to);
      }) as typeof fs.renameSync;

      try {
        for (let index = 0; index < 5; index++) await comment(id, pageId, `Burst ${index}`);
        await Bun.sleep(AFTER_DEBOUNCE_MS);
      } finally {
        fs.renameSync = realRename;
      }

      expect({ writes, stored: storedSession(id).pages[pageId].comments.length }).toEqual({
        writes: 1,
        stored: 5,
      });
    });
  });

  describe("send a batch to the agent", () => {
    it("has the batch on disk before the response returns", async () => {
      const { id, pageId } = await openSession();
      await comment(id, pageId, "Send me");

      await api(`/session/${id}/send`, { method: "POST", body: JSON.stringify({}) });

      expect(storedSession(id).pendingBatch?.batch.pages[0].comments[0].feedback).toBe("Send me");
    });
  });

  describe("respond to a batch", () => {
    it("has every item status on disk before the response returns", async () => {
      const { id, pageId } = await openSession();
      await comment(id, pageId, "Respond to me");
      await api(`/session/${id}/send`, { method: "POST", body: JSON.stringify({}) });
      const sent = await api(`/session/${id}`).then((response) => response.json());
      const commentId = sent.pages[pageId].comments[0].id;

      await api(`/session/${id}/respond`, {
        method: "POST",
        body: JSON.stringify({ items: [{ id: commentId, status: "applied" }] }),
      });

      expect(storedSession(id).pages[pageId].comments[0].status).toBe("applied");
    });
  });

  describe("poll with ack", () => {
    it("has the cleared batch on disk before the response returns", async () => {
      const { id, pageId } = await openSession();
      await comment(id, pageId, "Ack me");
      await api(`/session/${id}/send`, { method: "POST", body: JSON.stringify({}) });
      await api(`/session/${id}/poll?timeout=0.05`);

      await api(`/session/${id}/poll?ack=1&timeout=0.05`);

      const stored = storedSession(id);
      expect({
        pending: stored.pendingBatch,
        comments: stored.pages[pageId].comments,
      }).toEqual({ pending: undefined, comments: [] });
    });
  });

  describe("close a session with an unflushed edit", () => {
    it("leaves no session file behind", async () => {
      const { id, pageId } = await openSession();
      await comment(id, pageId, "Closed before the flush");

      await api(`/session/${id}`, { method: "DELETE" });
      await Bun.sleep(AFTER_DEBOUNCE_MS);

      expect(fs.existsSync(sessionFile(id))).toBe(false);
    });
  });

  describe("evict a session and read it again", () => {
    it("rewrites the same bytes it loaded", async () => {
      const { id, pageId } = await openSession();
      await comment(id, pageId, "Round trip");
      await Bun.sleep(AFTER_DEBOUNCE_MS);
      const before = fs.readFileSync(sessionFile(id), "utf8");

      server.store.evict(id);
      server.store.mutate(id, () => undefined);
      server.store.flush(id);

      expect(fs.readFileSync(sessionFile(id), "utf8")).toBe(before);
    });
  });
});

describe("a session with nobody attached", () => {
  let server: ReviewServer;
  let port: number;
  let source: string;

  beforeAll(async () => {
    source = path.join(process.env.PIEW_DIR!, "detached.md");
    fs.writeFileSync(source, "# Detached\n\nBody line.\n", "utf8");
    server = new ReviewServer();
    port = await server.start(5913);
  });

  afterAll(() => {
    server.stop();
    fs.rmSync(source, { force: true });
  });

  function api(route: string, init?: RequestInit) {
    return fetch(`http://127.0.0.1:${port}/api${route}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  }

  async function openSession() {
    const created = await api("/session", {
      method: "POST",
      body: JSON.stringify({ files: [source] }),
    }).then((response) => response.json());
    return { id: created.sessionId as string, pageId: created.reviewMap.items[0].pageId as string };
  }

  it("leaves memory when the last tab disconnects", async () => {
    const { id, pageId } = await openSession();
    const abort = new AbortController();
    const events = await fetch(`http://127.0.0.1:${port}/events?session=${id}`, {
      signal: abort.signal,
    });
    const reader = events.body!.getReader();
    await reader.read();
    await api(`/session/${id}/page/${pageId}/comment`, {
      method: "POST",
      body: JSON.stringify({ startLine: 1, feedback: "Written on disconnect" }),
    });

    abort.abort();
    await Bun.sleep(20);

    expect({
      loaded: server.resourceCounts().loaded,
      stored: storedSession(id).pages[pageId].comments.map((item) => item.feedback),
    }).toEqual({ loaded: 0, stored: ["Written on disconnect"] });
  });

  it("does not stay in memory after a poll from the CLI", async () => {
    const { id } = await openSession();

    await api(`/session/${id}/poll?timeout=0.05`);

    expect(server.resourceCounts().loaded).toBe(0);
  });

  it("a status check does not pin the session in memory", async () => {
    const { id } = await openSession();

    await api(`/session/${id}/status`);

    expect(server.resourceCounts().loaded).toBe(0);
  });

  it("serves the same state when it is read again after eviction", async () => {
    const { id, pageId } = await openSession();
    await api(`/session/${id}/page/${pageId}/comment`, {
      method: "POST",
      body: JSON.stringify({ startLine: 1, feedback: "Survives eviction" }),
    });
    const before = await api(`/session/${id}`).then((response) => response.json());

    await api(`/session/${id}/poll?timeout=0.05`);
    const after = await api(`/session/${id}`).then((response) => response.json());

    expect(after).toEqual(before);
  });
});

describe("stop the daemon with an unflushed edit", () => {
  it("writes the edit before the process exits", async () => {
    const source = path.join(process.env.PIEW_DIR!, "stopped.md");
    fs.writeFileSync(source, "# Stopped\n\nBody line.\n", "utf8");
    const server = new ReviewServer();
    const port = await server.start(5914);
    const created = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [source] }),
    }).then((response) => response.json());
    const pageId = created.reviewMap.items[0].pageId;
    await fetch(
      `http://127.0.0.1:${port}/api/session/${created.sessionId}/page/${pageId}/comment`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startLine: 1, feedback: "Unflushed at stop" }),
      }
    );

    server.stop();

    expect(
      storedSession(created.sessionId).pages[pageId].comments.map((item) => item.feedback)
    ).toEqual(["Unflushed at stop"]);
    fs.rmSync(source, { force: true });
  });
});
