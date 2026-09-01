import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ReviewServer } from "../../src/server/server";
import { resolveDiff } from "../../src/cli/git";

const FILE_COUNT = 500;

function git(args: string[], cwd: string) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout;
}

describe("Diff Session Integration", () => {
  let server: ReviewServer;
  let port: number;
  let repo: string;
  let pendingSessionId: string;
  let watchersBefore: number;
  let openedSession: Promise<{
    sessionId: string;
    reviewMap: { items: Array<{ pageId: string }> };
  }> | null = null;

  const post = (route: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piew-diffsession-")));
    git(["init", "-q", "-b", "main"], repo);
    git(["config", "user.email", "test@example.com"], repo);
    git(["config", "user.name", "test"], repo);
    fs.mkdirSync(path.join(repo, "src"));

    for (let i = 0; i < FILE_COUNT; i++) {
      fs.writeFileSync(path.join(repo, "src", `file-${i}.ts`), `const value = ${i};\n`.repeat(20));
    }
    git(["add", "."], repo);
    git(["commit", "-qm", "base"], repo);

    for (let i = 0; i < FILE_COUNT; i++) {
      fs.writeFileSync(
        path.join(repo, "src", `file-${i}.ts`),
        `const value = ${i + 1};\n`.repeat(20)
      );
    }
    git(["add", "-A"], repo);
    git(["commit", "-qm", "change"], repo);

    server = new ReviewServer();
    port = await server.start(5898);
    watchersBefore = server.resourceCounts().watchers;
  });

  afterAll(() => {
    server.stop();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const openDiff = async () => {
    if (openedSession) return openedSession;
    const resolved = resolveDiff("HEAD~1..HEAD", { cwd: repo });
    openedSession = post("/api/session", { diff: resolved }).then((response) => response.json());
    return openedSession;
  };

  it("carries no blob through the CLI payload", () => {
    const resolved = resolveDiff("HEAD~1..HEAD", { cwd: repo });
    const serialized = JSON.stringify(resolved);

    expect(resolved.files).toHaveLength(FILE_COUNT);
    expect(serialized).not.toContain("const value =");
  });

  it("returns no page content from the session route regardless of range size", async () => {
    const created = await openDiff();
    const session = await (
      await fetch(`http://127.0.0.1:${port}/api/session/${created.sessionId}`)
    ).json();

    expect({
      count: session.reviewMap.items.length,
      metadataOnly: Object.values(session.pages).every(
        (page: any) =>
          page.content === undefined &&
          page.diff === undefined &&
          /^src\/file-\d+\.ts$/.test(page.filename)
      ),
    }).toEqual({ count: FILE_COUNT, metadataOnly: true });
    expect(server.resourceCounts().watchers).toBe(watchersBefore);
  }, 20_000);

  it("serves both blob sides from the per-page route", async () => {
    const created = await openDiff();
    const reviewSession = server.store.read(created.sessionId)!;
    const key = created.reviewMap.items
      .map((item) => item.pageId)
      .find((k) => {
        const p = reviewSession.pages[k];
        return p?.filename === "src/file-0.ts";
      })!;

    const page = await (
      await fetch(`http://127.0.0.1:${port}/api/session/${created.sessionId}/page/${key}`)
    ).json();
    expect(page.kind).toBe("diff");
    expect(page.diff.oldContent).toContain("const value = 0;");
    expect(page.diff.newContent).toContain("const value = 1;");
  });

  it("serves ten pages under 250ms p95 without Git or state writes", async () => {
    const created = await openDiff();
    const record = path.join(
      process.env.PIEW_DIR!,
      "state-v4",
      "sessions",
      `${created.sessionId}.json`
    );
    const before = fs.readFileSync(record, "utf8");
    const movedRepo = `${repo}-offline`;
    const durations: number[] = [];
    fs.renameSync(repo, movedRepo);
    try {
      for (const item of created.reviewMap.items.slice(0, 10)) {
        const started = performance.now();
        const response = await fetch(
          `http://127.0.0.1:${port}/api/session/${created.sessionId}/page/${item.pageId}`
        );
        await response.arrayBuffer();
        durations.push(performance.now() - started);
      }
    } finally {
      fs.renameSync(movedRepo, repo);
    }
    durations.sort((a, b) => a - b);

    expect({
      recordUnchanged: fs.readFileSync(record, "utf8") === before,
      p95: durations[Math.floor((durations.length - 1) * 0.95)] < 250,
    }).toEqual({ recordUnchanged: true, p95: true });
  });

  it("polls a diff session by its session ID", async () => {
    const created = await openDiff();
    pendingSessionId = created.sessionId;

    await post(
      `/api/session/${created.sessionId}/page/${created.reviewMap.items[0].pageId}/comment`,
      {
        kind: "line_range",
        startLine: 3,
        endLine: 3,
        feedback: "narrow this",
        side: "new",
      }
    );
    await post(`/api/session/${created.sessionId}/send`, {});

    const batch = await (
      await fetch(`http://127.0.0.1:${port}/api/session/${created.sessionId}/poll`)
    ).json();

    expect(batch.status).toBe("feedback");
    expect(batch.pages[0].comments[0].feedback).toBe("narrow this");
  });

  it("keeps both the pending batch and the diff pages across a restart", () => {
    const restarted = new ReviewServer();

    expect(restarted.store.getBatch(pendingSessionId)).toBeDefined();
    expect(
      Object.values(restarted.store.read(pendingSessionId)!.pages).some(
        (page) => page.kind === "diff"
      )
    ).toBe(true);
  });
});
