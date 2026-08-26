import { describe, expect, it } from "bun:test";
import { normalizeReviewMapRequest, ReviewMapError, Store } from "../../src/server/store";

describe("Review Map validation", () => {
  const file = (path: string) => ({
    path,
    source: { kind: "file" as const, file: `/tmp/${path}` },
  });

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
    "one/two/three/four/five/six.ts",
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

  it("keeps colliding deep diff paths unique within five segments", () => {
    const store = new Store();
    const session = store.createDiffSession({
      repoRoot: "/repo",
      range: "main..feature",
      staged: false,
      liveHead: false,
      files: [
        { oldPath: "a/x/y/z/file.ts", newPath: "a/x/y/z/file.ts", status: "modified" },
        { oldPath: "b/x/y/z/file.ts", newPath: "b/x/y/z/file.ts", status: "modified" },
      ],
    });
    const paths = session.reviewMap.items.map((item) => item.path);

    expect(new Set(paths).size).toBe(2);
    expect(paths.every((mapPath) => mapPath.split("/").length <= 5)).toBe(true);
  });
});
