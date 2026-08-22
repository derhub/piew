import { describe, expect, it } from "bun:test";
import React from "react";
import { extractHeadings } from "~/lib/headings";
import { nodeText, slugify } from "~/lib/slug";

describe("extractHeadings", () => {
  it("extracts H1-H6 headings with line numbers and slugs", () => {
    const md = `# Main Architecture\n\nSome text\n\n## Data Flow\n\nMore text\n\n### Storage Adapter\n\nFinal text`;
    const headings = extractHeadings(md);

    expect(headings.length).toBe(3);
    expect(headings[0]).toEqual({
      level: 1,
      text: "Main Architecture",
      id: "main-architecture",
      line: 1,
    });
    expect(headings[1]).toEqual({
      level: 2,
      text: "Data Flow",
      id: "data-flow",
      line: 5,
    });
    expect(headings[2]).toEqual({
      level: 3,
      text: "Storage Adapter",
      id: "storage-adapter",
      line: 9,
    });
  });

  it("ignores comment lines inside fenced code blocks", () => {
    const md = `# Title\n\n\`\`\`bash\n# not a heading\n\`\`\`\n\n## Real Section`;
    const headings = extractHeadings(md);

    expect(headings.map((h) => h.text)).toEqual(["Title", "Real Section"]);
  });

  it("handles empty or heading-less markdown", () => {
    const md = `Just a simple document with no headings.`;
    const headings = extractHeadings(md);
    expect(headings.length).toBe(0);
  });
});

describe("slug parity", () => {
  it("matches outline ids to rendered heading ids for inline markup", () => {
    const md = "## Heading with `code` and **bold**";
    const [heading] = extractHeadings(md);

    // What react-markdown hands the heading renderer for the same source.
    const rendered = [
      "Heading with ",
      React.createElement("code", null, "code"),
      " and ",
      React.createElement("strong", null, "bold"),
    ];

    expect(heading.id).toBe("heading-with-code-and-bold");
    expect(slugify(nodeText(rendered))).toBe(heading.id);
  });
});
