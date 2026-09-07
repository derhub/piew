import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeReviewMapRequest, ReviewMapError, Store } from "../../src/server/store";

const file = (mapPath: string) => ({
  path: mapPath,
  source: { kind: "file" as const, file: `/tmp/${mapPath}` },
});

describe("Review Map validation", () => {
  it("preserves caller order", () => {
    const result = normalizeReviewMapRequest({
      title: "Release",
      items: [file("Web/Auth/login.ts"), file("API/Auth/route.ts")],
    });

    expect(result.items.map((item) => item.path)).toEqual([
      "Web/Auth/login.ts",
      "API/Auth/route.ts",
    ]);
  });

  for (const invalid of [
    "",
    "/Project/file.ts",
    "Project//file.ts",
    "Project/./file.ts",
    "Project/../file.ts",
    "Project/ /file.ts",
    "Project/\nfile.ts",
  ]) {
    it(`rejects ${JSON.stringify(invalid)}`, () => {
      expect(() => normalizeReviewMapRequest({ title: "Map", items: [file(invalid)] })).toThrow(
        ReviewMapError
      );
    });
  }

  it("rejects duplicate paths", () => {
    expect(() =>
      normalizeReviewMapRequest({ title: "Map", items: [file("App/file.ts"), file("App/file.ts")] })
    ).toThrow("Duplicate Review Map path");
  });

  it("rejects duplicate existing pages", () => {
    expect(() =>
      normalizeReviewMapRequest({
        title: "Map",
        items: [
          { path: "First/file.ts", source: { kind: "page", pageId: "p_one" } },
          { path: "Second/file.ts", source: { kind: "page", pageId: "p_one" } },
        ],
      })
    ).toThrow("Duplicate Review Map page");
  });

  it("accepts a six-segment agent-authored map path", () => {
    const result = normalizeReviewMapRequest({
      title: "Map",
      items: [file("repo/src/a/x/y/file.ts")],
    });

    expect(result.items.map((item) => item.path)).toEqual(["repo/src/a/x/y/file.ts"]);
  });

  it("rejects a path past 32 segments", () => {
    const deep = [...Array(32).keys()].map((index) => `d${index}`).join("/");

    expect(() =>
      normalizeReviewMapRequest({ title: "Map", items: [file(`${deep}/file.ts`)] })
    ).toThrow(ReviewMapError);
  });
});

describe("open a diff session on files that share their last four path segments", () => {
  const diffPaths = () => {
    const session = new Store().createDiffSession({
      repoRoot: "/repo",
      range: "main..feature",
      staged: false,
      liveHead: false,
      files: [
        { oldPath: "src/a/x/y/z/file.ts", newPath: "src/a/x/y/z/file.ts", status: "modified" },
        { oldPath: "src/b/x/y/z/file.ts", newPath: "src/b/x/y/z/file.ts", status: "modified" },
      ],
    });
    return session.reviewMap.items.map((item) => item.path);
  };

  it("gives each file its real repo-relative tree path", () => {
    expect(diffPaths()).toEqual(["repo/src/a/x/y/z/file.ts", "repo/src/b/x/y/z/file.ts"]);
  });

  it("renames no file to a numeric-prefixed leaf", () => {
    expect(diffPaths().filter((mapPath) => /(^|\/)\d+-/.test(mapPath))).toEqual([]);
  });
});

describe("open a file session on two files sharing a name", () => {
  it("separates them by their real parent directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "piew-map-unit-"));
    const files = ["web/src/x.ts", "api/src/x.ts"].map((relative) => {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "export const x = 1;\n");
      return target;
    });

    const session = new Store().createSession(files);

    expect(session.reviewMap.items.map((item) => item.path)).toEqual(["src/x.ts", "api/src/x.ts"]);
  });
});
