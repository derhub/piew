import { describe, expect, it } from "bun:test";
import { findMatches } from "~/components/FindBar";

const SOURCE = "# Title\n\nThe cache is warm.\n\nThe Cache is cold.\n";

describe("findMatches", () => {
  it("reports every matching line in file order", () => {
    expect(findMatches(SOURCE, "cache").map((m) => m.line)).toEqual([3, 5]);
  });

  it("matches without regard to case", () => {
    expect(findMatches(SOURCE, "CACHE")).toHaveLength(2);
  });

  it("returns nothing for a blank query", () => {
    expect(findMatches(SOURCE, "   ")).toEqual([]);
  });

  it("carries the line text so a match can be previewed", () => {
    expect(findMatches(SOURCE, "warm")[0].text).toBe("The cache is warm.");
  });
});
