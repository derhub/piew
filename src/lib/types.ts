import type { JsonValue } from "./tool-api";

export type { JsonValue } from "./tool-api";

export type PageKind = "markdown" | "diff" | "file";

export type DiffStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  oldPath?: string;
  newPath?: string;
  // Absent for a side that does not exist, and for binary blobs.
  oldContent?: string;
  newContent?: string;
  /** Digest of the captured new-side bytes, including binary blobs. */
  newHash?: string;
  status: DiffStatus;
}

export type ItemStatus = "open" | "applied" | "skipped" | "question";

/** One side of the exchange on a single annotation. */
export interface Reply {
  from: "agent" | "user";
  text: string;
  at: number;
}

export interface ReviewComment {
  id: string;
  kind: "line_range" | "selection" | "general";
  startLine?: number;
  endLine?: number;
  quote?: string;
  feedback: string;
  createdAt: number;
  // Diff pages only. An old-side line has no post-image counterpart, so it
  // carries the pre-image path in `file`.
  side?: "old" | "new";
  file?: string;
  /** Delivered to the agent already, so it is frozen against edits and deletes. */
  sent?: boolean;
  /** What the agent did with it. Only a question is still answerable. */
  status?: ItemStatus;
  replies?: Reply[];
  orphaned?: boolean;
}

export interface ReviewEdit {
  id: string;
  startLine: number;
  endLine: number;
  originalText: string;
  suggestedText: string;
  // Only ever "new": startLine indexes the post-image file the agent patches.
  side?: "new";
  file?: string;
  sent?: boolean;
  status?: ItemStatus;
  replies?: Reply[];
  orphaned?: boolean;
}

export interface PageData {
  id: string;
  file: string;
  filename: string;
  kind: PageKind;
  content: string;
  diff?: DiffFile;
  // Diff pages only: DiffFile paths are repo-relative and need this to resolve.
  repoRoot?: string;
  range?: string;
  staged?: boolean;
  /** Only a working-tree new side can drift, so only it can go stale. */
  liveHead?: boolean;
  stale?: boolean;
  comments: ReviewComment[];
  edits: ReviewEdit[];
  hash: string;
}

// What GET /api/session/:id returns per page: everything except the bytes.
export type PageMeta = Omit<PageData, "content" | "diff"> & {
  status?: DiffStatus;
};

export type PageContent = Pick<PageData, "id" | "kind" | "hash"> &
  ({ content: string; diff?: never } | { diff: DiffFile; content?: never });

export interface PageContentError {
  code: "page-missing" | "page-corrupt";
  message: string;
  retryable: boolean;
}

export interface PageFeedback {
  file: string;
  comments: ReviewComment[];
  edits?: ReviewEdit[];
}

export interface ToolAnchor {
  pageId: string;
  line: number;
}

export interface ToolRequest {
  prompt: string;
  data: JsonValue;
  anchor?: ToolAnchor;
}

export interface ToolArtifact {
  digest: string;
  files: string[];
  bytes: number;
}

export type ToolResult = { kind: "submitted"; value: JsonValue } | { kind: "dismissed" };

interface ToolInteractionBase {
  id: string;
  tool: string;
  request: ToolRequest;
  artifact: ToolArtifact;
  createdAt: number;
  replies: Reply[];
}

export type ToolInteraction =
  | (ToolInteractionBase & { state: "open" })
  | (ToolInteractionBase & { state: "ready"; result: ToolResult })
  | (ToolInteractionBase & { state: "sent"; result: ToolResult })
  | (ToolInteractionBase & { state: "awaiting-answer"; result: ToolResult })
  | (ToolInteractionBase & {
      state: "resolved";
      result: ToolResult;
      status: "applied" | "skipped";
    });

export interface ToolFeedback {
  id: string;
  tool: string;
  result: ToolResult;
  replies: Reply[];
  anchor?: ToolAnchor;
}

export interface ReviewBatch {
  status: "feedback" | "timeout" | "closed";
  pages: PageFeedback[];
  tools?: ToolFeedback[];
  overall_note?: string;
  sent_at: string;
  next_step?: string;
}

export interface AnnotationFeedbackTurnItem {
  id: string;
  kind: "comment" | "edit";
  status?: ItemStatus;
  pageId: string;
  filename: string;
  file?: string;
  startLine?: number;
  endLine?: number;
  side?: "old" | "new";
  quote?: string;
  feedback?: string;
  originalText?: string;
  suggestedText?: string;
  orphaned?: boolean;
}

export interface ToolFeedbackTurnItem {
  id: string;
  kind: "tool";
  status?: ItemStatus;
  tool: string;
  result: ToolResult;
  replies: Reply[];
  anchor?: ToolAnchor;
}

export type FeedbackTurnItem = AnnotationFeedbackTurnItem | ToolFeedbackTurnItem;

/** One press of Send, kept for the browser transcript. Dies with the session. */
export interface FeedbackTurn {
  id: string;
  /** Who spoke. A turn with no author predates two-sided transcripts. */
  from?: "user" | "agent";
  sentAt: string;
  note: string;
  delivered: boolean;
  items: FeedbackTurnItem[];
}

export interface SessionInfo {
  id: string;
  activePageId: string;
  reviewMap: ReviewMap;
}

export interface ReviewMap {
  title: string;
  items: ReviewMapItem[];
}

export interface ReviewMapItem {
  pageId: string;
  path: string;
}

export type ReviewMapSource = { kind: "page"; pageId: string } | { kind: "file"; file: string };

export interface ReplaceReviewMapRequest {
  title: string;
  items: Array<{ path: string; source: ReviewMapSource }>;
}

export interface ReviewSession {
  id: string;
  activePageId: string;
  reviewMap: ReviewMap;
  pages: Record<string, PageData>;
  lastSeen: number;
  turns: FeedbackTurn[];
  tools: Record<string, ToolInteraction>;
  pendingBatch?: { batch: ReviewBatch; delivered: boolean };
}

export interface AgentStatus {
  status: "feedback-waiting" | "idle";
  feedback_waiting: boolean;
  agent_listening: boolean;
  server_running: boolean;
  unsent: {
    comments: number;
    edits: number;
  };
}
