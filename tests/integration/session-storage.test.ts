import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STORE_MODULE = pathToFileURL(path.resolve(__dirname, "../../src/server/store.ts")).href;
const TOOL_MODULE = pathToFileURL(path.resolve(__dirname, "../../src/server/tool-files.ts")).href;
const CLI = path.resolve(__dirname, "../../bin/piew.ts");

describe("session storage", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "piew-storage-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function runIsolated(script: string) {
    const proc = Bun.spawn([process.execPath, "--eval", script], {
      cwd: path.resolve(__dirname, "../.."),
      env: { ...process.env, PIEW_DIR: root, PIEW_NO_OPEN: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr || stdout);
    return JSON.parse(stdout.trim());
  }

  async function runCli(...args: string[]) {
    return runIsolated(`
      const proc = Bun.spawnSync(${JSON.stringify([process.execPath, CLI])}.concat(${JSON.stringify(args)}), {
        cwd: ${JSON.stringify(path.resolve(__dirname, "../.."))},
        env: { ...process.env, PIEW_DIR: ${JSON.stringify(root)}, PIEW_NO_OPEN: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) throw new Error(proc.stderr.toString() || proc.stdout.toString());
      console.log(proc.stdout.toString().trim());
    `);
  }

  it("writes only the session that changed", async () => {
    const firstSource = path.join(root, "first.md");
    const secondSource = path.join(root, "second.md");
    fs.writeFileSync(firstSource, "# First\n");
    fs.writeFileSync(secondSource, "# Second\n");

    const result = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const store = new Store();
      const first = store.createSession([${JSON.stringify(firstSource)}]);
      const second = store.createSession([${JSON.stringify(secondSource)}]);
      const sessionsDir = path.join(process.env.PIEW_DIR, "state-v4", "sessions");
      const firstRecord = path.join(sessionsDir, first.id + ".json");
      const secondRecord = path.join(sessionsDir, second.id + ".json");
      const secondBefore = fs.readFileSync(secondRecord, "utf8");
      store.addComment(first.id, first.activePageId, {
        id: "c_first", kind: "general", feedback: "Change this", createdAt: 1,
      });
      store.flush(first.id);
      console.log(JSON.stringify({
        files: fs.readdirSync(sessionsDir).sort(),
        expected: [first.id + ".json", second.id + ".json"].sort(),
        first: fs.readFileSync(firstRecord, "utf8"),
        secondUnchanged: fs.readFileSync(secondRecord, "utf8") === secondBefore,
      }));
    `);

    expect(result.files).toEqual(result.expected);
    expect(result.first).toContain("Change this");
    expect(result.secondUnchanged).toBe(true);
  });

  it("stores no page content in the session JSON", async () => {
    const source = path.join(root, "blob-shape.md");
    fs.writeFileSync(source, "# Blob shape\n");
    const result = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const created = new Store().createSession([${JSON.stringify(source)}]);
      const stored = JSON.parse(fs.readFileSync(
        path.join(process.env.PIEW_DIR, "state-v4", "sessions", created.id + ".json"), "utf8"
      ));
      const fields = Object.keys(stored.session.pages[created.activePageId]);
      console.log(JSON.stringify({
        schemaVersion: stored.schemaVersion,
        content: fields.includes("content"),
        contentHash: fields.includes("contentHash"),
      }));
    `);

    expect(result).toEqual({ schemaVersion: 5, content: false, contentHash: true });
  });

  it("writes one blob per distinct page body", async () => {
    const first = path.join(root, "same-a.md");
    const second = path.join(root, "same-b.md");
    const third = path.join(root, "other.md");
    fs.writeFileSync(first, "# Same\n");
    fs.writeFileSync(second, "# Same\n");
    fs.writeFileSync(third, "# Other\n");
    const result = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const created = new Store().createSession(${JSON.stringify([first, second, third])});
      const blobs = path.join(process.env.PIEW_DIR, "state-v4", "blobs");
      console.log(JSON.stringify({
        pages: created.reviewMap.items.length,
        bodies: fs.readdirSync(blobs).map((hash) => fs.readFileSync(path.join(blobs, hash), "utf8")).sort(),
      }));
    `);

    expect(result).toEqual({ pages: 3, bodies: ["# Other\n", "# Same\n"] });
  });

  it("writes no new blob when a comment is added", async () => {
    const source = path.join(root, "comment-blob.md");
    fs.writeFileSync(source, "# Comment blob\n");
    const result = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const store = new Store();
      const created = store.createSession([${JSON.stringify(source)}]);
      const blobs = path.join(process.env.PIEW_DIR, "state-v4", "blobs");
      const before = fs.readdirSync(blobs).sort();
      store.addComment(created.id, created.activePageId, {
        id: "c_blob", kind: "general", feedback: "Change this", createdAt: 1,
      });
      store.flush(created.id);
      const record = fs.readFileSync(
        path.join(process.env.PIEW_DIR, "state-v4", "sessions", created.id + ".json"), "utf8"
      );
      console.log(JSON.stringify({
        before,
        after: fs.readdirSync(blobs).sort(),
        stored: record.includes("Change this"),
      }));
    `);

    expect({ unchanged: result.after, stored: result.stored }).toEqual({
      unchanged: result.before,
      stored: true,
    });
  });

  it("rewrites a v4 session file as v5 on first read and serves the same page bytes", async () => {
    const source = path.join(root, "migrate.md");
    fs.writeFileSync(source, "# Migrate\n");
    const created = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const store = new Store();
      const session = store.createSession([${JSON.stringify(source)}]);
      const stateRoot = path.join(process.env.PIEW_DIR, "state-v4");
      fs.writeFileSync(
        path.join(stateRoot, "sessions", session.id + ".json"),
        JSON.stringify({ schemaVersion: 4, session: store.read(session.id) }, null, 2)
      );
      fs.rmSync(path.join(stateRoot, "blobs"), { recursive: true, force: true });
      console.log(JSON.stringify({ id: session.id, pageId: session.activePageId }));
    `);

    const result = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const loaded = new Store().read(${JSON.stringify(created.id)});
      const stateRoot = path.join(process.env.PIEW_DIR, "state-v4");
      const stored = JSON.parse(fs.readFileSync(
        path.join(stateRoot, "sessions", ${JSON.stringify(created.id)} + ".json"), "utf8"
      ));
      console.log(JSON.stringify({
        content: loaded.pages[${JSON.stringify(created.pageId)}].content,
        schemaVersion: stored.schemaVersion,
        inlined: Object.hasOwn(stored.session.pages[${JSON.stringify(created.pageId)}], "content"),
        blobs: fs.readdirSync(path.join(stateRoot, "blobs")).length,
        quarantined: fs.readdirSync(path.join(stateRoot, "quarantine")).length,
      }));
    `);

    expect(result).toEqual({
      content: "# Migrate\n",
      schemaVersion: 5,
      inlined: false,
      blobs: 1,
      quarantined: 0,
    });
  });

  it("quarantines a session whose page blob is missing", async () => {
    const source = path.join(root, "lost-blob.md");
    fs.writeFileSync(source, "# Lost blob\n");
    const created = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const session = new Store().createSession([${JSON.stringify(source)}]);
      fs.rmSync(path.join(process.env.PIEW_DIR, "state-v4", "blobs"), { recursive: true, force: true });
      console.log(JSON.stringify({ id: session.id }));
    `);

    const result = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const loaded = new Store().read(${JSON.stringify(created.id)});
      const stateRoot = path.join(process.env.PIEW_DIR, "state-v4");
      console.log(JSON.stringify({
        loaded: loaded === undefined,
        sessions: fs.readdirSync(path.join(stateRoot, "sessions")).length,
        quarantined: fs.readdirSync(path.join(stateRoot, "quarantine")).length,
      }));
    `);

    expect(result).toEqual({ loaded: true, sessions: 0, quarantined: 1 });
  });

  it("keeps a blob the surviving session references and deletes the closed session's own blobs", async () => {
    const shared = path.join(root, "shared.md");
    const only = path.join(root, "only-closed.md");
    fs.writeFileSync(shared, "# Shared\n");
    fs.writeFileSync(only, "# Only closed\n");
    const result = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const store = new Store();
      const closed = store.createSession(${JSON.stringify([shared, only])});
      store.createSession([${JSON.stringify(shared)}]);
      const blobs = path.join(process.env.PIEW_DIR, "state-v4", "blobs");
      const before = fs.readdirSync(blobs).length;
      store.remove(closed.id);
      console.log(JSON.stringify({
        before,
        bodies: fs.readdirSync(blobs).map((hash) => fs.readFileSync(path.join(blobs, hash), "utf8")),
      }));
    `);

    expect(result).toEqual({ before: 2, bodies: ["# Shared\n"] });
  });

  it("loads sessions on demand and isolates malformed siblings during listing", async () => {
    const source = path.join(root, "valid.md");
    fs.writeFileSync(source, "# Valid\n");
    const result = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const created = new Store().createSession([${JSON.stringify(source)}]);
      const sessionsDir = path.join(process.env.PIEW_DIR, "state-v4", "sessions");
      fs.writeFileSync(path.join(sessionsDir, "s_legacy.json"), JSON.stringify({ schemaVersion: 3, session: { id: "s_legacy" } }));
      fs.writeFileSync(path.join(sessionsDir, "s_broken.json"), "{not-json");
      const valid = JSON.parse(fs.readFileSync(path.join(sessionsDir, created.id + ".json"), "utf8"));
      delete valid.session.tools;
      fs.writeFileSync(path.join(sessionsDir, created.id + ".json"), JSON.stringify(valid));
      fs.writeFileSync(path.join(sessionsDir, "s_invalid.json"), JSON.stringify({
        schemaVersion: 4,
        session: {
          ...valid.session,
          id: "s_invalid",
          activePageId: "p_invalid",
          pages: {
            p_invalid: {
              ...Object.values(valid.session.pages)[0],
              id: "p_invalid",
              comments: [null],
            },
          },
        },
      }));
      fs.writeFileSync(path.join(process.env.PIEW_DIR, "state-v3.json"), JSON.stringify({ sessions: { s_old: { id: "s_old" } } }));
      const restored = new Store();
      const beforeList = {
        retainedSessions: restored.loadedCount(),
        quarantined: fs.readdirSync(path.join(process.env.PIEW_DIR, "state-v4", "quarantine")).length,
      };
      const loaded = restored.read(created.id);
      const listed = restored.list();
      console.log(JSON.stringify({
        beforeList,
        ids: listed.map((session) => session.id),
        createdId: created.id,
        tools: loaded.tools,
        legacyExists: fs.existsSync(path.join(sessionsDir, "s_legacy.json")),
        quarantined: fs.readdirSync(path.join(process.env.PIEW_DIR, "state-v4", "quarantine")).length,
      }));
    `);

    expect(result.beforeList).toEqual({ retainedSessions: 0, quarantined: 0 });
    expect(result.ids).toEqual([result.createdId]);
    expect(result.tools).toEqual({});
    expect(result.legacyExists).toBe(true);
    expect(result.quarantined).toBe(2);
  });

  it("restores owned artifacts and removes deleted, quarantined, and orphaned artifacts", async () => {
    const source = path.join(root, "tools.md");
    fs.writeFileSync(source, "# Tools\n");
    const result = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const tools = await import(${JSON.stringify(pathToFileURL(path.resolve(__dirname, "../../src/server/tool-files.ts")).href)});
      const store = new Store();
      const kept = store.createSession([${JSON.stringify(source)}]);
      const removed = store.createSession([${JSON.stringify(source)}]);
      const broken = store.createSession([${JSON.stringify(source)}]);
      for (const session of [kept, removed, broken]) {
        const id = "ti_" + session.id.slice(2);
        const artifact = tools.writeToolArtifact(session.id, id, [{ path: "index.html", content: "ok" }]);
        store.addTool(session.id, {
          id, tool: "button", state: "open", request: { prompt: "Continue", data: null },
          artifact, createdAt: Date.now(), replies: [],
        });
      }
      store.flushAll();
      tools.writeToolArtifact("s_orphan", "ti_orphan", [{ path: "index.html", content: "orphan" }]);
      store.remove(removed.id);

      const brokenRecord = path.join(process.env.PIEW_DIR, "state-v4", "sessions", broken.id + ".json");
      const invalid = JSON.parse(fs.readFileSync(brokenRecord, "utf8"));
      invalid.session.tools["ti_" + broken.id.slice(2)].artifact.files = ["../escape"];
      fs.writeFileSync(brokenRecord, JSON.stringify(invalid));

      const restored = new Store();
      restored.list();
      const keptId = "ti_" + kept.id.slice(2);
      console.log(JSON.stringify({
        kept: fs.existsSync(tools.toolArtifactDir(kept.id, keptId)),
        keptTools: Object.keys(restored.read(kept.id).tools),
        removed: fs.existsSync(tools.toolArtifactDir(removed.id, "ti_" + removed.id.slice(2))),
        broken: fs.existsSync(tools.toolArtifactDir(broken.id, "ti_" + broken.id.slice(2))),
        orphan: fs.existsSync(tools.toolArtifactDir("s_orphan", "ti_orphan")),
      }));
    `);

    expect(result.kept).toBe(true);
    expect(result.keptTools).toHaveLength(1);
    expect(result.removed).toBe(false);
    expect(result.broken).toBe(false);
    expect(result.orphan).toBe(false);
  });

  it("starts with zero live sessions and watches regardless of stored history", async () => {
    const source = path.join(root, "history.md");
    fs.writeFileSync(source, "# History\n");

    const result = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const { ReviewServer } = await import(${JSON.stringify(pathToFileURL(path.resolve(__dirname, "../../src/server/server.ts")).href)});
      const store = new Store();
      for (let index = 0; index < 100; index++) store.createSession([${JSON.stringify(source)}]);
      const sessionsDir = path.join(process.env.PIEW_DIR, "state-v4", "sessions");
      fs.writeFileSync(path.join(sessionsDir, "s_broken.json"), "{broken");

      const server = new ReviewServer();
      const beforeList = {
        resources: server.resourceCounts(),
        quarantined: fs.readdirSync(path.join(process.env.PIEW_DIR, "state-v4", "quarantine")).length,
      };
      const listed = server.store.list();
      const afterList = {
        count: listed.length,
        quarantined: fs.readdirSync(path.join(process.env.PIEW_DIR, "state-v4", "quarantine")).length,
      };
      server.stop();
      console.log(JSON.stringify({ beforeList, afterList }));
    `);

    expect(result.beforeList).toEqual({
      resources: { sessions: 0, loaded: 0, watchers: 0, sse: 0, pollers: 0, timers: 0 },
      quarantined: 0,
    });
    expect(result.afterList).toEqual({ count: 100, quarantined: 1 });
  });

  it("lists a loaded session from memory and reads only the file it never loaded", async () => {
    const source = path.join(root, "list-loaded.md");
    fs.writeFileSync(source, "# List loaded\n");
    const result = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const tools = await import(${JSON.stringify(TOOL_MODULE)});
      const store = new Store();
      const loaded = store.createSession([${JSON.stringify(source)}]);
      const cold = store.createSession([${JSON.stringify(source)}]);
      store.evict(cold.id);

      const sessionsDir = path.join(process.env.PIEW_DIR, "state-v4", "sessions");
      const reads = [];
      const realRead = fs.default.readFileSync;
      fs.default.readFileSync = (file, ...rest) => {
        if (String(file).startsWith(sessionsDir)) reads.push(path.basename(String(file)));
        return realRead(file, ...rest);
      };
      tools.writeToolArtifact("s_orphan", "ti_orphan", [{ path: "index.html", content: "orphan" }]);
      const listed = store.list();
      fs.default.readFileSync = realRead;

      console.log(JSON.stringify({
        reads,
        expectedReads: [cold.id + ".json"],
        ids: listed.map((session) => session.id).sort(),
        expectedIds: [loaded.id, cold.id].sort(),
        orphan: fs.existsSync(tools.toolArtifactDir("s_orphan", "ti_orphan")),
      }));
    `);

    expect(result.reads).toEqual(result.expectedReads);
    expect(result.ids).toEqual(result.expectedIds);
    expect(result.orphan).toBe(false);
  });

  it("keeps serving the session it loaded after another process rewrites the file", async () => {
    const source = path.join(root, "external-rewrite.md");
    fs.writeFileSync(source, "# External rewrite\n");
    const result = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const store = new Store();
      const created = store.createSession([${JSON.stringify(source)}]);
      const before = store.read(created.id).reviewMap.title;

      const record = path.join(process.env.PIEW_DIR, "state-v4", "sessions", created.id + ".json");
      const stored = JSON.parse(fs.readFileSync(record, "utf8"));
      stored.session.reviewMap.title = "Rewritten by another process";
      fs.writeFileSync(record, JSON.stringify(stored, null, 2));

      console.log(JSON.stringify({ before, after: store.read(created.id).reviewMap.title }));
    `);

    expect(result).toEqual({ before: "Review Map", after: "Review Map" });
  });

  it("leaves the session file unchanged when the commit guard rejects the mutation", async () => {
    const source = path.join(root, "guard-rollback.md");
    fs.writeFileSync(source, "# Guard rollback\n");
    const result = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const store = new Store();
      const created = store.createSession([${JSON.stringify(source)}]);
      store.mutate(
        created.id,
        (session) => {
          session.reviewMap.title = "Uncommitted";
          return false;
        },
        (committed) => committed
      );
      store.flush(created.id);
      const stored = JSON.parse(fs.readFileSync(
        path.join(process.env.PIEW_DIR, "state-v4", "sessions", created.id + ".json"), "utf8"
      ));
      console.log(JSON.stringify({ title: stored.session.reviewMap.title }));
    `);

    expect(result.title).toBe("Review Map");
  });

  it("closes one session: deletes its file, ends its SSE stream, resolves its pending poll, and leaves the other session readable", async () => {
    const firstSource = path.join(root, "first.md");
    const secondSource = path.join(root, "second.md");
    fs.writeFileSync(firstSource, "# First\n");
    fs.writeFileSync(secondSource, "# Second\n");
    const { sessionId: firstId } = await runCli(firstSource);
    const { sessionId: secondId } = await runCli(secondSource);
    const record = JSON.parse(fs.readFileSync(path.join(root, "server-v4.json"), "utf8"));

    try {
      const sse = await fetch(`http://127.0.0.1:${record.port}/events?session=${firstId}`);
      const reader = sse.body!.getReader();
      await reader.read();

      const pollPromise = fetch(
        `http://127.0.0.1:${record.port}/api/session/${firstId}/poll?timeout=5`
      ).then((r) => r.json());
      await new Promise((resolve) => setTimeout(resolve, 200));

      const closeRes = await fetch(`http://127.0.0.1:${record.port}/api/session/${firstId}`, {
        method: "DELETE",
      });
      expect(closeRes.status).toBe(200);
      expect(await closeRes.json()).toEqual({ closed: true });

      const pollBody = (await pollPromise) as { status: string };
      expect(pollBody.status).toBe("closed");

      // The poll's own "agent: listening" broadcast may still be buffered ahead of
      // the close, so drain until the stream itself ends.
      let streamClosed = false;
      let received = "";
      const decoder = new TextDecoder();
      for (let i = 0; i < 5 && !streamClosed; i++) {
        const chunk = await reader.read();
        if (chunk.value) received += decoder.decode(chunk.value);
        streamClosed = chunk.done;
      }
      expect(streamClosed).toBe(true);
      expect(received).toContain("event: closed");

      const missing = await fetch(`http://127.0.0.1:${record.port}/api/session/${firstId}`);
      expect(missing.status).toBe(404);

      const other = await fetch(`http://127.0.0.1:${record.port}/api/session/${secondId}`);
      expect(other.status).toBe(200);

      const sessionsDir = path.join(root, "state-v4", "sessions");
      expect(fs.existsSync(path.join(sessionsDir, `${firstId}.json`))).toBe(false);
      expect(fs.existsSync(path.join(sessionsDir, `${secondId}.json`))).toBe(true);
    } finally {
      await fetch(`http://127.0.0.1:${record.port}/shutdown`, {
        method: "POST",
        headers: { "x-piew-token": record.token },
      }).catch(() => undefined);
    }
  });

  it("answers a close of an unknown session with a typed 404 and deletes nothing", async () => {
    const source = path.join(root, "solo.md");
    fs.writeFileSync(source, "# Solo\n");
    const { sessionId } = await runCli(source);
    const record = JSON.parse(fs.readFileSync(path.join(root, "server-v4.json"), "utf8"));

    try {
      const res = await fetch(`http://127.0.0.1:${record.port}/api/session/s_unknown`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Session not found" });

      const stillThere = await fetch(`http://127.0.0.1:${record.port}/api/session/${sessionId}`);
      expect(stillThere.status).toBe(200);
    } finally {
      await fetch(`http://127.0.0.1:${record.port}/shutdown`, {
        method: "POST",
        headers: { "x-piew-token": record.token },
      }).catch(() => undefined);
    }
  });

  it("piew close prints the closed session id and removes it", async () => {
    const source = path.join(root, "cli-close.md");
    fs.writeFileSync(source, "# CLI Close\n");
    const { sessionId } = await runCli(source);
    const record = JSON.parse(fs.readFileSync(path.join(root, "server-v4.json"), "utf8"));

    try {
      expect(await runCli("close", sessionId)).toEqual({ sessionId, closed: true });
      const missing = await fetch(`http://127.0.0.1:${record.port}/api/session/${sessionId}`);
      expect(missing.status).toBe(404);
    } finally {
      await fetch(`http://127.0.0.1:${record.port}/shutdown`, {
        method: "POST",
        headers: { "x-piew-token": record.token },
      }).catch(() => undefined);
    }
  });

  it("prunes every stored session without deleting reviewed sources", async () => {
    const firstSource = path.join(root, "first.md");
    const secondSource = path.join(root, "second.md");
    fs.writeFileSync(firstSource, "# First\n");
    fs.writeFileSync(secondSource, "# Second\n");
    fs.writeFileSync(path.join(root, "state-v3.json"), "legacy");
    await runCli(firstSource);
    await runCli(secondSource);
    const record = JSON.parse(fs.readFileSync(path.join(root, "server-v4.json"), "utf8"));

    try {
      const unauthorized = await fetch(`http://127.0.0.1:${record.port}/api/sessions`, {
        method: "DELETE",
      });
      expect(unauthorized.status).toBe(401);

      expect(await runCli("prune")).toEqual({ sessions: 2, files: 3 });
      expect(fs.existsSync(path.join(root, "state-v3.json"))).toBe(false);
      expect(fs.existsSync(firstSource)).toBe(true);
      expect(fs.existsSync(secondSource)).toBe(true);
    } finally {
      await fetch(`http://127.0.0.1:${record.port}/shutdown`, {
        method: "POST",
        headers: { "x-piew-token": record.token },
      }).catch(() => undefined);
    }
  });
});
