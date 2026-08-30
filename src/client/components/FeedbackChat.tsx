import React from "react";
import {
  Bot,
  CheckCircle2,
  Clock,
  Edit3,
  MessageSquare,
  PanelRight,
  Send,
  Trash2,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Bubble, BubbleContent, BubbleGroup } from "~/components/ui/bubble";
import { Message, MessageContent, MessageFooter, MessageHeader } from "~/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "~/components/ui/message-scroller";
import { AgentStatus, type AgentState } from "~/components/AgentStatus";
import { ToolFrame, type ToolAction } from "~/components/ToolFrame";
import type {
  AnnotationFeedbackTurnItem,
  FeedbackTurn,
  FeedbackTurnItem,
  PageMeta,
  ToolInteraction,
} from "~/lib/types";

// The item default defers off-screen layout to a 10rem placeholder, which makes the
// scroller open at a fake end. A review ledger is tens of turns, so measure them all.
// ponytail: drop this if transcripts ever grow long enough for the deferral to pay off.
const ITEM = "[content-visibility:visible]";

interface FeedbackChatProps {
  onCollapse: () => void;
  sessionId: string;
  pages: Record<string, PageMeta>;
  tools: Record<string, ToolInteraction>;
  turns: FeedbackTurn[];
  agentState: AgentState;
  onJump: (pageId: string, line?: number, side?: "old" | "new", annotId?: string) => void;
  onDeleteComment: (pageId: string, commentId: string) => void;
  onDeleteEdit: (pageId: string, editId: string) => void;
  onSendFeedback: (overallNote: string) => Promise<void>;
  onToolAction: (id: string, action: ToolAction) => Promise<void>;
}

function pendingItems(pages: Record<string, PageMeta>): AnnotationFeedbackTurnItem[] {
  const items: AnnotationFeedbackTurnItem[] = [];
  for (const page of Object.values(pages)) {
    for (const c of page.comments) {
      if (c.sent) continue;
      items.push({
        id: c.id,
        kind: "comment",
        pageId: page.id,
        filename: page.filename,
        file: c.file,
        startLine: c.startLine,
        endLine: c.endLine,
        side: c.side,
        quote: c.quote,
        feedback: c.feedback,
        orphaned: c.orphaned,
      });
    }
    for (const e of page.edits) {
      if (e.sent) continue;
      items.push({
        id: e.id,
        kind: "edit",
        pageId: page.id,
        filename: page.filename,
        file: e.file,
        startLine: e.startLine,
        endLine: e.endLine,
        side: e.side,
        originalText: e.originalText,
        suggestedText: e.suggestedText,
        orphaned: e.orphaned,
      });
    }
  }
  return items;
}

function locationLabel(item: Extract<FeedbackTurnItem, { kind: "comment" | "edit" }>): string {
  if (item.orphaned) return "Unplaced";
  if (item.kind === "edit") return `L${item.startLine}-${item.endLine}`;
  if (!item.startLine) return "General";
  const side = item.side === "old" ? "old " : item.side === "new" ? "new " : "";
  return `${side}L${item.startLine}`;
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function FeedbackChat({
  onCollapse,
  sessionId,
  pages,
  tools,
  turns,
  agentState,
  onJump,
  onDeleteComment,
  onDeleteEdit,
  onSendFeedback,
  onToolAction,
}: FeedbackChatProps) {
  const [note, setNote] = React.useState("");
  const [isSending, setIsSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);

  const pending = pendingItems(pages);
  const generalTools = Object.values(tools).filter((tool) => !tool.request.anchor);
  const readyToolCount = Object.values(tools).filter((tool) => tool.state === "ready").length;
  const pendingCount = pending.length + readyToolCount;
  const canSend = pendingCount > 0 || note.trim().length > 0;

  const handleSend = async () => {
    if (!canSend || isSending) return;
    setIsSending(true);
    setSendError(null);
    try {
      await onSendFeedback(note);
      setNote("");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Could not send feedback");
    } finally {
      setIsSending(false);
    }
  };

  const handleDelete = (item: Extract<FeedbackTurnItem, { kind: "comment" | "edit" }>) =>
    item.kind === "comment"
      ? onDeleteComment(item.pageId, item.id)
      : onDeleteEdit(item.pageId, item.id);

  return (
    <div className="bg-background flex h-full min-h-0 flex-col border-s">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <span className="flex-1 text-sm font-medium">Feedback</span>
        <AgentStatus state={agentState} />
        <Button variant="ghost" size="icon-sm" aria-label="Hide feedback" onClick={onCollapse}>
          <PanelRight />
        </Button>
      </header>

      <p className="text-muted-foreground shrink-0 border-b px-3 py-2 text-sm">
        {turns.filter((t) => t.from !== "agent").length} sent, {pendingCount} pending.
      </p>

      <MessageScrollerProvider defaultScrollPosition="end">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-6 px-4 py-4">
              {generalTools.length > 0 && (
                <div className="flex flex-col gap-3" data-testid="general-tools">
                  <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Agent tools
                  </div>
                  {generalTools.map((tool) => (
                    <ToolFrame
                      key={tool.id}
                      sessionId={sessionId}
                      interaction={tool}
                      onAction={(action) => onToolAction(tool.id, action)}
                    />
                  ))}
                </div>
              )}

              {turns.length === 0 && pending.length === 0 && generalTools.length === 0 ? (
                <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 text-center">
                  <MessageSquare className="size-8 opacity-40" />
                  <p className="text-sm font-medium">No feedback yet</p>
                  <p className="max-w-[220px] text-sm">
                    Hover a paragraph and press <span className="font-mono">+</span>, or select text
                    to annotate.
                  </p>
                </div>
              ) : null}

              {turns.map((turn) => (
                <MessageScrollerItem
                  key={turn.id}
                  messageId={turn.id}
                  scrollAnchor
                  className={ITEM}
                >
                  <Message align={turn.from === "agent" ? "start" : "end"}>
                    <MessageContent>
                      <MessageHeader>
                        {turn.from === "agent" && <span className="mr-1.5">Agent</span>}
                        {clockTime(turn.sentAt)}
                        {turn.items.length > 0 && (
                          <span className="ml-1.5">
                            {turn.items.length} item
                            {turn.items.length === 1 ? "" : "s"}
                          </span>
                        )}
                      </MessageHeader>

                      <BubbleGroup
                        className={
                          turn.from === "agent"
                            ? "border-primary/40 gap-1.5 border-s-2 ps-2"
                            : "gap-1.5"
                        }
                      >
                        {turn.items.map((item, i) =>
                          item.kind === "tool" ? (
                            <ToolTranscriptBubble
                              key={`${turn.id}-${i}`}
                              item={item}
                              onJump={
                                item.anchor
                                  ? () =>
                                      onJump(
                                        item.anchor!.pageId,
                                        item.anchor!.line,
                                        undefined,
                                        item.id
                                      )
                                  : undefined
                              }
                            />
                          ) : (
                            <ItemBubble
                              key={`${turn.id}-${i}`}
                              item={item}
                              onJump={
                                item.orphaned
                                  ? undefined
                                  : () => onJump(item.pageId, item.startLine, item.side, item.id)
                              }
                            />
                          )
                        )}
                        {turn.note && (
                          <Bubble
                            variant={turn.from === "agent" ? "muted" : "default"}
                            className="max-w-full"
                          >
                            <BubbleContent className="whitespace-pre-wrap">
                              {turn.note}
                            </BubbleContent>
                          </Bubble>
                        )}
                      </BubbleGroup>

                      <MessageFooter>
                        {turn.from === "agent" ? (
                          <>
                            <Bot className="mr-1 size-3" />
                            Replied
                          </>
                        ) : turn.delivered ? (
                          <>
                            <CheckCircle2 className="mr-1 size-3" />
                            Sent
                          </>
                        ) : (
                          <>
                            <Clock className="mr-1 size-3" />
                            Queued for agent
                          </>
                        )}
                      </MessageFooter>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              ))}

              {pending.length > 0 && (
                <MessageScrollerItem messageId="pending" scrollAnchor className={ITEM}>
                  <div className="mb-3 flex items-center gap-2">
                    <span className="bg-border h-px flex-1" />
                    <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                      Not sent
                    </span>
                    <span className="bg-border h-px flex-1" />
                  </div>

                  <Message align="end">
                    <MessageContent>
                      <BubbleGroup className="gap-1.5">
                        {pending.map((item) => (
                          <ItemBubble
                            key={item.id}
                            item={item}
                            onJump={
                              item.orphaned
                                ? undefined
                                : () => onJump(item.pageId, item.startLine, item.side, item.id)
                            }
                            onDelete={() => handleDelete(item)}
                          />
                        ))}
                      </BubbleGroup>
                      <MessageFooter>Draft</MessageFooter>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
          <FollowNewTurn count={turns.length} />
        </MessageScroller>
      </MessageScrollerProvider>

      <div className="flex shrink-0 flex-col gap-2 border-t p-3">
        <Textarea
          aria-label="Message to the agent"
          placeholder="Summary, verdict, or general instructions"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleSend();
            }
          }}
          className="max-h-40 min-h-20"
        />
        {sendError && (
          <p role="alert" className="text-destructive text-xs">
            {sendError}
          </p>
        )}
        <Button onClick={handleSend} disabled={isSending || !canSend}>
          <Send />
          {isSending ? "Sending..." : "Send to agent"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Sending drops the draft row, and with it the anchor the scroller was holding,
 * so the transcript has to be told to follow the turn that replaced it.
 */
function FollowNewTurn({ count }: { count: number }) {
  const { scrollToEnd } = useMessageScroller();
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => scrollToEnd({ behavior: "smooth" }));
    return () => cancelAnimationFrame(frame);
  }, [count, scrollToEnd]);
  return null;
}

const STATUS_STYLE: Record<string, string> = {
  applied: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  skipped: "bg-muted text-muted-foreground",
  question: "bg-amber-500/15 text-amber-600 dark:text-amber-500",
};

const STATUS_EDGE: Record<string, string> = {
  applied: "!border-emerald-500/40",
  skipped: "!border-border",
  question: "!border-amber-500/50",
};

const TOOL_STATUS_LABEL: Record<string, string> = {
  question: "Awaiting your reply",
  applied: "Applied",
  skipped: "Skipped",
};

export function StatusChip({ status, label = status }: { status: string; label?: string }) {
  return (
    <span
      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLE[status] ?? ""}`}
    >
      {label}
    </span>
  );
}

function ToolTranscriptBubble({
  item,
  onJump,
}: {
  item: Extract<FeedbackTurnItem, { kind: "tool" }>;
  onJump?: () => void;
}) {
  const value = item.result.kind === "dismissed" ? null : item.result.value;
  const formatted =
    item.result.kind === "dismissed"
      ? "Skipped"
      : value === ""
        ? "Empty answer"
        : value === null ||
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ? String(value)
          : JSON.stringify(value, null, 2);
  const result = formatted.length > 8_000 ? `${formatted.slice(0, 8_000)}...` : formatted;
  return (
    <Bubble variant="outline" className="w-full max-w-full">
      <BubbleContent
        className="w-full rounded-xl px-2.5 py-2"
        render={
          onJump ? (
            <button type="button" onClick={onJump} aria-label={`Show ${item.tool} interaction`} />
          ) : (
            <div />
          )
        }
      >
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          <Bot className="size-3 shrink-0" />
          <span className="truncate">{item.tool}</span>
          {item.status && item.status !== "open" && (
            <StatusChip
              status={item.status}
              label={TOOL_STATUS_LABEL[item.status] ?? item.status}
            />
          )}
        </div>
        <pre className="mt-1 max-w-full overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs">
          {result}
        </pre>
        {item.replies.length > 0 && (
          <div className="mt-2 flex flex-col gap-1 border-t pt-1.5 text-xs">
            {item.replies.map((reply) => (
              <p key={`${reply.at}-${reply.text}`}>
                <span className="font-medium">{reply.from === "agent" ? "Agent" : "You"}:</span>{" "}
                {reply.text}
              </p>
            ))}
          </div>
        )}
      </BubbleContent>
    </Bubble>
  );
}

function ItemBubble({
  item,
  onJump,
  onDelete,
}: {
  item: Extract<FeedbackTurnItem, { kind: "comment" | "edit" }>;
  onJump?: () => void;
  onDelete?: () => void;
}) {
  return (
    <Bubble variant="outline" className="w-full max-w-full">
      {/* Outside the content so the card can be a button without nesting one. */}
      {onDelete && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Delete"
          onClick={onDelete}
          className="hover:text-destructive text-muted-foreground absolute end-1 top-1 z-10"
        >
          <Trash2 className="size-3" />
        </Button>
      )}

      <BubbleContent
        className={`w-full rounded-xl px-2.5 py-2 ${
          item.status ? (STATUS_EDGE[item.status] ?? "") : ""
        }`}
        render={
          onJump ? (
            <button
              type="button"
              onClick={onJump}
              aria-label={`Show ${item.file || item.filename} ${locationLabel(item)}`}
            />
          ) : (
            <div />
          )
        }
      >
        <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 pe-6 text-xs font-medium">
          {item.kind === "edit" ? (
            <Edit3 className="size-3 shrink-0" />
          ) : (
            <MessageSquare className="size-3 shrink-0" />
          )}
          <span className="truncate">{item.file || item.filename}</span>
          <span className={`shrink-0 ${item.orphaned ? "text-amber-600" : "opacity-70"}`}>
            {locationLabel(item)}
          </span>
          {item.status && item.status !== "open" && <StatusChip status={item.status} />}
        </div>

        {item.kind === "comment" ? (
          <>
            {item.quote && (
              <blockquote className="text-muted-foreground mt-1.5 border-l-2 pl-2 font-mono text-xs">
                {item.quote}
              </blockquote>
            )}
            <p className="mt-1 text-sm whitespace-pre-wrap">{item.feedback}</p>
          </>
        ) : (
          <>
            {item.originalText && (
              <pre className="bg-destructive/10 mt-1.5 overflow-x-auto rounded-md px-2 py-1 font-mono text-xs line-through">
                {item.originalText}
              </pre>
            )}
            <pre className="mt-1 overflow-x-auto rounded-md bg-emerald-500/10 px-2 py-1 font-mono text-xs">
              {item.suggestedText}
            </pre>
          </>
        )}
      </BubbleContent>
    </Bubble>
  );
}
