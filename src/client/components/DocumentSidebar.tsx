import React from "react";
import { Search, X } from "lucide-react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  preparePresortedFileTreeInput,
  themeToTreeStyles,
  type GitStatusEntry,
} from "@pierre/trees";
import { resolveTheme } from "@pierre/diffs";
import { Button } from "~/components/ui/button";
import { useCodeTheme } from "~/hooks/use-code-theme";
import type { PageMeta, ReviewMap } from "~/lib/types";

interface DocumentSidebarProps {
  pages: Record<string, PageMeta>;
  reviewMap: ReviewMap;
  activePageId: string;
  onSelectPage: (pageId: string) => void;
}

const GIT_STATUS: Record<string, GitStatusEntry["status"]> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
};

function directoryPaths(paths: string[]): string[] {
  const directories = new Set<string>();
  for (const treePath of paths) {
    const segments = treePath.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      directories.add(`${segments.slice(0, depth).join("/")}/`);
    }
  }
  return [...directories];
}

export function DocumentSidebar({
  pages,
  reviewMap,
  activePageId,
  onSelectPage,
}: DocumentSidebarProps) {
  const items = reviewMap.items;
  const pathsKey = items.map((item) => item.path).join("\n");
  const paths = React.useMemo(() => (pathsKey ? pathsKey.split("\n") : []), [pathsKey]);
  const preparedInput = React.useMemo(() => preparePresortedFileTreeInput(paths), [paths]);

  const keyByPath = React.useMemo(() => {
    const map = new Map<string, string>();
    items.forEach((item) => map.set(item.path, item.pageId));
    return map;
  }, [items]);

  const pathByKey = React.useMemo(() => {
    const map = new Map<string, string>();
    items.forEach((item) => map.set(item.pageId, item.path));
    return map;
  }, [items]);

  const countByPath = React.useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((item) => {
      const page = pages[item.pageId];
      map.set(item.path, page ? page.comments.length + page.edits.length : 0);
    });
    return map;
  }, [items, pages]);
  const annotationCountsKey = JSON.stringify([...countByPath]);

  const gitStatus = React.useMemo<GitStatusEntry[]>(
    () =>
      items
        .map((item) => ({ page: pages[item.pageId], path: item.path }))
        .filter(({ page }): page is PageMeta & { status?: PageMeta["status"] } => !!page)
        .filter(({ page }) => page.kind === "diff" && page.status && GIT_STATUS[page.status])
        .map(({ page, path }) => ({ path, status: GIT_STATUS[page.status!] })),
    [items, pages]
  );

  const activePath = pathByKey.get(activePageId);
  const [initialExpandedPaths] = React.useState(() => {
    const expanded = new Set(paths.map((treePath) => `${treePath.split("/")[0]}/`));
    if (activePath) {
      for (const directory of directoryPaths([activePath])) expanded.add(directory);
    }
    return [...expanded];
  });

  // The model reads these through refs on every render pass, so the callbacks
  // must see current props rather than the ones captured at mount.
  const selectRef = React.useRef(onSelectPage);
  selectRef.current = onSelectPage;
  const countRef = React.useRef(countByPath);
  countRef.current = countByPath;
  const keyRef = React.useRef(keyByPath);
  keyRef.current = keyByPath;

  const { model } = useFileTree({
    preparedInput,
    gitStatus,
    density: "compact",
    flattenEmptyDirectories: false,
    initialExpansion: "closed",
    initialExpandedPaths,
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
  const mounted = React.useRef(false);
  React.useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      for (const treePath of initialExpandedPaths) model.getItem(treePath)?.expand();
      return;
    }
    const expanded = directoryPaths(paths).filter(
      (treePath) => model.getItem(treePath)?.isExpanded() ?? false
    );
    model.resetPaths({ preparedInput, initialExpandedPaths: expanded });
  }, [model, pathsKey, preparedInput, paths, annotationCountsKey, initialExpandedPaths]);

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
          {reviewMap.title}
        </span>
        <span
          className="text-muted-foreground text-[11px] tabular-nums"
          aria-label={`${items.length} documents`}
        >
          {items.length}
        </span>
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
