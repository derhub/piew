import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STORE_MODULE = pathToFileURL(path.resolve(__dirname, "../../src/server/store.ts")).href;
const CLI = path.resolve(__dirname, "../../bin/piew.ts");

describe("session storage", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "piew-storage-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function runIsolated(script: string) {
    const proc = Bun.spawn([process.execPath, "--eval", script], {
      cwd: path.resolve(__dirname, "../.."),
      env: { ...process.env, PIEW_DIR: root, PIEW_NO_OPEN: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr || stdout);
    return JSON.parse(stdout.trim());
  }

  async function runCli(...args: string[]) {
    return runIsolated(`
      const proc = Bun.spawnSync(${JSON.stringify([process.execPath, CLI])}.concat(${JSON.stringify(args)}), {
        cwd: ${JSON.stringify(path.resolve(__dirname, "../.."))},
        env: { ...process.env, PIEW_DIR: ${JSON.stringify(root)}, PIEW_NO_OPEN: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) throw new Error(proc.stderr.toString() || proc.stdout.toString());
      console.log(proc.stdout.toString().trim());
    `);
  }

  it("writes only the session that changed", async () => {
    const firstSource = path.join(root, "first.md");
    const secondSource = path.join(root, "second.md");
    fs.writeFileSync(firstSource, "# First\n");
    fs.writeFileSync(secondSource, "# Second\n");

    const result = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const store = new Store();
      const first = store.createSession([${JSON.stringify(firstSource)}]);
      const second = store.createSession([${JSON.stringify(secondSource)}]);
      const sessionsDir = path.join(process.env.PIEW_DIR, "state-v4", "sessions");
      const firstRecord = path.join(sessionsDir, first.id + ".json");
      const secondRecord = path.join(sessionsDir, second.id + ".json");
      const secondBefore = fs.readFileSync(secondRecord, "utf8");
      store.addComment(first.id, first.activePageId, {
        id: "c_first", kind: "general", feedback: "Change this", createdAt: 1,
      });
      console.log(JSON.stringify({
        files: fs.readdirSync(sessionsDir).sort(),
        expected: [first.id + ".json", second.id + ".json"].sort(),
        first: fs.readFileSync(firstRecord, "utf8"),
        secondUnchanged: fs.readFileSync(secondRecord, "utf8") === secondBefore,
      }));
    `);

    expect(result.files).toEqual(result.expected);
    expect(result.first).toContain("Change this");
    expect(result.secondUnchanged).toBe(true);
  });

  it("loads valid v4 sessions without importing legacy or malformed state", async () => {
    const source = path.join(root, "valid.md");
    fs.writeFileSync(source, "# Valid\n");
    const result = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const created = new Store().createSession([${JSON.stringify(source)}]);
      const sessionsDir = path.join(process.env.PIEW_DIR, "state-v4", "sessions");
      fs.writeFileSync(path.join(sessionsDir, "s_legacy.json"), JSON.stringify({ schemaVersion: 3, session: { id: "s_legacy" } }));
      fs.writeFileSync(path.join(sessionsDir, "s_broken.json"), "{not-json");
      const valid = JSON.parse(fs.readFileSync(path.join(sessionsDir, created.id + ".json"), "utf8"));
      delete valid.session.tools;
      fs.writeFileSync(path.join(sessionsDir, created.id + ".json"), JSON.stringify(valid));
      fs.writeFileSync(path.join(sessionsDir, "s_invalid.json"), JSON.stringify({
        schemaVersion: 4,
        session: {
          ...valid.session,
          id: "s_invalid",
          activePageId: "p_invalid",
          pages: {
            p_invalid: {
              ...Object.values(valid.session.pages)[0],
              id: "p_invalid",
              comments: [null],
            },
          },
        },
      }));
      fs.writeFileSync(path.join(process.env.PIEW_DIR, "state-v3.json"), JSON.stringify({ sessions: { s_old: { id: "s_old" } } }));
      const restored = new Store();
      console.log(JSON.stringify({
        ids: [...restored.sessions.keys()],
        createdId: created.id,
        tools: restored.sessions.get(created.id).tools,
        legacyExists: fs.existsSync(path.join(sessionsDir, "s_legacy.json")),
        quarantined: fs.readdirSync(path.join(process.env.PIEW_DIR, "state-v4", "quarantine")).length,
      }));
    `);

    expect(result.ids).toEqual([result.createdId]);
    expect(result.tools).toEqual({});
    expect(result.legacyExists).toBe(true);
    expect(result.quarantined).toBe(2);
  });

  it("restores owned artifacts and removes deleted, quarantined, and orphaned artifacts", async () => {
    const source = path.join(root, "tools.md");
    fs.writeFileSync(source, "# Tools\n");
    const result = await runIsolated(`
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { Store } = await import(${JSON.stringify(STORE_MODULE)});
      const tools = await import(${JSON.stringify(pathToFileURL(path.resolve(__dirname, "../../src/server/tool-files.ts")).href)});
      const store = new Store();
      const kept = store.createSession([${JSON.stringify(source)}]);
      const removed = store.createSession([${JSON.stringify(source)}]);
      const broken = store.createSession([${JSON.stringify(source)}]);
      for (const session of [kept, removed, broken]) {
        const id = "ti_" + session.id.slice(2);
        const artifact = tools.writeToolArtifact(session.id, id, [{ path: "index.html", content: "ok" }]);
        store.addTool(session.id, {
          id, tool: "button", state: "open", request: { prompt: "Continue", data: null },
          artifact, createdAt: Date.now(), replies: [],
        });
      }
      tools.writeToolArtifact("s_orphan", "ti_orphan", [{ path: "index.html", content: "orphan" }]);
      store.remove(removed.id);

      const brokenRecord = path.join(process.env.PIEW_DIR, "state-v4", "sessions", broken.id + ".json");
      const invalid = JSON.parse(fs.readFileSync(brokenRecord, "utf8"));
      invalid.session.tools["ti_" + broken.id.slice(2)].artifact.files = ["../escape"];
      fs.writeFileSync(brokenRecord, JSON.stringify(invalid));

      const restored = new Store();
      const keptId = "ti_" + kept.id.slice(2);
      console.log(JSON.stringify({
        kept: fs.existsSync(tools.toolArtifactDir(kept.id, keptId)),
        keptTools: Object.keys(restored.sessions.get(kept.id).tools),
        removed: fs.existsSync(tools.toolArtifactDir(removed.id, "ti_" + removed.id.slice(2))),
        broken: fs.existsSync(tools.toolArtifactDir(broken.id, "ti_" + broken.id.slice(2))),
        orphan: fs.existsSync(tools.toolArtifactDir("s_orphan", "ti_orphan")),
      }));
    `);

    expect(result.kept).toBe(true);
    expect(result.keptTools).toHaveLength(1);
    expect(result.removed).toBe(false);
    expect(result.broken).toBe(false);
    expect(result.orphan).toBe(false);
  });

  it("prunes every stored session without deleting reviewed sources", async () => {
    const firstSource = path.join(root, "first.md");
    const secondSource = path.join(root, "second.md");
    fs.writeFileSync(firstSource, "# First\n");
    fs.writeFileSync(secondSource, "# Second\n");
    fs.writeFileSync(path.join(root, "state-v3.json"), "legacy");
    await runCli(firstSource);
    await runCli(secondSource);
    const record = JSON.parse(fs.readFileSync(path.join(root, "server.json"), "utf8"));

    try {
      const unauthorized = await fetch(`http://127.0.0.1:${record.port}/api/sessions`, {
        method: "DELETE",
      });
      expect(unauthorized.status).toBe(401);

      expect(await runCli("prune")).toEqual({ sessions: 2, files: 3 });
      expect(fs.existsSync(path.join(root, "state-v3.json"))).toBe(false);
      expect(fs.existsSync(firstSource)).toBe(true);
      expect(fs.existsSync(secondSource)).toBe(true);
    } finally {
      await fetch(`http://127.0.0.1:${record.port}/shutdown`, {
        method: "POST",
        headers: { "x-piew-token": record.token },
      }).catch(() => undefined);
    }
  });
});
