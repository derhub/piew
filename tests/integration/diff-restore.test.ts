import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { ReviewServer } from "../../src/server/server";
import { resolveDiff } from "../../src/cli/git";

describe("Diff restore after a restart", () => {
  let repo: string;
  let file: string;
  let server: ReviewServer;
  let port: number;

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

  beforeAll(async () => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(process.env.PIEW_DIR!, "repo-")));
    file = path.join(repo, "src.txt");

    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(file, "one\ntwo\nthree\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "base");
    fs.writeFileSync(file, "one\nTWO\nthree\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "change");

    server = new ReviewServer();
    port = await server.start(5903);
  });

  afterAll(() => {
    server.stop();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const api = (route: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });

  it("restores the reviewed bytes and keeps every comment on its line", async () => {
    const resolved = resolveDiff("HEAD~1", { cwd: repo });
    const session = await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ diff: resolved }),
    }).then((r) => r.json());

    const pageId = session.reviewMap.items[0].pageId;
    await api(`/api/session/${session.sessionId}/page/${pageId}/comment`, {
      method: "POST",
      body: JSON.stringify({ startLine: 2, side: "new", feedback: "shouting" }),
    });

    const before = await api(`/api/session/${session.sessionId}/page/${pageId}`).then((r) =>
      r.json()
    );

    // The working tree moves on while the daemon is down: without frozen bytes
    // the comment would land on whatever line 2 says next.
    server.stop();
    fs.writeFileSync(file, "zero\none\nTWO\nthree\n", "utf8");

    const restarted = new ReviewServer();
    const newPort = await restarted.start(5905);
    try {
      const state = await fetch(
        `http://127.0.0.1:${newPort}/api/session/${session.sessionId}`
      ).then((r) => r.json());

      expect(state.reviewMap.items.map((item: { pageId: string }) => item.pageId)).toContain(
        pageId
      );
      expect(state.pages[pageId].comments[0]).toMatchObject({
        startLine: 2,
        feedback: "shouting",
      });

      const after = await fetch(
        `http://127.0.0.1:${newPort}/api/session/${session.sessionId}/page/${pageId}`
      ).then((r) => r.json());
      expect(after.diff.newContent).toBe(before.diff.newContent);
    } finally {
      restarted.stop();
    }
  });
});
