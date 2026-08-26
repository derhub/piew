import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ReviewServer } from "../../src/server/server";

describe("Session expiry cleanup", () => {
  it("releases expired resources, preserves shared watches, and drains stop", async () => {
    const root = fs.mkdtempSync(path.join(process.env.PIEW_DIR!, "expiry-"));
    const shared = path.join(root, "shared.md");
    const expiredOnly = path.join(root, "expired.md");
    const activeOnly = path.join(root, "active.md");
    for (const file of [shared, expiredOnly, activeOnly]) {
      fs.writeFileSync(file, `# ${path.basename(file)}\n`, "utf8");
    }

    const server = new ReviewServer();
    const port = await server.start(5912);
    const createSession = (files: string[]) =>
      fetch(`http://127.0.0.1:${port}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      }).then((response) => response.json());

    const expired = await createSession([shared, expiredOnly]);
    const active = await createSession([shared, activeOnly]);
    server.store.sessions.get(expired.sessionId)!.lastSeen = Date.now() - 8 * 24 * 60 * 60 * 1000;

    const expiredEvents = await fetch(
      `http://127.0.0.1:${port}/events?session=${expired.sessionId}`
    );
    const activeEvents = await fetch(`http://127.0.0.1:${port}/events?session=${active.sessionId}`);
    const expiredReader = expiredEvents.body!.getReader();
    const activeReader = activeEvents.body!.getReader();
    await expiredReader.read();
    await activeReader.read();

    const expiredPoll = fetch(
      `http://127.0.0.1:${port}/api/session/${expired.sessionId}/poll?timeout=240`
    );
    const activePoll = fetch(
      `http://127.0.0.1:${port}/api/session/${active.sessionId}/poll?timeout=240`
    );
    await Bun.sleep(20);

    expect(server.resourceCounts()).toMatchObject({ watchers: 3, sse: 2, pollers: 2, timers: 3 });
    expect(server.cleanupExpiredSessions()).toEqual({
      sessionIds: [expired.sessionId],
      unreferencedFiles: [expiredOnly],
    });
    expect(server.resourceCounts()).toMatchObject({ watchers: 2, sse: 1, pollers: 1, timers: 2 });
    expect((await expiredPoll).status).toBe(200);
    await expiredReader.read();
    expect((await expiredReader.read()).done).toBe(true);
    expect(
      await fetch(`http://127.0.0.1:${port}/api/session/${expired.sessionId}`).then(
        (response) => response.status
      )
    ).toBe(404);
    expect(
      await fetch(`http://127.0.0.1:${port}/api/session/${active.sessionId}`).then(
        (response) => response.status
      )
    ).toBe(200);

    server.stop();

    expect((await activePoll).status).toBe(200);
    await activeReader.read();
    expect((await activeReader.read()).done).toBe(true);
    expect(server.resourceCounts()).toMatchObject({ watchers: 0, sse: 0, pollers: 0, timers: 0 });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
