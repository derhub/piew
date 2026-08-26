import React from "react";
import { createPortal } from "react-dom";
import { File, FileDiff } from "@pierre/diffs/react";
import { parseDiffFromFile } from "@pierre/diffs";
import type { AnnotationSide, DiffLineAnnotation, LineAnnotation } from "@pierre/diffs";
import { BookOpen, FileCode, Rows3, SquareSplitHorizontal } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useCodeTheme } from "~/hooks/use-code-theme";
import {
  AnnotationContext,
  Thread,
  type AnnotationApi,
  type ComposerMode,
  type ViewerHandle,
} from "~/components/Annotation";
import { MarkdownViewer } from "~/components/MarkdownViewer";
import type { DiffFile, PageMeta, ReviewComment, ReviewEdit } from "~/lib/types";

type Side = "old" | "new";

export interface CodeDiffViewerProps {
  page: PageMeta;
  diff?: DiffFile;
  content?: string;
  comments: ReviewComment[];
  edits: ReviewEdit[];
  onAddComment: (input: {
    kind: ReviewComment["kind"];
    startLine?: number;
    endLine?: number;
    quote?: string;
    side?: Side;
    feedback: string;
  }) => void;
  onAddEdit: (input: {
    startLine: number;
    endLine: number;
    originalText: string;
    suggestedText: string;
  }) => void;
  onDeleteComment: (id: string) => void;
  onDeleteEdit: (id: string) => void;
  onUpdateComment: (id: string, feedback: string) => void;
  onUpdateEdit: (id: string, suggestedText: string) => void;
  onNavigateLink?: (href: string) => void;
  zoom?: number;
  /** Header node the view toggles render into, so they sit in the top nav. */
  toolbarSlot?: HTMLElement | null;
  viewerRef?: React.Ref<ViewerHandle>;
}

type View = "diff" | "file" | "preview";

const MARKDOWN_EXT = /\.(md|markdown)$/i;
const PREVIEW_KEY = "piew:markdown-preview";

/** Preferring the rendered page is a habit, not a per-file choice, so it sticks. */
function prefersPreview(): boolean {
  return localStorage.getItem(PREVIEW_KEY) === "1";
}

/** Lucide's file-diff, split so the two markers carry the diff's own colours. */
function FileDiffIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
      <path d="M9 10h6" className="text-red-500" stroke="currentColor" />
      <path d="M12 13v6" className="text-emerald-500" stroke="currentColor" />
      <path d="M9 16h6" className="text-emerald-500" stroke="currentColor" />
    </svg>
  );
}

const TO_PIERRE: Record<Side, AnnotationSide> = { old: "deletions", new: "additions" };
const FROM_PIERRE = (side: AnnotationSide | undefined): Side =>
  side === "deletions" ? "old" : "new";

export function CodeDiffViewer({
  page,
  diff,
  content,
  comments,
  edits,
  onAddComment,
  onAddEdit,
  onDeleteComment,
  onDeleteEdit,
  onUpdateComment,
  onUpdateEdit,
  onNavigateLink,
  zoom,
  toolbarSlot,
  viewerRef,
}: CodeDiffViewerProps) {
  const { themes: theme } = useCodeTheme();
  const [split, setSplit] = React.useState(false);
  const [open, setOpen] = React.useState<{
    line: number;
    endLine: number;
    side: Side;
    mode?: ComposerMode;
  } | null>(null);

  const isMarkdown = MARKDOWN_EXT.test(page.filename);
  const [view, setView] = React.useState<View>(() =>
    isMarkdown && prefersPreview() ? "preview" : "diff"
  );

  // Opening another file starts from the remembered habit, not from whatever the
  // last file happened to be showing.
  React.useEffect(() => {
    setView(isMarkdown && prefersPreview() ? "preview" : "diff");
  }, [page.id, isMarkdown]);

  const setPreview = (on: boolean) => {
    localStorage.setItem(PREVIEW_KEY, on ? "1" : "0");
    setView(on ? "preview" : "diff");
  };

  const wholeFile = view !== "diff";
  const isDiff = !!diff && view === "diff";

  // A side that exists but has no content is binary: git stores no flag for it,
  // and rendering the bytes as text produces pages of replacement characters.
  const isBinary =
    !!diff &&
    ((!!diff.oldPath && diff.oldContent === undefined) ||
      (!!diff.newPath && diff.newContent === undefined));

  const fileDiff = React.useMemo(() => {
    if (!diff || isBinary || wholeFile) return null;
    const oldFile = diff.oldPath ? { name: diff.oldPath, contents: diff.oldContent ?? "" } : null;
    const newFile = diff.newPath ? { name: diff.newPath, contents: diff.newContent ?? "" } : null;
    return parseDiffFromFile(oldFile, newFile);
  }, [diff, isBinary, wholeFile]);

  // Whole-file view of a diff page shows the post-image, so line numbers stay the
  // ones a new-side annotation already anchors to. A deleted file has only the
  // pre-image, and its annotations stay old-side.
  const fileView = React.useMemo(() => {
    if (diff) {
      const showsNew = !!diff.newPath;
      return {
        name: (showsNew ? diff.newPath : diff.oldPath) ?? page.filename,
        contents: (showsNew ? diff.newContent : diff.oldContent) ?? "",
      };
    }
    return { name: page.filename, contents: content ?? "" };
  }, [diff, content, page.filename]);

  // The side a single-column view is showing. Whole-file view of a diff renders
  // the post-image, so its lines are new-side ones.
  const viewSide: Side = diff && !diff.newPath ? "old" : "new";

  const sideOf = React.useCallback(
    (c: ReviewComment): Side => (diff ? (c.side === "old" ? "old" : "new") : "new"),
    [diff]
  );

  const [selectionQuote, setSelectionQuote] = React.useState<string | undefined>();
  const containerRef = React.useRef<HTMLDivElement>(null);

  const close = React.useCallback(() => {
    setOpen(null);
    setSelectionQuote(undefined);
  }, []);

  // Preview mode hands the page to the Markdown viewer, so the keyboard has to
  // reach that composer rather than the one behind it.
  const previewRef = React.useRef<ViewerHandle>(null);

  React.useImperativeHandle(
    viewerRef,
    () => ({
      openAt: (line, quote, mode) => {
        if (view === "preview") return previewRef.current?.openAt(line, quote, mode);
        setSelectionQuote(quote);
        setOpen({ line, endLine: line, side: viewSide, mode });
      },
      close: () => {
        previewRef.current?.close();
        close();
      },
    }),
    [view, viewSide, close]
  );

  // A drag can run bottom-to-top, and its two ends can sit on opposite sides of a
  // split diff; the composer anchors on the first line of one side either way.
  const openFor = React.useCallback(
    (range: { start: number; end?: number; side?: AnnotationSide }) => {
      const end = range.end ?? range.start;
      setSelectionQuote(undefined);
      setOpen({
        line: Math.min(range.start, end),
        endLine: Math.max(range.start, end),
        side: isDiff ? FROM_PIERRE(range.side) : viewSide,
      });
    },
    [isDiff, viewSide]
  );

  // Highlighting code opens the composer straight away, the way selecting prose
  // does in the Markdown viewer. The rendered lines live in a shadow root, so the
  // selection has to be read from there rather than from the document.
  const handleSelection = React.useCallback(() => {
    const host = containerRef.current?.querySelector<
      HTMLElement & { shadowRoot: ShadowRoot | null }
    >("diffs-container");
    const shadow = host?.shadowRoot as (ShadowRoot & { getSelection?: () => Selection }) | null;
    const selection = shadow?.getSelection?.() ?? document.getSelection();
    if (!selection || selection.isCollapsed) return;

    const quote = selection.toString();
    if (!quote.trim()) return;

    const rowOf = (node: Node | null) => {
      const el = node instanceof Element ? node : node?.parentElement;
      return el?.closest<HTMLElement>("[data-line]") ?? null;
    };

    const startRow = rowOf(selection.anchorNode);
    const endRow = rowOf(selection.focusNode) ?? startRow;
    if (!startRow || !endRow) return;

    const a = Number(startRow.dataset.line);
    const b = Number(endRow.dataset.line);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;

    const side: Side = isDiff
      ? startRow.dataset.lineType?.includes("deletion")
        ? "old"
        : "new"
      : viewSide;

    setSelectionQuote(quote);
    setOpen({ line: Math.min(a, b), endLine: Math.max(a, b), side });
  }, [isDiff, viewSide]);

  // The lines under the selection, so a suggested edit starts from the real text
  // instead of an empty box the reviewer has to retype.
  const pendingQuote = React.useMemo(() => {
    if (!open) return undefined;
    if (selectionQuote) return selectionQuote;
    const source = diff ? (open.side === "old" ? diff.oldContent : diff.newContent) : content;
    if (!source) return undefined;
    return (
      source
        .split("\n")
        .slice(open.line - 1, open.endLine)
        .join("\n") || undefined
    );
  }, [open, selectionQuote, diff, content]);

  // One API per side: an old-side line can be discussed but never patched.
  const apiFor = React.useCallback(
    (side: Side): AnnotationApi => ({
      comments: comments.filter((c) => sideOf(c) === side),
      edits: side === "new" ? edits : [],
      openLine: open?.side === side ? open.line : null,
      openEndLine: open?.side === side ? open.endLine : undefined,
      pendingQuote: open?.side === side ? pendingQuote : undefined,
      pendingMode: open?.side === side ? open.mode : undefined,
      scopeLabel: diff ? (side === "old" ? "old side" : "new side") : undefined,
      openAt: (line, _quote, mode) => setOpen({ line, endLine: line, side, mode }),
      close,
      addComment: ({ line, endLine, quote, feedback }) =>
        onAddComment({
          kind: quote ? "selection" : "line_range",
          startLine: line,
          endLine: endLine ?? line,
          quote,
          side: diff ? side : undefined,
          feedback,
        }),
      addEdit: ({ line, endLine, originalText, suggestedText }) =>
        onAddEdit({ startLine: line, endLine: endLine ?? line, originalText, suggestedText }),
      deleteComment: onDeleteComment,
      deleteEdit: onDeleteEdit,
      updateComment: onUpdateComment,
      updateEdit: onUpdateEdit,
      allowEdit: side === "new",
    }),
    [
      comments,
      edits,
      open,
      pendingQuote,
      close,
      sideOf,
      diff,
      onAddComment,
      onAddEdit,
      onDeleteComment,
      onDeleteEdit,
      onUpdateComment,
      onUpdateEdit,
    ]
  );

  // Pierre renders an annotation slot only for lines it is told about, so the
  // open composer's line has to join the annotated ones.
  const annotatedLines = React.useMemo(() => {
    const lines = new Map<string, { line: number; side: Side }>();
    for (const c of comments) {
      if (c.startLine === undefined) continue;
      const side = sideOf(c);
      lines.set(`${side}:${c.startLine}`, { line: c.startLine, side });
    }
    for (const e of edits) lines.set(`new:${e.startLine}`, { line: e.startLine, side: "new" });
    if (open) lines.set(`${open.side}:${open.line}`, { line: open.line, side: open.side });
    return [...lines.values()];
  }, [comments, edits, open, sideOf]);

  const diffAnnotations = React.useMemo<DiffLineAnnotation[]>(
    () => annotatedLines.map(({ line, side }) => ({ side: TO_PIERRE[side], lineNumber: line })),
    [annotatedLines]
  );

  // A single-column view shows one side, so the other side's anchors would land
  // on unrelated lines and must stay hidden until the diff is back.
  const fileAnnotations = React.useMemo<LineAnnotation[]>(
    () =>
      annotatedLines
        .filter(({ side }) => !diff || side === viewSide)
        .map(({ line }) => ({ lineNumber: line })),
    [annotatedLines, diff, viewSide]
  );

  const renderAnnotation = React.useCallback(
    (annotation: { lineNumber: number; side?: AnnotationSide }) => (
      <AnnotationContext.Provider value={apiFor(isDiff ? FROM_PIERRE(annotation.side) : viewSide)}>
        <div className="max-w-3xl px-3 py-2">
          <Thread line={annotation.lineNumber} />
        </div>
      </AnnotationContext.Provider>
    ),
    [apiFor, isDiff, viewSide]
  );

  // Pierre owns the hover affordance; without enableGutterUtility no gutter slot
  // is ever created and a custom button renders into nothing. Line selection is
  // what turns a drag across the gutter into a range instead of a single line.
  const interaction = React.useMemo(
    () => ({
      enableGutterUtility: true,
      enableLineSelection: true,
      onGutterUtilityClick: (range: { start: number; end?: number; side?: AnnotationSide }) =>
        openFor(range),
      onLineSelectionEnd: (
        range: { start: number; end?: number; side?: AnnotationSide } | null
      ) => {
        if (range) openFor(range);
      },
    }),
    [openFor]
  );

  const selectedLines = React.useMemo(
    () =>
      open
        ? {
            start: open.line,
            end: open.endLine,
            ...(isDiff ? { side: TO_PIERRE[open.side], endSide: TO_PIERRE[open.side] } : {}),
          }
        : null,
    [open, isDiff]
  );

  if (!diff && content === undefined) {
    return <div className="text-muted-foreground p-8 text-sm">Loading {page.filename}...</div>;
  }

  if (isBinary) {
    return (
      <div className="text-muted-foreground p-8 text-sm">
        Binary file not shown ({page.status ?? "modified"}).
      </div>
    );
  }

  const toolbar = !!diff && !isBinary && (
    <div className="flex items-center gap-0.5">
      {isMarkdown && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-pressed={view === "preview"}
          aria-label={view === "preview" ? "Show the changes" : "Preview the rendered page"}
          title={view === "preview" ? "Show the changes" : "Preview the rendered page"}
          onClick={() => setPreview(view !== "preview")}
        >
          {view === "preview" ? (
            <FileDiffIcon className="size-4" />
          ) : (
            <BookOpen className="size-4" />
          )}
        </Button>
      )}

      {view !== "preview" && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-pressed={wholeFile}
          aria-label={wholeFile ? "Show only the changes" : "Show the whole file"}
          title={wholeFile ? "Show only the changes" : "Show the whole file"}
          onClick={() => setView(wholeFile ? "diff" : "file")}
        >
          {wholeFile ? <FileDiffIcon className="size-4" /> : <FileCode className="size-4" />}
        </Button>
      )}

      {!wholeFile && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-pressed={split}
          aria-label={split ? "Show one column" : "Show both sides"}
          title={split ? "Show one column" : "Show both sides"}
          onClick={() => setSplit((s) => !s)}
        >
          {split ? <Rows3 className="size-4" /> : <SquareSplitHorizontal className="size-4" />}
        </Button>
      )}
    </div>
  );

  return (
    <div ref={containerRef} className="flex flex-col gap-2" onMouseUp={handleSelection}>
      {toolbarSlot && toolbar
        ? createPortal(toolbar, toolbarSlot)
        : toolbar && <div className="flex justify-end">{toolbar}</div>}

      {view === "preview" ? (
        <MarkdownViewer
          content={fileView.contents}
          comments={comments.filter((c) => sideOf(c) === viewSide)}
          edits={viewSide === "new" ? edits : []}
          onAddComment={(c) => onAddComment({ ...c, side: diff ? viewSide : undefined })}
          onAddEdit={onAddEdit}
          onDeleteComment={onDeleteComment}
          onDeleteEdit={onDeleteEdit}
          onUpdateComment={onUpdateComment}
          onUpdateEdit={onUpdateEdit}
          onNavigateLink={onNavigateLink}
          zoom={zoom}
          viewerRef={previewRef}
        />
      ) : fileDiff ? (
        <FileDiff
          fileDiff={fileDiff}
          options={{ theme, diffStyle: split ? "split" : "unified", ...interaction }}
          lineAnnotations={diffAnnotations}
          selectedLines={selectedLines}
          renderAnnotation={renderAnnotation}
        />
      ) : (
        <File
          file={fileView}
          options={{ theme, ...interaction }}
          lineAnnotations={fileAnnotations}
          selectedLines={selectedLines}
          renderAnnotation={renderAnnotation}
        />
      )}
    </div>
  );
}
