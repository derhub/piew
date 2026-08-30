import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];
const repo = path.resolve(__dirname, "../..");

function run(command: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || result.stdout.toString());
  }
  return result.stdout.toString().trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("production package", () => {
  it("exports the tool API and compiles a seeded tool without development dependencies", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piew-package-"));
    roots.push(root);
    const app = path.join(root, "app");
    const state = path.join(root, "state");
    fs.mkdirSync(app);

    run([process.execPath, "run", "build"], repo);
    const packed = run(
      [process.execPath, "pm", "pack", "--ignore-scripts", "--quiet", "--destination", root],
      repo
    );
    const tarball = path.join(root, path.basename(packed.split("\n").at(-1)!));
    fs.writeFileSync(
      path.join(app, "package.json"),
      JSON.stringify({ private: true, dependencies: { "@derhub/piew": `file:${tarball}` } })
    );
    run([process.execPath, "install", "--production"], app);

    expect(
      run(
        [
          process.execPath,
          "--eval",
          'import { definePiewTool } from "@derhub/piew/tool"; console.log(typeof definePiewTool)',
        ],
        app
      )
    ).toBe("function");

    const document = path.join(root, "review.md");
    fs.writeFileSync(document, "# Package review\n");
    const cli = path.join(app, "node_modules", ".bin", "piew");
    const session = JSON.parse(
      run([process.execPath, cli, document], app, { PIEW_DIR: state, PIEW_NO_OPEN: "1" })
    ) as { sessionId: string };
    const invocation = Bun.spawnSync(
      [process.execPath, cli, "tools", "question", session.sessionId],
      {
        cwd: app,
        env: { ...process.env, PIEW_DIR: state, PIEW_NO_OPEN: "1" },
        stdin: new TextEncoder().encode(
          JSON.stringify({ prompt: "Choose", data: { choices: ["keep", "change"] } })
        ),
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(invocation.stderr.toString()).toBe("");
    expect(invocation.exitCode).toBe(0);
    expect(JSON.parse(invocation.stdout.toString())).toMatchObject({
      status: "open",
      tool: "question",
    });

    const record = JSON.parse(fs.readFileSync(path.join(state, "server.json"), "utf8"));
    run(
      [
        process.execPath,
        "--eval",
        `await fetch("http://127.0.0.1:${record.port}/shutdown", {method:"POST", headers:{"x-piew-token":"${record.token}"}})`,
      ],
      app
    );
  }, 120_000);
});
