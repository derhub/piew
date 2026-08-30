import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverToolPackages, ensureToolRegistry, ToolPackageError } from "../../src/lib/tools";
import { parseToolInvocationRequest } from "../../src/cli/tools";

const roots: string[] = [];
const CLI = path.resolve(__dirname, "../../bin/piew.ts");

function registry(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piew-tools-"));
  roots.push(root);
  return path.join(root, "tools");
}

function packageFiles(root: string, name = "custom") {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tool.json"),
    JSON.stringify({
      schemaVersion: 1,
      name,
      description: "A custom tool",
      when: "When needed",
      entry: "Tool.tsx",
      instructions: "instructions.md",
    })
  );
  fs.writeFileSync(path.join(dir, "Tool.tsx"), "export default {};\n");
  fs.writeFileSync(path.join(dir, "instructions.md"), "Use this tool.\n");
  return dir;
}

function runCli(state: string, ...args: string[]) {
  return Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, PIEW_DIR: state, PIEW_NO_OPEN: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("tool package discovery", () => {
  it("seeds the starter packages once", () => {
    const root = registry();
    const first = discoverToolPackages(root);
    expect(first.packages.map((tool) => tool.name)).toEqual(["button", "question", "rating"]);
    fs.rmSync(path.join(root, "button"), { recursive: true });
    expect(discoverToolPackages(root).packages.map((tool) => tool.name)).toEqual([
      "question",
      "rating",
    ]);
  });

  it("preserves an existing package during registry setup", () => {
    const root = registry();
    fs.mkdirSync(root, { recursive: true });
    const custom = packageFiles(root);
    const before = fs.readFileSync(path.join(custom, "instructions.md"), "utf8");
    ensureToolRegistry(root);
    expect(fs.readFileSync(path.join(custom, "instructions.md"), "utf8")).toBe(before);
  });

  it("rejects malformed metadata and traversal paths", () => {
    const root = registry();
    const dir = packageFiles(root);
    fs.writeFileSync(
      path.join(dir, "tool.json"),
      JSON.stringify({ schemaVersion: 1, name: "wrong", description: "", when: "", entry: "../x" })
    );
    const result = discoverToolPackages(root);
    expect(result.packages).toHaveLength(0);
    expect(result.invalid[0]).toContain("custom");
  });

  it("rejects symlinked package files and oversized files", () => {
    const root = registry();
    const dir = packageFiles(root);
    fs.rmSync(path.join(dir, "Tool.tsx"));
    fs.symlinkSync(path.join(dir, "instructions.md"), path.join(dir, "Tool.tsx"));
    expect(() => discoverToolPackages(root)).not.toThrow();
    expect(discoverToolPackages(root).invalid[0]).toMatch(/symlink/i);

    const oversized = packageFiles(root, "large");
    fs.writeFileSync(path.join(oversized, "Tool.tsx"), "x".repeat(256 * 1024 + 1));
    expect(discoverToolPackages(root).invalid.join(" ")).toMatch(/size|large/i);
  });

  it("reports validation failures without hiding valid packages", () => {
    const root = registry();
    packageFiles(root, "valid");
    fs.mkdirSync(path.join(root, "broken"));
    expect(discoverToolPackages(root).packages.map((tool) => tool.name)).toEqual(["valid"]);
    expect(discoverToolPackages(root).invalid).toHaveLength(1);
  });

  it("exposes a typed package error for direct validation", () => {
    const root = registry();
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(root, "bad"));
    expect(() => discoverToolPackages(root)).not.toThrow(ToolPackageError);
  });

  it("requires bounded opaque request data and validates anchors", () => {
    expect(parseToolInvocationRequest('{"prompt":"Choose","data":null}')).toEqual({
      prompt: "Choose",
      data: null,
    });
    expect(() => parseToolInvocationRequest('{"prompt":"Choose"}')).toThrow(/data is required/);
    expect(() =>
      parseToolInvocationRequest('{"prompt":"Choose","data":{},"anchor":{"pageId":"p_1","line":0}}')
    ).toThrow(/anchor/);
  });

  it("lists compact metadata and prints ordered help without starting the daemon", () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "piew-tools-cli-"));
    roots.push(state);

    const listed = runCli(state, "tools");
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.toString().trim().split("\n")).toHaveLength(3);
    expect(listed.stdout.toString()).toContain("question - Ask the reviewer to choose");

    const helped = runCli(state, "tools", "rating", "question", "-h");
    expect(helped.exitCode).toBe(0);
    expect(helped.stdout.toString().indexOf("piew tools rating")).toBeLessThan(
      helped.stdout.toString().indexOf("piew tools question")
    );
    expect(fs.existsSync(path.join(state, "server.json"))).toBe(false);
  });
});
