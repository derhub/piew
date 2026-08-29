import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveDiff } from "../../src/cli/git";
import { ReviewServer } from "../../src/server/server";

describe("diff restore after a restart", () => {
  let repo: string;
  let server: ReviewServer;
  let port: number;

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

  beforeAll(async () => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(process.env.PIEW_DIR!, "repo-")));
    fs.mkdirSync(path.join(repo, "app", "data"), { recursive: true });
    fs.mkdirSync(path.join(repo, "packages", "data"), { recursive: true });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, "app", "data", "same.ts"), "export const app = 1;\n");
    fs.writeFileSync(path.join(repo, "packages", "data", "same.ts"), "export const pkg = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    fs.writeFileSync(path.join(repo, "app", "data", "same.ts"), "export const app = 2;\n");
    fs.writeFileSync(path.join(repo, "packages", "data", "same.ts"), "export const pkg = 2;\n");
    git("add", "-A");
    git("commit", "-qm", "change");

    server = new ReviewServer();
    port = await server.start(5903);
  });

  afterAll(() => {
    server.stop();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("serves every unopened page after the source worktree is deleted", async () => {
    const resolved = resolveDiff("HEAD~1", { cwd: repo });
    const created = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ diff: resolved }),
    }).then((response) => response.json());
    const firstPageId = created.reviewMap.items[0].pageId;
    await fetch(
      `http://127.0.0.1:${port}/api/session/${created.sessionId}/page/${firstPageId}/comment`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startLine: 1, side: "new", feedback: "Keep this" }),
      }
    );

    server.stop();
    fs.rmSync(repo, { recursive: true, force: true });
    const restarted = new ReviewServer();
    const newPort = await restarted.start(5905);

    try {
      const session = await fetch(
        `http://127.0.0.1:${newPort}/api/session/${created.sessionId}`
      ).then((response) => response.json());
      const contentByFile: Record<string, string> = {};
      for (const item of session.reviewMap.items) {
        const page = await fetch(
          `http://127.0.0.1:${newPort}/api/session/${created.sessionId}/page/${item.pageId}`
        ).then((response) => response.json());
        contentByFile[session.pages[item.pageId].filename] = page.diff.newContent;
      }

      expect(contentByFile).toEqual({
        "app/data/same.ts": "export const app = 2;\n",
        "packages/data/same.ts": "export const pkg = 2;\n",
      });
      expect(session.pages[firstPageId].comments[0].feedback).toBe("Keep this");
    } finally {
      restarted.stop();
    }
  });
});
