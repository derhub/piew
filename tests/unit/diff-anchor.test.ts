import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ReviewServer } from "../../src/server/server";
import type { ResolvedDiff } from "../../src/server/store";

const RESOLVED: ResolvedDiff = {
  repoRoot: "/repo",
  range: "main..feat",
  staged: false,
  liveHead: false,
  files: [
    { status: "renamed", oldPath: "src/before.ts", newPath: "src/after.ts" },
    { status: "deleted", oldPath: "src/dropped.ts" },
  ],
};

describe("diff annotation anchoring", () => {
  let server: ReviewServer;
  let port: number;
  let sessionId: string;
  let pageId: string;

  const post = (route: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    server = new ReviewServer();
    port = await server.start(5897);

    const res = await post("/api/session", { diff: RESOLVED });
    const body = await res.json();
    sessionId = body.sessionId;
    pageId = body.reviewMap.items[0].pageId;
  });

  afterAll(() => server.stop());

  it("refuses a suggested edit on the old side", async () => {
    const res = await post(`/api/session/${sessionId}/page/${pageId}/edit`, {
      startLine: 2,
      endLine: 2,
      suggestedText: "const restored = true;",
      side: "old",
    });

    expect(res.status).toBe(400);
    expect(server.store.getPage(sessionId, pageId)!.edits).toHaveLength(0);
  });

  it("anchors a new-side edit to the post-image path", async () => {
    const res = await post(`/api/session/${sessionId}/page/${pageId}/edit`, {
      startLine: 2,
      endLine: 2,
      suggestedText: "const added = false;",
      side: "new",
    });

    const { edit } = await res.json();
    expect(edit.side).toBe("new");
    expect(edit.file).toBe("src/after.ts");
    expect(edit.startLine).toBe(2);
  });

  it("anchors an old-side comment to the pre-image path", async () => {
    const res = await post(`/api/session/${sessionId}/page/${pageId}/comment`, {
      kind: "line_range",
      startLine: 2,
      endLine: 2,
      feedback: "why was this dropped",
      side: "old",
    });

    const { comment } = await res.json();
    expect(comment.side).toBe("old");
    expect(comment.file).toBe("src/before.ts");
  });

  it("reports each side against its own path in the batch", () => {
    const pages = server.collectFeedback(sessionId);
    const oldPage = pages.find((p) => p.file.endsWith("before.ts"));
    const newPage = pages.find((p) => p.file.endsWith("after.ts"));

    expect(oldPage!.comments).toHaveLength(1);
    expect(oldPage!.edits).toBeUndefined();
    expect(newPage!.edits).toHaveLength(1);
  });

  it("forces the side on a file that only has an old path", async () => {
    const deletedKey = server.store.sessions.get(sessionId)!.reviewMap.items[1].pageId;
    const res = await post(`/api/session/${sessionId}/page/${deletedKey}/comment`, {
      kind: "line_range",
      startLine: 1,
      endLine: 1,
      feedback: "no side given",
    });

    const { comment } = await res.json();
    expect(comment.side).toBe("old");
    expect(comment.file).toBe("src/dropped.ts");
  });

  it("refuses an edit on a file that has no post-image path", async () => {
    const deletedKey = server.store.sessions.get(sessionId)!.reviewMap.items[1].pageId;
    const res = await post(`/api/session/${sessionId}/page/${deletedKey}/edit`, {
      startLine: 1,
      endLine: 1,
      suggestedText: "resurrect",
    });

    expect(res.status).toBe(400);
  });

  it("refuses to refresh a range whose new side is committed", async () => {
    const res = await post(`/api/session/${sessionId}/page/${pageId}/refresh`, {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/fixed/);
  });

  it("keeps annotations when the same range is opened again", async () => {
    const before = server.store.getPage(sessionId, pageId)!.comments.length;
    expect(before).toBeGreaterThan(0);

    await post("/api/session", { diff: RESOLVED });

    expect(server.store.getPage(sessionId, pageId)!.comments).toHaveLength(before);
  });

  it("edits an unsent comment in place", async () => {
    const created = await post(`/api/session/${sessionId}/page/${pageId}/comment`, {
      kind: "line_range",
      startLine: 5,
      endLine: 5,
      feedback: "first wording",
      side: "new",
    });
    const { comment } = await created.json();

    const patched = await fetch(
      `http://127.0.0.1:${port}/api/session/${sessionId}/page/${pageId}/comment/${comment.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "second wording" }),
      }
    );

    expect(patched.status).toBe(200);
    const stored = server.store
      .getPage(sessionId, pageId)!
      .comments.find((c) => c.id === comment.id);
    expect(stored!.feedback).toBe("second wording");
  });

  it("refuses to edit or delete a comment the agent already holds", async () => {
    const created = await post(`/api/session/${sessionId}/page/${pageId}/comment`, {
      kind: "line_range",
      startLine: 6,
      endLine: 6,
      feedback: "about to be sent",
      side: "new",
    });
    const { comment } = await created.json();

    await post(`/api/session/${sessionId}/send`, {});

    const patched = await fetch(
      `http://127.0.0.1:${port}/api/session/${sessionId}/page/${pageId}/comment/${comment.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "too late" }),
      }
    );
    const deleted = await fetch(
      `http://127.0.0.1:${port}/api/session/${sessionId}/page/${pageId}/comment/${comment.id}`,
      {
        method: "DELETE",
      }
    );

    expect(patched.status).toBe(409);
    expect(deleted.status).toBe(409);
    const stored = server.store
      .getPage(sessionId, pageId)!
      .comments.find((c) => c.id === comment.id);
    expect(stored!.feedback).toBe("about to be sent");
  });

  it("keeps the internal sent flag out of the agent's batch", () => {
    const pages = server.collectFeedback(sessionId);
    for (const page of pages) {
      for (const comment of page.comments) expect("sent" in comment).toBe(false);
      for (const edit of page.edits ?? []) expect("sent" in edit).toBe(false);
    }
  });

  it("persists a diff page with its own bytes, not as a path to re-read", () => {
    const stateFile = path.join(process.env.PIEW_DIR!, "state-v3.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));

    expect(state.sessions[sessionId].pages[pageId].range).toBeDefined();
  });

  it("restores a diff page with its annotations in a fresh store", () => {
    const restarted = new ReviewServer();
    const page = restarted.store.getPage(sessionId, pageId);

    expect(page?.kind).toBe("diff");
    expect(page?.comments.length).toBeGreaterThan(0);
  });
});
