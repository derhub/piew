import { visit } from "unist-util-visit";
import type { Node } from "unist";

export function remarkSourceLine() {
  return (tree: Node) => {
    visit(tree, (node: any) => {
      if (node.position) {
        node.data = node.data || {};
        node.data.hProperties = node.data.hProperties || {};
        node.data.hProperties["data-line-start"] = node.position.start.line;
        node.data.hProperties["data-line-end"] = node.position.end.line;
      }
    });
  };
}
