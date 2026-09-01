import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReviewSession } from "../../src/lib/types";
import { SessionRuntime } from "../../src/server/session-runtime";
import { FileWatcher } from "../../src/server/watcher";

describe("SessionRuntime", () => {
  let directory: string;
  let file: string;
  let watcher: FileWatcher;
  let runtime: SessionRuntime;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "piew-runtime-"));
    file = path.join(directory, "review.md");
    fs.writeFileSync(file, "# Review\n");
    watcher = new FileWatcher(() => {});
    runtime = new SessionRuntime(watcher);
  });

  afterEach(() => {
    runtime.releaseAll();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function session(id: string): ReviewSession {
    return {
      id,
      activePageId: "p_1",
      reviewMap: { title: "Review", items: [{ pageId: "p_1", path: "review.md" }] },
      pages: {
        p_1: {
          id: "p_1",
          file,
          filename: "review.md",
          kind: "markdown",
          content: "# Review\n",
          comments: [],
          edits: [],
          hash: "hash",
        },
      },
      lastSeen: 1,
      turns: [],
      tools: {},
    };
  }

  function client() {
    return {
      close() {},
      enqueue() {},
    } as unknown as ReadableStreamDefaultController;
  }

  it("holds source watches from the first SSE client through the last disconnect", () => {
    const first = client();
    const second = client();

    runtime.connect("s_first", first, session("s_first"));
    runtime.connect("s_first", second, session("s_first"));
    expect({ runtime: runtime.counts(), watchers: watcher.count() }).toEqual({
      runtime: { sessions: 1, sse: 2, pollers: 0, timers: 0 },
      watchers: 1,
    });

    runtime.disconnect("s_first", first);
    expect(watcher.count()).toBe(1);

    runtime.disconnect("s_first", second);
    expect({ runtime: runtime.counts(), watchers: watcher.count() }).toEqual({
      runtime: { sessions: 0, sse: 0, pollers: 0, timers: 0 },
      watchers: 0,
    });
  });

  it("shares one source watch until every live session releases it", () => {
    const first = client();
    const second = client();

    runtime.connect("s_first", first, session("s_first"));
    runtime.connect("s_second", second, session("s_second"));
    expect(runtime.sessionsForSource(file)).toEqual(["s_first", "s_second"]);
    expect(watcher.count()).toBe(1);

    runtime.release("s_first");
    expect(runtime.sessionsForSource(file)).toEqual(["s_second"]);
    expect(watcher.count()).toBe(1);

    runtime.release("s_second");
    expect(runtime.sessionsForSource(file)).toEqual([]);
    expect(watcher.count()).toBe(0);
  });

  it("does not retain ownership when source watch registration fails", () => {
    let attempts = 0;
    const retryingWatcher = {
      watch() {
        attempts++;
        return attempts > 1;
      },
      unwatch() {},
    } as unknown as FileWatcher;
    const retryingRuntime = new SessionRuntime(retryingWatcher);

    retryingRuntime.connect("s_first", client(), session("s_first"));
    expect(retryingRuntime.sessionsForSource(file)).toEqual([]);

    retryingRuntime.connect("s_second", client(), session("s_second"));
    expect(retryingRuntime.sessionsForSource(file)).toEqual(["s_second"]);
    expect(attempts).toBe(2);
    retryingRuntime.releaseAll();
  });
});
