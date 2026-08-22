import { slugify } from "./slug";

export interface HeadingItem {
  level: number;
  text: string;
  id: string;
  line: number;
}

export function extractHeadings(markdown: string): HeadingItem[] {
  const headings: HeadingItem[] = [];
  let inFence = false;

  markdown.split("\n").forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (!match) return;

    const text = match[2].replace(/[#*`_]/g, "").trim();
    headings.push({ level: match[1].length, text, id: slugify(text), line: idx + 1 });
  });

  return headings;
}
