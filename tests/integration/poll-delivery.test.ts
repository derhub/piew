import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import { ReviewServer } from "../../src/server/server";

describe("Poll Delivery", () => {
  let server: ReviewServer;
  let port: number;
  let file: string;

  beforeAll(async () => {
    file = path.resolve(__dirname, "doc-poll.md");
    fs.writeFileSync(file, "# Doc\n\nContent.", "utf8");

    server = new ReviewServer();
    port = await server.start(5896);
  });

  afterAll(() => {
    server.stop();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  async function sendComment(feedback: string) {
    const sessionRes = await fetch(`http://127.0.0.1:${port}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [file] }),
    });
    const session = await sessionRes.json();

    await fetch(`http://127.0.0.1:${port}/api/page/${session.pageKeys[0]}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startLine: 1, feedback }),
    });

    await fetch(`http://127.0.0.1:${port}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: session.sessionId }),
    });
  }

  const poll = (query: string) =>
    fetch(`http://127.0.0.1:${port}/api/poll?target=${encodeURIComponent(file)}&${query}`).then(
      (r) => r.json()
    );

  // Comments accumulate on the page until a batch is acked, so each test clears its own.
  afterEach(async () => {
    await poll("timeout=1");
    await poll("ack=1&timeout=1");
  });

  it("answers a long poll that expires with a timeout status instead of closing the socket", async () => {
    const started = Date.now();
    const data = await poll("timeout=1");

    expect(data.status).toBe("timeout");
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("hands over an undelivered batch instead of clearing it when ack is passed", async () => {
    await sendComment("Never delivered");

    // A poll that died mid-flight leaves the batch undelivered; the retry carries --ack.
    const data = await poll("ack=1&timeout=1");

    expect(data.status).toBe("feedback");
    expect(data.pages[0].comments[0].feedback).toBe("Never delivered");
  });

  it("re-serves an unacked batch so a lost response can be fetched again", async () => {
    await sendComment("Response was lost");

    const first = await poll("timeout=1");
    expect(first.status).toBe("feedback");

    const retry = await poll("timeout=1");
    expect(retry.status).toBe("feedback");
    expect(retry.pages[0].comments[0].feedback).toBe("Response was lost");
  });

  it("clears a delivered batch when ack is passed", async () => {
    await sendComment("Already handled");

    const first = await poll("timeout=1");
    expect(first.status).toBe("feedback");

    const second = await poll("ack=1&timeout=1");
    expect(second.status).toBe("timeout");
  });
});
