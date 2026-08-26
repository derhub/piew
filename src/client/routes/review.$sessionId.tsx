import React from "react";
import { createRoute } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root";
import { DocumentSidebar } from "~/components/DocumentSidebar";
import { TableOfContents } from "~/components/TableOfContents";
import { MarkdownViewer } from "~/components/MarkdownViewer";
import { FeedbackChat } from "~/components/FeedbackChat";
import { Button } from "~/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "~/components/ui/resizable";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { PanelLeft } from "lucide-react";
import { useDocZoom } from "~/hooks/use-doc-zoom";
import { ActionBar } from "~/components/ActionBar";
import { CodeDiffViewer } from "~/components/CodeDiffViewer";
import { ShortcutSheet } from "~/components/ShortcutSheet";
import { FindBar } from "~/components/FindBar";
import { useHotkeys } from "~/hooks/use-hotkeys";
import type { ViewerHandle } from "~/components/Annotation";
import type { DiffFile, FeedbackTurn, PageMeta, ReviewMap } from "~/lib/types";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/review/$sessionId",
  component: ReviewSessionComponent,
});

interface SessionState {
  id: string;
  activePageId: string;
  reviewMap: ReviewMap;
  agentState: "idle" | "listening" | "working" | "stranded";
  pages: Record<string, PageMeta>;
  turns: FeedbackTurn[];
}

// Panel widths are a per-machine preference, so they live where the machine keeps
// them, and a phone keeps its own: collapsing both panels there must not follow the
// review back to a desktop.
const LAYOUT_KEY = "piew:review-layout";
const layoutKey = () => (isNarrow() ? `${LAYOUT_KEY}:narrow` : LAYOUT_KEY);

function savedLayout(): Record<string, number> | undefined {
  try {
    const raw = localStorage.getItem(layoutKey());
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

interface PageContent {
  kind: PageMeta["kind"];
  content?: string;
  diff?: DiffFile;
  hash: string;
}

/**
 * Where a diff or file page renders the given line. Markdown anchors a block per
 * source line; Pierre renders its rows inside the shadow root of `diffs-container`,
 * out of reach of a document query.
 */
function lineElement(line: number, side?: "old" | "new"): Element | null {
  const block = document.querySelector(`[data-annot][data-line-start="${line}"]`);
  if (block) return block;

  // Markdown anchors only the first line of each block, so a line inside a
  // paragraph resolves to the block that contains it rather than to nothing.
  const blocks = [...document.querySelectorAll<HTMLElement>("[data-annot][data-line-start]")];
  const owner = blocks.filter((el) => Number(el.dataset.lineStart) <= line).at(-1);
  if (owner) return owner;

  const host = document.querySelector("diffs-container");
  const rows = [
    ...(host?.shadowRoot?.querySelectorAll<HTMLElement>(`[data-line="${line}"]`) ?? []),
  ];
  if (rows.length === 0) return null;
  if (!side) return rows[0];

  // A split diff shows the same line number on both sides.
  const deleted = (row: HTMLElement) => !!row.dataset.lineType?.includes("deletion");
  return rows.find((row) => (side === "old" ? deleted(row) : !deleted(row))) ?? rows[0];
}

/** Height of the sticky header, so "in view" means under it rather than behind it. */
const HEADER_PX = 48;

/**
 * The line the reader is looking at: the first anchor below the header, falling
 * back to the last one above it when the page is scrolled past its final block.
 */
function visibleLine(): number | null {
  const host = document.querySelector("diffs-container");
  const anchors = [
    ...document.querySelectorAll<HTMLElement>("[data-annot][data-line-start]"),
    ...(host?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? []),
  ];

  let last: number | null = null;
  for (const el of anchors) {
    const line = Number(el.dataset.lineStart ?? el.dataset.line);
    if (!Number.isFinite(line)) continue;
    if (el.getBoundingClientRect().top >= HEADER_PX) return line;
    last = line;
  }
  return last;
}

/**
 * Show or hide a panel. `expand()` restores the most recent size, which after a
 * `collapse()` is the collapsed one, so a panel put away never came back; the
 * width is handed back explicitly when that happens.
 */
function setPanelOpen(
  ref: React.RefObject<PanelImperativeHandle | null>,
  open: boolean,
  size: string
) {
  const panel = ref.current;
  if (!panel) return;
  if (!open) return panel.collapse();
  panel.expand();
  if (panel.isCollapsed()) panel.resize(size);
}

/** Below this the panels overlay the document instead of splitting it. A window
    still reporting zero width is mid-layout, not a phone. */
const isNarrow = () =>
  typeof window !== "undefined" && window.innerWidth > 0 && window.innerWidth < 768;

function ReviewSessionComponent() {
  const { sessionId } = Route.useParams();
  const [session, setSession] = React.useState<SessionState | null>(null);
  const [activeKey, setActiveKey] = React.useState<string>("");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const feedbackRef = React.useRef<PanelImperativeHandle | null>(null);
  const [feedbackCollapsed, setFeedbackCollapsed] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [findOpen, setFindOpen] = React.useState(false);
  // On a phone a panel is an overlay, not a column, so its open state is ours to
  // hold: the group keeps both collapsed and never gives the document back its width.
  const [overlay, setOverlay] = React.useState<"explorer" | "feedback" | null>(null);
  const viewerRef = React.useRef<ViewerHandle>(null);
  // Where j and k are in the annotation list; -1 so the first j lands on the first.
  const cursorRef = React.useRef(-1);
  const { zoom, zoomIn, zoomOut, reset: resetZoom } = useDocZoom();

  const loadSession = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/session/${sessionId}`);
      if (!res.ok) throw new Error(`Failed to load session: ${res.statusText}`);
      const data: SessionState = await res.json();
      setSession(data);
      setActiveKey((prev) =>
        prev && data.pages[prev] ? prev : data.activePageId || data.reviewMap.items[0]?.pageId || ""
      );
      setLoading(false);
    } catch (err: any) {
      setError(err.message || "Failed to load session");
      setLoading(false);
    }
  }, [sessionId]);

  const [contents, setContents] = React.useState<Record<string, PageContent>>({});

  // Content is fetched per page on open, so the session payload stays flat no
  // matter how many files the range touches.
  const loadContent = React.useCallback(
    async (key: string) => {
      const res = await fetch(`/api/session/${sessionId}/page/${key}`);
      if (!res.ok) return;
      const body: PageContent = await res.json();
      setContents((prev) => ({ ...prev, [key]: body }));
    },
    [sessionId]
  );

  React.useEffect(() => {
    if (activeKey) void loadContent(activeKey);
  }, [activeKey, loadContent]);

  React.useEffect(() => {
    loadSession();

    const eventSource = new EventSource(`/events?session=${sessionId}`);
    const refresh = () => void loadSession();
    eventSource.addEventListener("refresh", refresh);
    eventSource.addEventListener("stale", refresh);
    eventSource.addEventListener("reload", (event) => {
      try {
        const { pageId } = JSON.parse((event as MessageEvent).data);
        if (pageId) void loadContent(pageId);
      } catch {
        /* malformed frame */
      }
      refresh();
    });
    eventSource.addEventListener("agent", (event) => {
      try {
        const { state } = JSON.parse((event as MessageEvent).data);
        setSession((prev) => (prev ? { ...prev, agentState: state } : prev));
      } catch {
        /* malformed frame */
      }
    });

    return () => eventSource.close();
  }, [sessionId, loadSession, loadContent]);

  const activePage = session?.pages[activeKey];
  const activeContent = contents[activeKey];
  const activeMapPath = session?.reviewMap.items.find((item) => item.pageId === activeKey)?.path;
  const explorerRef = React.useRef<PanelImperativeHandle | null>(null);
  const [explorerCollapsed, setExplorerCollapsed] = React.useState(false);
  const [toolbarSlot, setToolbarSlot] = React.useState<HTMLDivElement | null>(null);

  // A phone opens on the document alone; the panels are there behind their toggles.
  // The group applies its saved layout after mount, so this has to land after it.
  React.useEffect(() => {
    if (!isNarrow()) return;
    // The group restores its own layout in a later effect, so this waits it out.
    const id = setTimeout(() => {
      explorerRef.current?.collapse();
      feedbackRef.current?.collapse();
    }, 150);
    return () => clearTimeout(id);
  }, []);

  const handleRefreshPage = React.useCallback(async () => {
    if (!activeKey) return;
    if (!window.confirm("Re-running this diff drops the annotations on it. Continue?")) return;
    const res = await fetch(`/api/session/${sessionId}/page/${activeKey}/refresh`, {
      method: "POST",
    });
    if (res.ok) await loadContent(activeKey);
  }, [activeKey, loadContent, sessionId]);

  // Opening another document should start at its top, not inherit the last scroll offset.
  const selectPage = React.useCallback((key: string) => {
    setActiveKey(key);
    setOverlay(null);
    window.scrollTo({ top: 0 });
  }, []);

  const call = React.useCallback(
    async (path: string, init: RequestInit) => {
      const res = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      if (res.ok) await loadSession();
      return res;
    },
    [loadSession]
  );

  const handleAddComment = React.useCallback(
    (comment: Parameters<React.ComponentProps<typeof MarkdownViewer>["onAddComment"]>[0]) => {
      if (!activeKey) return;
      void call(`/api/session/${sessionId}/page/${activeKey}/comment`, {
        method: "POST",
        body: JSON.stringify(comment),
      });
    },
    [activeKey, call, sessionId]
  );

  const handleAddEdit = React.useCallback(
    (edit: Parameters<React.ComponentProps<typeof MarkdownViewer>["onAddEdit"]>[0]) => {
      if (!activeKey) return;
      void call(`/api/session/${sessionId}/page/${activeKey}/edit`, {
        method: "POST",
        body: JSON.stringify(edit),
      });
    },
    [activeKey, call, sessionId]
  );

  const deleteComment = React.useCallback(
    (pageId: string, commentId: string) => {
      void call(`/api/session/${sessionId}/page/${pageId}/comment/${commentId}`, {
        method: "DELETE",
      });
    },
    [call, sessionId]
  );

  const deleteEdit = React.useCallback(
    (pageId: string, editId: string) => {
      void call(`/api/session/${sessionId}/page/${pageId}/edit/${editId}`, {
        method: "DELETE",
      });
    },
    [call, sessionId]
  );

  const updateComment = React.useCallback(
    (pageId: string, commentId: string, feedback: string) => {
      void call(`/api/session/${sessionId}/page/${pageId}/comment/${commentId}`, {
        method: "PATCH",
        body: JSON.stringify({ feedback }),
      });
    },
    [call, sessionId]
  );

  const updateEdit = React.useCallback(
    (pageId: string, editId: string, suggestedText: string) => {
      void call(`/api/session/${sessionId}/page/${pageId}/edit/${editId}`, {
        method: "PATCH",
        body: JSON.stringify({ suggestedText }),
      });
    },
    [call, sessionId]
  );

  const handleUpdateComment = React.useCallback(
    (id: string, feedback: string) => updateComment(activeKey, id, feedback),
    [updateComment, activeKey]
  );

  const handleUpdateEdit = React.useCallback(
    (id: string, suggestedText: string) => updateEdit(activeKey, id, suggestedText),
    [updateEdit, activeKey]
  );

  const handleDeleteComment = React.useCallback(
    (id: string) => deleteComment(activeKey, id),
    [deleteComment, activeKey]
  );

  const handleDeleteEdit = React.useCallback(
    (id: string) => deleteEdit(activeKey, id),
    [deleteEdit, activeKey]
  );

  const handleJump = React.useCallback(
    (pageId: string, line?: number, side?: "old" | "new", annotId?: string) => {
      if (!session?.pages[pageId]) return;
      setActiveKey(pageId);
      if (!line && !annotId) return;

      // Jumping to another page fetches its content first, so nothing to scroll to
      // exists for several frames. The card lags its line by another few, since the
      // viewer has to render the slot that hosts it — hold out for the card, then
      // settle for the line it annotates.
      // ponytail: a frame budget, not a load event; the viewers do not publish one.
      // Timer, not requestAnimationFrame: a background tab never paints, and a
      // jump queued there has to land as soon as the page is looked at again.
      let frames = 0;
      const find = () => {
        const card = annotId && document.querySelector(`[data-annot-id="${annotId}"]`);
        // A jump with no card to wait for resolves at once; one that has an id
        // holds out for the card, because a viewer renders its slot late.
        const target = card || (line && (!annotId || frames > 60) ? lineElement(line, side) : null);
        if (!target) {
          if (frames++ < 120) setTimeout(find, 16);
          return;
        }
        // Smooth scrolling is inert in a hidden tab, so a queued jump lands flat.
        target.scrollIntoView({ behavior: document.hidden ? "auto" : "smooth", block: "center" });
        target.setAttribute("data-annot-focus", "");
        setTimeout(() => target.removeAttribute("data-annot-focus"), 1600);
      };
      setTimeout(find, 16);
    },
    [session]
  );

  const handleSendFeedback = React.useCallback(
    async (note?: string) => {
      await call(`/api/session/${sessionId}/send`, {
        method: "POST",
        body: JSON.stringify({ overallNote: note }),
      });
    },
    [call, sessionId]
  );

  const handleNavigateLink = React.useCallback(
    (href: string) => {
      const target = session?.reviewMap.items.find((item) => {
        const page = session.pages[item.pageId];
        return page?.filename === href || page?.file.endsWith(href);
      });
      if (target) selectPage(target.pageId);
    },
    [session, selectPage]
  );

  // Annotations in reading order, so j and k walk the page the way the eye does.
  const anchors = React.useMemo(() => {
    const page = session?.pages[activeKey];
    if (!page) return [] as Array<{ id: string; line?: number; side?: "old" | "new" }>;
    return [
      ...page.comments
        .filter((c) => !c.orphaned)
        .map((c) => ({ id: c.id, line: c.startLine, side: c.side })),
      ...page.edits
        .filter((e) => !e.orphaned)
        .map((e) => ({ id: e.id, line: e.startLine, side: e.side })),
    ].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  }, [session, activeKey]);

  const stepAnchor = React.useCallback(
    (delta: 1 | -1) => {
      if (anchors.length === 0) return;
      const next =
        cursorRef.current < 0
          ? delta === 1
            ? 0
            : anchors.length - 1
          : (cursorRef.current + delta + anchors.length) % anchors.length;
      cursorRef.current = next;
      const anchor = anchors[next];
      handleJump(activeKey, anchor.line, anchor.side, anchor.id);
    },
    [anchors, activeKey, handleJump]
  );

  const stepFile = React.useCallback(
    (delta: 1 | -1) => {
      const keys = session?.reviewMap.items.map((item) => item.pageId) ?? [];
      if (keys.length < 2) return;
      const at = Math.max(0, keys.indexOf(activeKey));
      cursorRef.current = -1;
      selectPage(keys[(at + delta + keys.length) % keys.length]);
    },
    [session, activeKey, selectPage]
  );

  // The one item the agent is blocked on, wherever it is in the session.
  const openQuestion = React.useMemo(() => {
    for (const { pageId: key } of session?.reviewMap.items ?? []) {
      const page = session?.pages[key];
      const item = [...(page?.comments ?? []), ...(page?.edits ?? [])].find(
        (entry) => entry.status === "question" && !entry.orphaned
      );
      if (item) return { pageId: key, line: item.startLine, id: item.id };
    }
    return null;
  }, [session]);

  const answerQuestion = React.useCallback(() => {
    if (!openQuestion) return false;
    handleJump(openQuestion.pageId, openQuestion.line, undefined, openQuestion.id);
    if (openQuestion.line) {
      setTimeout(() => viewerRef.current?.openAt(openQuestion.line!, undefined, "comment"), 400);
    }
  }, [openQuestion, handleJump]);

  const toggleFeedback = React.useCallback(() => {
    if (isNarrow()) return setOverlay((open) => (open === "feedback" ? null : "feedback"));
    setPanelOpen(feedbackRef, feedbackCollapsed, "26%");
  }, [feedbackCollapsed]);

  const toggleExplorer = React.useCallback(() => {
    if (isNarrow()) return setOverlay((open) => (open === "explorer" ? null : "explorer"));
    setPanelOpen(explorerRef, explorerCollapsed, "18%");
  }, [explorerCollapsed]);

  const compose = React.useCallback((mode: "comment" | "edit") => {
    const line = visibleLine();
    if (line !== null) viewerRef.current?.openAt(line, undefined, mode);
  }, []);

  // What find searches: the source the annotations anchor to, not the rendered prose.
  const findSource =
    activeContent?.content ??
    activeContent?.diff?.newContent ??
    activeContent?.diff?.oldContent ??
    "";

  useHotkeys({
    "/": () => setFindOpen(true),
    j: () => stepAnchor(1),
    k: () => stepAnchor(-1),
    "]": () => stepFile(1),
    "[": () => stepFile(-1),
    c: () => compose("comment"),
    e: () => compose("edit"),
    f: toggleFeedback,
    r: answerQuestion,
    "?": () => setShortcutsOpen((open) => !open),
    Escape: () => {
      // Nothing of ours open means Escape belongs to whatever else is listening.
      if (!shortcutsOpen && !findOpen) {
        viewerRef.current?.close();
        return false;
      }
      setShortcutsOpen(false);
      setFindOpen(false);
    },
    "mod+Enter": () => void handleSendFeedback(),
  });

  if (loading) {
    return (
      <div className="text-muted-foreground flex min-h-screen items-center justify-center p-8 text-sm">
        Loading review session...
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-8 text-center">
        <p className="text-destructive text-sm font-medium">{error || "Session not found"}</p>
        <p className="text-muted-foreground mt-1 text-sm">
          Start a new session from your terminal.
        </p>
      </div>
    );
  }

  const allPages = Object.values(session.pages);
  const unsentCount = allPages.reduce(
    (acc, p) =>
      acc + p.comments.filter((c) => !c.sent).length + p.edits.filter((e) => !e.sent).length,
    0
  );

  return (
    <ResizablePanelGroup
      id="review"
      className="relative h-screen"
      defaultLayout={savedLayout()}
      onLayoutChanged={(layout) => {
        try {
          localStorage.setItem(layoutKey(), JSON.stringify(layout));
        } catch {
          /* private mode or a full quota is not worth failing a resize over */
        }
      }}
    >
      {/* Below the split point the side panels stop taking width from the document
          and slide over it instead; three columns in 375px is one letter per line. */}
      <ResizablePanel
        id="explorer"
        panelRef={explorerRef}
        defaultSize={isNarrow() ? "0%" : "18%"}
        minSize="12%"
        maxSize="40%"
        collapsible
        collapsedSize={0}
        onResize={(size) => setExplorerCollapsed(size.inPixels === 0)}
        className={`bg-background piew-panel piew-panel-start h-full min-w-0 overflow-hidden ${
          overlay === "explorer" ? "" : "piew-panel-away"
        }`}
      >
        <DocumentSidebar
          key={sessionId}
          pages={session.pages}
          reviewMap={session.reviewMap}
          activePageId={activeKey}
          onSelectPage={selectPage}
        />
      </ResizablePanel>

      <ResizableHandle className="hover:bg-primary/40 data-[separator]:transition-colors" />

      <ResizablePanel id="content" className="flex min-w-0 flex-col overflow-y-auto">
        <header className="bg-background sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              (isNarrow() ? overlay !== "explorer" : explorerCollapsed)
                ? "Show explorer"
                : "Hide explorer"
            }
            onClick={toggleExplorer}
          >
            <PanelLeft />
          </Button>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium">{activePage?.filename}</div>
            <div className="text-muted-foreground truncate text-[11px]" title={activeMapPath}>
              {activeMapPath}
            </div>
          </div>

          {activePage?.stale && (
            <Button variant="outline" size="sm" onClick={handleRefreshPage}>
              Out of date - refresh
            </Button>
          )}

          {/* The viewer portals its view toggles here, so they live in the top nav. */}
          <div ref={setToolbarSlot} className="ml-1 flex items-center gap-0.5 empty:hidden" />
        </header>

        {findOpen && (
          <FindBar
            source={findSource}
            onJump={(line) => handleJump(activeKey, line)}
            onClose={() => setFindOpen(false)}
          />
        )}

        <div className="flex flex-1 items-start">
          {/* Scroll past the end: the last lines clear the floating action bar,
              and any line can be brought to the middle of the viewport. */}
          <main className="min-w-0 flex-1 pb-[60vh]">
            {activePage && activePage.kind !== "markdown" ? (
              <CodeDiffViewer
                page={activePage}
                diff={activeContent?.diff}
                content={activeContent?.content}
                comments={activePage.comments}
                edits={activePage.edits}
                onAddComment={handleAddComment}
                onAddEdit={handleAddEdit}
                onDeleteComment={handleDeleteComment}
                onDeleteEdit={handleDeleteEdit}
                onUpdateComment={handleUpdateComment}
                onUpdateEdit={handleUpdateEdit}
                onNavigateLink={handleNavigateLink}
                zoom={zoom}
                toolbarSlot={toolbarSlot}
                viewerRef={viewerRef}
              />
            ) : activePage ? (
              <MarkdownViewer
                content={activeContent?.content ?? ""}
                comments={activePage.comments}
                edits={activePage.edits}
                onAddComment={handleAddComment}
                onAddEdit={handleAddEdit}
                onDeleteComment={handleDeleteComment}
                onDeleteEdit={handleDeleteEdit}
                onUpdateComment={handleUpdateComment}
                onUpdateEdit={handleUpdateEdit}
                onNavigateLink={handleNavigateLink}
                zoom={zoom}
                viewerRef={viewerRef}
              />
            ) : (
              <div className="text-muted-foreground flex h-full items-center justify-center p-12 text-sm">
                Select a document from the sidebar.
              </div>
            )}
          </main>

          {activePage?.kind === "markdown" && (
            <TableOfContents key={activeKey} markdown={activeContent?.content ?? ""} />
          )}
        </div>

        <ActionBar
          agentState={session.agentState}
          count={unsentCount}
          zoom={zoom}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onResetZoom={resetZoom}
          feedbackHidden={isNarrow() ? overlay !== "feedback" : feedbackCollapsed}
          onToggleFeedback={toggleFeedback}
          onSend={() => handleSendFeedback()}
        />
      </ResizablePanel>

      <ResizableHandle className="hover:bg-primary/40 data-[separator]:transition-colors" />

      <ResizablePanel
        id="feedback"
        panelRef={feedbackRef}
        defaultSize={isNarrow() ? "0%" : "26%"}
        minSize="18%"
        maxSize="45%"
        collapsible
        collapsedSize={0}
        onResize={(size) => setFeedbackCollapsed(size.inPixels === 0)}
        className={`bg-background piew-panel piew-panel-end h-full min-w-0 overflow-hidden ${
          overlay === "feedback" ? "" : "piew-panel-away"
        }`}
      >
        {/* Mounted with the panel: the transcript scroller measures its opening
            position once, and a collapsed panel has no layout to measure. */}
        {(!feedbackCollapsed || overlay === "feedback") && (
          <FeedbackChat
            pages={session.pages}
            turns={session.turns ?? []}
            agentState={session.agentState}
            onCollapse={() =>
              isNarrow() ? setOverlay(null) : setPanelOpen(feedbackRef, false, "26%")
            }
            onJump={handleJump}
            onDeleteComment={deleteComment}
            onDeleteEdit={deleteEdit}
            onSendFeedback={handleSendFeedback}
          />
        )}
      </ResizablePanel>

      {shortcutsOpen && <ShortcutSheet onClose={() => setShortcutsOpen(false)} />}
    </ResizablePanelGroup>
  );
}
