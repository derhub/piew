import { describe, expect, it, afterAll } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { serverRecordPath } from "../../src/cli/paths";
import type { ReviewMap } from "../../src/lib/types";

const CLI = path.resolve(__dirname, "../../bin/piew.ts");
const SKILL = path.resolve(__dirname, "../../skills/piew/SKILL.md");

function runCli(args: string[], input?: string) {
  return spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, PIEW_NO_OPEN: "1" },
    input,
  });
}

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

  it("keeps the always-loaded skill within its byte budget", () => {
    const skill = fs.readFileSync(SKILL, "utf8");

    expect(Buffer.byteLength(skill)).toBeLessThanOrEqual(3_600);
    expect(skill).toContain("references/advanced.md");
  });

  it("prints bounded session output and shows or updates the map on demand", () => {
    const root = fs.mkdtempSync(path.join(process.env.PIEW_DIR!, "agent-output-"));
    const files = Array.from({ length: 50 }, (_, index) => {
      const file = path.join(root, `file-${index}.md`);
      fs.writeFileSync(file, `# File ${index}\n`, "utf8");
      return file;
    });

    try {
      const onePage = runCli([files[0]]);
      const fiftyPages = runCli(files);

      expect(onePage.status).toBe(0);
      expect(fiftyPages.status).toBe(0);
      expect(Buffer.byteLength(onePage.stdout)).toBeLessThanOrEqual(120);
      expect(Buffer.byteLength(fiftyPages.stdout)).toBeLessThanOrEqual(120);

      const opened = JSON.parse(fiftyPages.stdout);
      expect(Object.keys(opened).sort()).toEqual(["sessionId", "url"]);

      const shown = runCli(["map", opened.sessionId, "--show"]);
      expect(shown.status).toBe(0);
      expect(shown.stdout.trim().split("\n")).toHaveLength(1);
      const originalMap = JSON.parse(shown.stdout) as ReviewMap;
      expect(originalMap.items).toHaveLength(50);

      const replacement = {
        title: "Compact review",
        items: originalMap.items.map(({ path: mapPath, pageId }) => ({
          path: mapPath,
          source: { kind: "page", pageId },
        })),
      };
      const updated = runCli(["map", opened.sessionId], JSON.stringify(replacement));
      expect(updated.status).toBe(0);

      const invalid = runCli(
        ["map", opened.sessionId],
        JSON.stringify({
          title: "Broken",
          items: [
            {
              path: "Missing/File",
              source: { kind: "file", file: path.join(root, "missing.md") },
            },
          ],
        })
      );
      expect(invalid.status).not.toBe(0);

      const afterFailure = runCli(["map", opened.sessionId, "--show"]);
      expect(JSON.parse(afterFailure.stdout)).toEqual({
        ...originalMap,
        title: "Compact review",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
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

    await fetch(
      `http://127.0.0.1:${port}/api/session/${sessionId}/page/${session.reviewMap.items[0].pageId}/comment`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startLine: 1, feedback: "tighten this" }),
      }
    );
    await fetch(`http://127.0.0.1:${port}/api/session/${sessionId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overallNote: "whole batch note" }),
    });

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    await proc.exited;

    const lines = out.trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(Buffer.byteLength(`${lines[0]}\n`)).toBeLessThanOrEqual(120);
    expect(Object.keys(JSON.parse(lines[0])).sort()).toEqual(["sessionId", "url"]);

    const batch = JSON.parse(lines[1]);
    expect(batch.status).toBe("feedback");
    expect(batch.overall_note).toBe("whole batch note");
    expect(batch).not.toHaveProperty("sent_at");
    expect(batch).not.toHaveProperty("next_step");
    expect(batch.pages[0].comments[0]).toMatchObject({
      startLine: 1,
      feedback: "tighten this",
    });

    const status = runCli(["status", sessionId]);
    expect(status.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(status.stdout).status).toBe("feedback-waiting");

    const response = runCli(
      ["respond", sessionId],
      JSON.stringify({
        items: [{ id: batch.pages[0].comments[0].id, status: "applied" }],
      })
    );
    expect(response.status).toBe(0);
    expect(response.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(response.stdout).ok).toBe(true);
  }, 40_000);
});
