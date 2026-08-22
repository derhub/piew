import { describe, expect, it, afterAll } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import { serverRecordPath } from "../../src/cli/paths";

const CLI = path.resolve(__dirname, "../../bin/piew.ts");

describe("piew --wait", () => {
  const file = path.resolve(__dirname, "doc-wait.md");

  afterAll(() => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    try {
      const record = JSON.parse(fs.readFileSync(serverRecordPath(), "utf8"));
      process.kill(record.pid);
    } catch {
      /* the daemon is already gone */
    }
  });

  it("opens and blocks in one process, printing the batch it woke up on", async () => {
    fs.writeFileSync(file, "# Doc\n\nContent.", "utf8");

    const proc = Bun.spawn(["bun", CLI, file, "--wait", "--timeout", "30"], {
      env: { ...process.env, PIEW_NO_OPEN: "1" },
      stdout: "pipe",
      stderr: "ignore",
    });

    // The session id only exists once the CLI has printed its URL, and the port
    // only once the daemon it started has written its record.
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let out = "";
    let sessionId = "";
    while (!sessionId) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      sessionId = out.match(/\/review\/(s_[a-f0-9]+)/)?.[1] ?? "";
    }
    expect(sessionId).not.toBe("");

    const { port } = JSON.parse(fs.readFileSync(serverRecordPath(), "utf8"));
    const session = await fetch(`http://127.0.0.1:${port}/api/session/${sessionId}`).then((r) =>
      r.json()
    );

    await fetch(`http://127.0.0.1:${port}/api/page/${session.pageKeys[0]}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startLine: 1, feedback: "tighten this" }),
    });
    await fetch(`http://127.0.0.1:${port}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    await proc.exited;

    const batch = JSON.parse(out.slice(out.indexOf("{")));
    expect(batch.status).toBe("feedback");
    expect(batch.pages[0].comments[0].feedback).toBe("tighten this");
  }, 40_000);
});
