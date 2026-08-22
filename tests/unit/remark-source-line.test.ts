import { describe, expect, it } from "bun:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { remarkSourceLine } from "~/lib/remark-source-line";

describe("remarkSourceLine", () => {
  it("injects data-line-start and data-line-end into AST nodes", async () => {
    const markdown = `# Title\n\nFirst paragraph.\n\n## Section 2\n\nSecond paragraph.`;

    const processor = unified().use(remarkParse).use(remarkSourceLine);
    const tree: any = processor.parse(markdown);
    await processor.run(tree);

    const heading1 = tree.children[0];
    expect(heading1.data?.hProperties?.["data-line-start"]).toBe(1);
    expect(heading1.data?.hProperties?.["data-line-end"]).toBe(1);

    const para1 = tree.children[1];
    expect(para1.data?.hProperties?.["data-line-start"]).toBe(3);
    expect(para1.data?.hProperties?.["data-line-end"]).toBe(3);

    const heading2 = tree.children[2];
    expect(heading2.data?.hProperties?.["data-line-start"]).toBe(5);
    expect(heading2.data?.hProperties?.["data-line-end"]).toBe(5);
  });
});
