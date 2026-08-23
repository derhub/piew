export type PageKind = "markdown" | "diff" | "file";

export type DiffStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  oldPath?: string;
  newPath?: string;
  // Absent for a side that does not exist, and for binary blobs.
  oldContent?: string;
  newContent?: string;
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
  key: string;
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

export interface PageFeedback {
  file: string;
  comments: ReviewComment[];
  edits?: ReviewEdit[];
}

export interface ReviewBatch {
  status: "feedback" | "timeout" | "closed";
  pages: PageFeedback[];
  overall_note?: string;
  sent_at: string;
  next_step?: string;
}

export interface FeedbackTurnItem {
  id: string;
  kind: "comment" | "edit";
  status?: ItemStatus;
  pageKey: string;
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
  entryKey: string;
  activeKey: string;
  pageKeys: string[];
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
