import React from "react";
import { Check, MessageSquare, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import type { ItemStatus, Reply, ReviewComment, ReviewEdit } from "~/lib/types";

export type ComposerMode = "comment" | "edit";

/** What a viewer hands the keyboard: the composer, without a pointer. */
export interface ViewerHandle {
  openAt: (line: number, quote?: string, mode?: ComposerMode) => void;
  close: () => void;
}

export interface AnnotationApi {
  comments: ReviewComment[];
  edits: ReviewEdit[];
  openLine: number | null;
  openAt: (line: number, quote?: string, mode?: ComposerMode) => void;
  close: () => void;
  pendingQuote?: string;
  /** Which tab the composer opens on; the keyboard picks it, the gutter does not. */
  pendingMode?: ComposerMode;
  addComment: (input: { line: number; endLine?: number; quote?: string; feedback: string }) => void;
  addEdit: (input: {
    line: number;
    endLine?: number;
    originalText: string;
    suggestedText: string;
  }) => void;
  deleteComment: (id: string) => void;
  deleteEdit: (id: string) => void;
  updateComment: (id: string, feedback: string) => void;
  updateEdit: (id: string, suggestedText: string) => void;
  /** Old-side diff lines have nothing to patch, so they take comments only. */
  allowEdit?: boolean;
  /** Last line of a multi-line selection; the composer anchors at openLine. */
  openEndLine?: number;
  /** Shown next to the range, e.g. which side of a diff the lines belong to. */
  scopeLabel?: string;
}

export function lineLabel(start?: number, end?: number): string {
  if (start === undefined) return "General";
  return end !== undefined && end !== start ? `Lines ${start}-${end}` : `Line ${start}`;
}

export const AnnotationContext = React.createContext<AnnotationApi | null>(null);

export function useAnnotation() {
  const ctx = React.useContext(AnnotationContext);
  if (!ctx) throw new Error("AnnotationContext missing");
  return ctx;
}

/** The line owned by the nearest annotated ancestor, so a block sharing it defers. */
const OwnerLineContext = React.createContext<number | null>(null);

function Gutter({ line, offset }: { line: number; offset: string }) {
  const api = useAnnotation();
  return (
    <span data-not-typeset className="not-typeset">
      <button
        type="button"
        aria-label={`Annotate line ${line}`}
        onClick={() => api.openAt(line)}
        className={`annot-gutter bg-primary text-primary-foreground absolute top-1 ${offset} flex size-5 items-center justify-center rounded-md opacity-0 shadow-sm transition-opacity`}
      >
        <Plus className="size-3.5" />
      </button>
    </span>
  );
}

/** Existing annotations plus the composer, rendered in flow under the block. */
export function Thread({ line }: { line: number }) {
  const api = useAnnotation();
  const comments = api.comments.filter((c) => c.startLine === line);
  const edits = api.edits.filter((e) => e.startLine === line);
  const isOpen = api.openLine === line;

  if (comments.length === 0 && edits.length === 0 && !isOpen) return null;

  return (
    <div data-not-typeset className="not-typeset mt-3 flex flex-col gap-2">
      {comments.map((c) => (
        <AnnotationCard
          key={c.id}
          annotId={c.id}
          label={`Comment on ${lineLabel(c.startLine, c.endLine).toLowerCase()}`}
          quote={c.quote}
          sent={c.sent}
          status={c.status}
          replies={c.replies}
          onReply={() => api.openAt(line)}
          value={c.feedback}
          onDelete={() => api.deleteComment(c.id)}
          onSave={(next) => api.updateComment(c.id, next)}
        >
          <p className="whitespace-pre-wrap">{c.feedback}</p>
        </AnnotationCard>
      ))}

      {edits.map((e) => (
        <AnnotationCard
          key={e.id}
          annotId={e.id}
          label={`Suggested edit on ${lineLabel(e.startLine, e.endLine).toLowerCase()}`}
          sent={e.sent}
          status={e.status}
          replies={e.replies}
          onReply={() => api.openAt(line)}
          value={e.suggestedText}
          mono
          onDelete={() => api.deleteEdit(e.id)}
          onSave={(next) => api.updateEdit(e.id, next)}
        >
          {e.originalText && (
            <pre className="overflow-x-auto rounded-md bg-destructive/10 px-2 py-1 font-mono text-xs line-through">
              {e.originalText}
            </pre>
          )}
          <pre className="mt-1 overflow-x-auto rounded-md bg-emerald-500/10 px-2 py-1 font-mono text-xs">
            {e.suggestedText}
          </pre>
        </AnnotationCard>
      ))}

      {isOpen && <Composer line={line} quote={api.pendingQuote} api={api} />}
    </div>
  );
}

/**
 * GitHub-style gutter affordance: a `+` button on hover, an inline thread of existing
 * annotations, and an in-flow composer that pushes content down instead of floating.
 */
export function AnnotatedBlock({
  line,
  id,
  children,
}: {
  line?: number;
  id?: string;
  children: React.ReactNode;
}) {
  const ownerLine = React.useContext(OwnerLineContext);

  // A blockquote and its paragraph report the same start line; only the outer one owns it.
  if (!line || ownerLine === line) return <>{children}</>;

  return (
    <div data-annot id={id} data-line-start={line} className="relative">
      <Gutter line={line} offset="-left-9" />
      <OwnerLineContext.Provider value={line}>{children}</OwnerLineContext.Provider>
      <Thread line={line} />
    </div>
  );
}

/** A list item hosts its own thread — a wrapper div would be invalid inside <ul>. */
export function AnnotatedListItem({
  line,
  children,
  ...props
}: { line?: number; children: React.ReactNode } & React.ComponentProps<"li">) {
  const ownerLine = React.useContext(OwnerLineContext);

  if (!line || ownerLine === line) return <li {...props}>{children}</li>;

  return (
    <li {...props} data-annot data-line-start={line} className="relative">
      <Gutter line={line} offset="-left-7" />
      <OwnerLineContext.Provider value={line}>{children}</OwnerLineContext.Provider>
      <Thread line={line} />
    </li>
  );
}

const STATUS_STYLE: Record<ItemStatus, string> = {
  open: "",
  applied: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  skipped: "bg-muted text-muted-foreground",
  question: "bg-amber-500/15 text-amber-600 dark:text-amber-500",
};

function AnnotationCard({
  annotId,
  label,
  quote,
  sent,
  status,
  replies,
  onReply,
  value,
  mono,
  onDelete,
  onSave,
  children,
}: {
  annotId: string;
  label: string;
  quote?: string;
  sent?: boolean;
  status?: ItemStatus;
  replies?: Reply[];
  onReply?: () => void;
  value: string;
  mono?: boolean;
  onDelete: () => void;
  onSave: (next: string) => void;
  children: React.ReactNode;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);

  const save = () => {
    if (!draft.trim() || draft === value) return setEditing(false);
    onSave(draft.trim());
    setEditing(false);
  };

  const startEditing = () => {
    setDraft(value);
    setEditing(true);
  };

  return (
    <div
      data-annot-id={annotId}
      className="bg-card text-card-foreground rounded-lg border text-sm shadow-xs"
    >
      <div className="text-muted-foreground flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs">
        <span className="flex items-center gap-1.5 font-medium">
          <MessageSquare className="size-3" />
          {label}
        </span>

        {/* Once the agent holds it, the record is theirs; only unsent work is editable. */}
        {sent ? (
          <span className="flex items-center gap-1.5">
            {status && status !== "open" ? (
              <span
                className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLE[status]}`}
              >
                {status}
              </span>
            ) : (
              <>
                <Check className="size-3" />
                Sent
              </>
            )}
          </span>
        ) : (
          <span className="flex items-center">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Edit annotation"
              onClick={startEditing}
            >
              <Pencil className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Delete annotation"
              onClick={onDelete}
              className="hover:text-destructive"
            >
              <Trash2 className="size-3" />
            </Button>
          </span>
        )}
      </div>
      <div className="px-3 py-2">
        {quote && (
          <blockquote className="text-muted-foreground mb-2 border-l-2 pl-2 font-mono text-xs">
            {quote}
          </blockquote>
        )}

        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
                if (e.key === "Escape") setEditing(false);
              }}
              className={`max-h-64 min-h-20 text-sm ${mono ? "font-mono" : ""}`}
            />
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={save}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          children
        )}

        {replies?.length ? (
          <div className="mt-2 flex flex-col gap-1.5 border-t pt-2">
            {replies.map((reply, i) => (
              <p key={i} className="text-muted-foreground text-xs whitespace-pre-wrap">
                <span className="text-foreground font-medium">
                  {reply.from === "agent" ? "Agent" : "You"}:{" "}
                </span>
                {reply.text}
              </p>
            ))}
            {/* Only a question is still live; the other verdicts end the exchange. */}
            {status === "question" && onReply && (
              <Button variant="secondary" size="xs" className="self-start" onClick={onReply}>
                Reply
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Composer({ line, quote, api }: { line: number; quote?: string; api: AnnotationApi }) {
  const allowEdit = api.allowEdit !== false;
  const [mode, setMode] = React.useState<ComposerMode>(
    allowEdit && api.pendingMode === "edit" ? "edit" : "comment"
  );
  const [text, setText] = React.useState("");
  const [suggestion, setSuggestion] = React.useState(quote ?? "");
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  // autoFocus is lost when the composer mounts into a slot, and a selection drag
  // hands focus back to the document on mouseup; claiming it after the frame
  // settles is what actually leaves the caret in the box.
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [line, mode]);

  const endLine = api.openEndLine;

  const submit = () => {
    if (mode === "comment") {
      if (!text.trim()) return;
      api.addComment({ line, endLine, quote, feedback: text.trim() });
    } else {
      if (!suggestion.trim()) return;
      api.addEdit({ line, endLine, originalText: quote ?? "", suggestedText: suggestion.trim() });
    }
    api.close();
  };

  return (
    <div className="bg-card text-card-foreground rounded-lg border shadow-xs">
      <div className="flex items-center justify-between gap-2 border-b px-2 py-1.5">
        <div className="flex items-center gap-1">
          <Button
            variant={mode === "comment" ? "secondary" : "ghost"}
            size="xs"
            onClick={() => setMode("comment")}
          >
            Comment
          </Button>
          {allowEdit && (
            <Button
              variant={mode === "edit" ? "secondary" : "ghost"}
              size="xs"
              onClick={() => setMode("edit")}
            >
              Suggest edit
            </Button>
          )}
        </div>
        <Button variant="ghost" size="icon-xs" aria-label="Cancel" onClick={api.close}>
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="flex flex-col gap-2 p-2">
        {quote && (
          <blockquote className="text-muted-foreground border-l-2 pl-2 font-mono text-xs">
            {quote}
          </blockquote>
        )}

        <Textarea
          ref={inputRef}
          value={mode === "comment" ? text : suggestion}
          onChange={(e) =>
            mode === "comment" ? setText(e.target.value) : setSuggestion(e.target.value)
          }
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            if (e.key === "Escape") api.close();
          }}
          placeholder={mode === "comment" ? "Leave a comment" : "Suggested replacement"}
          className={`max-h-64 min-h-20 text-sm ${mode === "edit" ? "font-mono" : ""}`}
        />

        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-xs">
            {lineLabel(line, endLine)}
            {api.scopeLabel ? ` · ${api.scopeLabel}` : ""} · ⌘↵ to save
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={api.close}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit}>
              {mode === "comment" ? "Add comment" : "Add suggestion"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
