import { describe, expect, it } from "bun:test";
import {
  CompilerError,
  compileTool,
  toolArtifactDir,
  writeToolArtifact,
  readToolArtifact,
  deleteToolArtifact,
  deleteToolArtifacts,
  pruneToolArtifacts,
} from "../../src/server/tool-files";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("tool compiler", () => {
  it("bundles validated in-memory browser ESM", async () => {
    const artifact = await compileTool({
      entry: "Tool.tsx",
      files: {
        "Tool.tsx":
          'import React from "react"; export default React.createElement("button", null, "Ask");',
      },
    });

    expect(artifact.files).toEqual(["index.html"]);
    expect(artifact.bytes).toBeGreaterThan(0);
  });

  it("resolves relative virtual files", async () => {
    const artifact = await compileTool({
      entry: "Tool.tsx",
      files: {
        "Tool.tsx": 'import value from "./value.ts"; export default value;',
        "value.ts": "export default 1;",
      },
    });

    expect(artifact.files).toEqual(["index.html"]);
  });

  it("never resolves a relative import from the host filesystem", async () => {
    const external = path.resolve(__dirname, "../../src/lib/tool-api.ts");
    const specifier = path.posix.relative("/piew-tool", external.replaceAll(path.sep, "/"));

    await expect(
      compileTool({
        entry: "Tool.tsx",
        files: {
          "Tool.tsx": `import value from ${JSON.stringify(`./${specifier}`)}; export default value;`,
        },
      })
    ).rejects.toBeInstanceOf(CompilerError);
  });

  it("maps the Piew tool API to its bundled runtime", async () => {
    const artifact = await compileTool({
      entry: "Tool.tsx",
      files: {
        "Tool.tsx":
          'import { definePiewTool } from "@derhub/piew/tool"; export default definePiewTool({ component() { return null; } });',
      },
    });

    expect(artifact.files).toEqual(["index.html"]);
  });

  it("bundles binary package assets", async () => {
    const artifact = await compileTool({
      entry: "Tool.tsx",
      files: {
        "Tool.tsx":
          'import React from "react"; import logo from "./logo.png"; export default { component() { return React.createElement("img", { src: logo }); } };',
        "logo.png": {
          encoding: "base64",
          content:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        },
      },
    });

    expect(artifact.files).toEqual(["index.html"]);
  });

  for (const [name, source] of [
    ["dynamic imports", 'export default import("react")'],
    ["environment reads", "export default process.env.SECRET"],
    ["macros", 'import helper from "./helper" with { type: "macro" }; export default helper'],
    ["forbidden modules", 'import fs from "node:fs"; export default fs'],
    ["unknown packages", 'import packageValue from "left-pad"; export default packageValue'],
    ["URL imports", 'import remote from "https://example.test/tool.js"; export default remote'],
    ["path escapes", 'import value from "../outside"; export default value'],
  ]) {
    it(`rejects ${name}`, async () => {
      await expect(
        compileTool({ entry: "Tool.tsx", files: { "Tool.tsx": source } })
      ).rejects.toBeInstanceOf(CompilerError);
    });
  }

  it("rejects an oversized source file before compiling", async () => {
    await expect(
      compileTool({ entry: "Tool.tsx", files: { "Tool.tsx": "x".repeat(256 * 1024 + 1) } })
    ).rejects.toThrow("256 KiB");
  });

  it("rejects configuration files", async () => {
    await expect(
      compileTool({
        entry: "Tool.tsx",
        files: { "Tool.tsx": "export default 1", "tsconfig.json": "{}" },
      })
    ).rejects.toThrow("Invalid source file");
  });
});

describe("tool artifacts", () => {
  it("writes and serves only manifest-listed immutable files", () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "piew-tools-"));
    const previous = process.env.PIEW_DIR;
    process.env.PIEW_DIR = state;
    try {
      const artifact = writeToolArtifact("s_test", "ti_test", [
        { path: "tool.js", content: "export default 1" },
      ]);

      expect(artifact.files).toEqual(["tool.js"]);
      expect(readToolArtifact("s_test", "ti_test", "tool.js")?.toString()).toContain("default 1");
      fs.writeFileSync(path.join(toolArtifactDir("s_test", "ti_test"), "private.js"), "private");
      expect(readToolArtifact("s_test", "ti_test", "private.js")).toBeUndefined();
      expect(readToolArtifact("s_test", "ti_test", "manifest.json")).toBeUndefined();
      expect(fs.existsSync(toolArtifactDir("s_test", "ti_test"))).toBe(true);
    } finally {
      deleteToolArtifacts("s_test");
      if (previous === undefined) delete process.env.PIEW_DIR;
      else process.env.PIEW_DIR = previous;
      fs.rmSync(state, { recursive: true, force: true });
    }
  });

  it("never reads through or cleans inside symlinked artifact directories", () => {
    if (process.platform === "win32") return;
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "piew-tools-"));
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "piew-tools-external-"));
    const previous = process.env.PIEW_DIR;
    process.env.PIEW_DIR = state;
    try {
      writeToolArtifact("s_nested", "ti_nested", [
        { path: "nested/value.txt", content: "outside" },
      ]);
      const nested = path.join(toolArtifactDir("s_nested", "ti_nested"), "nested");
      fs.rmSync(nested, { recursive: true });
      fs.mkdirSync(path.join(external, "nested"));
      fs.writeFileSync(path.join(external, "nested", "value.txt"), "outside");
      fs.symlinkSync(path.join(external, "nested"), nested);
      expect(readToolArtifact("s_nested", "ti_nested", "nested/value.txt")).toBeUndefined();

      const root = path.dirname(path.dirname(toolArtifactDir("s_nested", "ti_nested")));
      fs.mkdirSync(path.join(external, "retained"));
      fs.writeFileSync(path.join(external, "retained", "keep.txt"), "keep");
      fs.symlinkSync(path.join(external, "retained"), path.join(root, "s_retained"));
      expect(pruneToolArtifacts(new Map([["s_retained", ["ti_keep"]]]))).toBe(2);
      expect(fs.readFileSync(path.join(external, "retained", "keep.txt"), "utf8")).toBe("keep");

      fs.mkdirSync(path.join(external, "retained", "ti_keep"));
      fs.writeFileSync(path.join(external, "retained", "ti_keep", "keep.txt"), "keep");
      fs.symlinkSync(path.join(external, "retained"), path.join(root, "s_link"));
      deleteToolArtifact("s_link", "ti_keep");
      expect(fs.existsSync(path.join(external, "retained", "ti_keep", "keep.txt"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PIEW_DIR;
      else process.env.PIEW_DIR = previous;
      fs.rmSync(state, { recursive: true, force: true });
      fs.rmSync(external, { recursive: true, force: true });
    }
  });
});
