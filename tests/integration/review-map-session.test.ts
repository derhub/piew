import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ReviewServer } from "../../src/server/server";

describe("Review Map sessions", () => {
  let server: ReviewServer;
  let port: number;
  let root: string;
  let first: string;
  let second: string;
  let sessionId: string;

  const request = (route: string, method = "GET", body?: unknown) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      ...(body
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(process.env.PIEW_DIR!, "review-map-"));
    first = path.join(root, "web", "first.md");
    second = path.join(root, "api", "second.ts");
    fs.mkdirSync(path.dirname(first));
    fs.mkdirSync(path.dirname(second));
    fs.writeFileSync(first, "# First\n");
    fs.writeFileSync(second, "export const second = true;\n");
    server = new ReviewServer();
    port = await server.start(5898);
    const created = await request("/api/session", "POST", { files: [first] });
    sessionId = (await created.json()).sessionId;
  });

  afterAll(() => {
    server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("replaces a map atomically and preserves its active page", async () => {
    const before = await (await request(`/api/session/${sessionId}`)).json();
    const pageId = before.activePageId;
    const replaced = await request(`/api/session/${sessionId}/map`, "PUT", {
      title: "Release review",
      items: [
        { path: "Web/Auth/First", source: { kind: "page", pageId } },
        { path: "API/Auth/Second", source: { kind: "file", file: second } },
      ],
    });

    expect(replaced.status).toBe(200);
    const body = await replaced.json();
    expect(body.activePageId).toBe(pageId);
    expect(body.reviewMap.items.map((item: { path: string }) => item.path)).toEqual([
      "Web/Auth/First",
      "API/Auth/Second",
    ]);

    const snapshot = JSON.stringify(await (await request(`/api/session/${sessionId}`)).json());
    const failed = await request(`/api/session/${sessionId}/map`, "PUT", {
      title: "Broken",
      items: [{ path: "Missing/File", source: { kind: "file", file: path.join(root, "missing") } }],
    });
    expect(failed.status).toBe(404);
    expect(JSON.stringify(await (await request(`/api/session/${sessionId}`)).json())).toBe(
      snapshot
    );

    const duplicate = await request(`/api/session/${sessionId}/map`, "PUT", {
      title: "Broken",
      items: [
        { path: "First/Copy", source: { kind: "file", file: second } },
        { path: "Second/Copy", source: { kind: "file", file: second } },
      ],
    });
    expect(duplicate.status).toBe(409);
    expect(JSON.stringify(await (await request(`/api/session/${sessionId}`)).json())).toBe(
      snapshot
    );

    const current = await (await request(`/api/session/${sessionId}`)).json();
    const persist = server.store.persist.bind(server.store);
    server.store.persist = () => {
      throw new Error("disk unavailable");
    };
    const persistenceFailure = await request(`/api/session/${sessionId}/map`, "PUT", {
      title: "Must roll back",
      items: current.reviewMap.items.map((item: { pageId: string; path: string }) => ({
        path: item.path,
        source: { kind: "page", pageId: item.pageId },
      })),
    });
    server.store.persist = persist;
    expect(persistenceFailure.status).toBe(400);
    expect(JSON.stringify(await (await request(`/api/session/${sessionId}`)).json())).toBe(
      snapshot
    );
  });

  it("blocks removal of a page with unresolved feedback", async () => {
    const session = await (await request(`/api/session/${sessionId}`)).json();
    const secondItem = session.reviewMap.items[1];
    await request(`/api/session/${sessionId}/page/${secondItem.pageId}/comment`, "POST", {
      feedback: "Keep this visible",
    });

    const response = await request(`/api/session/${sessionId}/map`, "PUT", {
      title: "Release review",
      items: [
        {
          path: session.reviewMap.items[0].path,
          source: { kind: "page", pageId: session.reviewMap.items[0].pageId },
        },
      ],
    });

    expect(response.status).toBe(409);
    expect(
      (await (await request(`/api/session/${sessionId}`)).json()).reviewMap.items
    ).toHaveLength(2);
  });

  it("releases watches for pages removed from the map", async () => {
    const session = await (await request(`/api/session/${sessionId}`)).json();
    const extra = path.join(root, "extra.ts");
    fs.writeFileSync(extra, "export const extra = true;\n");
    const added = await request(`/api/session/${sessionId}/map`, "PUT", {
      title: session.reviewMap.title,
      items: [
        ...session.reviewMap.items.map((item: { path: string; pageId: string }) => ({
          path: item.path,
          source: { kind: "page", pageId: item.pageId },
        })),
        { path: "Extra/File", source: { kind: "file", file: extra } },
      ],
    });
    expect(added.status).toBe(200);
    const watchersWithExtraPage = server.resourceCounts().watchers;

    const removed = await request(`/api/session/${sessionId}/map`, "PUT", {
      title: session.reviewMap.title,
      items: session.reviewMap.items.map((item: { path: string; pageId: string }) => ({
        path: item.path,
        source: { kind: "page", pageId: item.pageId },
      })),
    });
    expect(removed.status).toBe(200);
    expect(server.resourceCounts().watchers).toBe(watchersWithExtraPage - 1);
  });

  it("isolates the same file and its feedback between sessions", async () => {
    const other = await (await request("/api/session", "POST", { files: [first] })).json();
    const current = await (await request(`/api/session/${sessionId}`)).json();
    const currentPage = current.reviewMap.items[0].pageId;
    await request(`/api/session/${sessionId}/page/${currentPage}/comment`, "POST", {
      feedback: "Only the first session",
    });
    await request(`/api/session/${sessionId}/send`, "POST", {});

    const firstPoll = await request(`/api/session/${sessionId}/poll`);
    const otherPoll = await request(`/api/session/${other.sessionId}/poll?timeout=0.01`);
    expect((await firstPoll.json()).pages[0].comments[0].feedback).toBe("Only the first session");
    expect((await otherPoll.json()).status).toBe("timeout");
  });

  it("restores session-owned pages and feedback from schema v4", async () => {
    const restarted = new ReviewServer();
    const session = restarted.store.sessions.get(sessionId);
    expect(session?.reviewMap.title).toBe("Release review");
    expect(Object.values(session?.pages ?? {}).some((page) => page.comments.length > 0)).toBe(true);
    expect(
      fs.existsSync(path.join(process.env.PIEW_DIR!, "state-v4", "sessions", `${sessionId}.json`))
    ).toBe(true);
  });
});
