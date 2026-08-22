import React from "react";
import { Search, X } from "lucide-react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { themeToTreeStyles, type GitStatusEntry } from "@pierre/trees";
import { resolveTheme } from "@pierre/diffs";
import { Button } from "~/components/ui/button";
import { useCodeTheme } from "~/hooks/use-code-theme";
import type { PageMeta } from "~/lib/types";

interface DocumentSidebarProps {
  pages: Record<string, PageMeta>;
  pageKeys: string[];
  activeKey: string;
  onSelectPage: (key: string) => void;
  title?: string;
}

// The tree is keyed by path, the session by page key. A diff page's filename is
// already repo-relative; a document's is an absolute host path, which would
// otherwise render as a chain of directories nobody is reviewing.
function treePath(page: PageMeta): string {
  return page.kind === "diff" ? page.filename : page.file.replace(/^\//, "");
}

/** Trims the directories every path shares, so a lone doc is one row again. */
function stripCommonPrefix(paths: string[]): string[] {
  if (paths.length === 0) return paths;
  const split = paths.map((p) => p.split("/"));
  const first = split[0];
  let shared = 0;
  while (
    shared < first.length - 1 &&
    split.every((s) => s.length > shared + 1 && s[shared] === first[shared])
  ) {
    shared++;
  }
  return split.map((s) => s.slice(shared).join("/"));
}

const GIT_STATUS: Record<string, GitStatusEntry["status"]> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
};

export function DocumentSidebar({
  pages,
  pageKeys,
  activeKey,
  onSelectPage,
  title = "Explorer",
}: DocumentSidebarProps) {
  const ordered = React.useMemo(
    () => pageKeys.map((key) => pages[key]).filter((p): p is PageMeta => !!p),
    [pageKeys, pages]
  );

  const paths = React.useMemo(() => stripCommonPrefix(ordered.map(treePath)), [ordered]);

  const keyByPath = React.useMemo(() => {
    const map = new Map<string, string>();
    ordered.forEach((page, i) => map.set(paths[i], page.key));
    return map;
  }, [ordered, paths]);

  const pathByKey = React.useMemo(() => {
    const map = new Map<string, string>();
    ordered.forEach((page, i) => map.set(page.key, paths[i]));
    return map;
  }, [ordered, paths]);

  const countByPath = React.useMemo(() => {
    const map = new Map<string, number>();
    ordered.forEach((page, i) => map.set(paths[i], page.comments.length + page.edits.length));
    return map;
  }, [ordered, paths]);

  const gitStatus = React.useMemo<GitStatusEntry[]>(
    () =>
      ordered
        .map((p, i) => ({ page: p, path: paths[i] }))
        .filter(({ page }) => page.kind === "diff" && page.status && GIT_STATUS[page.status])
        .map(({ page, path }) => ({ path, status: GIT_STATUS[page.status!] })),
    [ordered, paths]
  );

  const activePath = pathByKey.get(activeKey);

  // The model reads these through refs on every render pass, so the callbacks
  // must see current props rather than the ones captured at mount.
  const selectRef = React.useRef(onSelectPage);
  selectRef.current = onSelectPage;
  const countRef = React.useRef(countByPath);
  countRef.current = countByPath;
  const keyRef = React.useRef(keyByPath);
  keyRef.current = keyByPath;

  const { model } = useFileTree({
    paths,
    gitStatus,
    density: "compact",
    initialExpansion: "open",
    search: true,
    initialSelectedPaths: activePath ? [activePath] : [],
    onSelectionChange: (selected) => {
      const key = selected.length ? keyRef.current.get(selected[0]) : undefined;
      if (key) selectRef.current(key);
    },
    renderRowDecoration: ({ row }) => {
      if (row.kind !== "file") return null;
      const count = countRef.current.get(row.path) ?? 0;
      return count > 0 ? { text: String(count), title: `${count} annotation(s)` } : null;
    },
  });

  // The model is created once; every later change is a method call on it.
  const pathsKey = paths.join("\n");
  React.useEffect(() => {
    model.resetPaths(paths);
  }, [model, pathsKey]);

  React.useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  // Selection can also change from outside the tree, through a drawer jump or a
  // link between documents, and the highlighted row has to follow it.
  React.useEffect(() => {
    if (!activePath) return;
    if (model.getSelectedPaths().includes(activePath)) return;
    model.getItem(activePath)?.select();
  }, [model, activePath]);

  // The tree reads colours from CSS variables, so the picked Shiki theme has to be
  // resolved and mapped before it can paint the explorer alongside the diff.
  const { active } = useCodeTheme();
  const [treeStyle, setTreeStyle] = React.useState<React.CSSProperties>({});

  React.useEffect(() => {
    let cancelled = false;
    resolveTheme(active)
      .then((resolved) => {
        if (!cancelled) setTreeStyle(themeToTreeStyles(resolved) as React.CSSProperties);
      })
      .catch(() => {
        if (!cancelled) setTreeStyle({});
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const [searching, setSearching] = React.useState(false);
  const toggleSearch = () => {
    if (model.isSearchOpen()) {
      model.closeSearch();
      setSearching(false);
    } else {
      model.openSearch();
      setSearching(true);
    }
  };

  return (
    <div className="bg-sidebar text-sidebar-foreground flex h-full min-h-0 flex-col border-r">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b pr-1 pl-3">
        <span className="text-muted-foreground flex-1 truncate text-[11px] font-medium tracking-wider uppercase">
          {title}
        </span>
        <span className="text-muted-foreground text-[11px] tabular-nums">{ordered.length}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={searching ? "Close search" : "Search files"}
          aria-pressed={searching}
          onClick={toggleSearch}
        >
          {searching ? <X className="size-3.5" /> : <Search className="size-3.5" />}
        </Button>
      </div>

      <FileTree model={model} className="min-h-0 flex-1 text-[13px]" style={treeStyle} />
    </div>
  );
}
