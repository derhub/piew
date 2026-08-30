import React from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useIsDark } from "~/hooks/use-theme";
import type { JsonValue, ToolInteraction } from "~/lib/types";

const MAX_RESULT_BYTES = 64 * 1024;
const MIN_TOOL_HEIGHT = 56;
const DEFAULT_TOOL_HEIGHT = 128;
const MAX_TOOL_HEIGHT = 480;

export type ToolAction =
  | { type: "submit"; value: JsonValue }
  | { type: "reset" }
  | { type: "dismiss" }
  | { type: "reply"; text: string };

interface ToolFrameProps {
  sessionId: string;
  interaction: ToolInteraction;
  onAction?: (action: ToolAction) => Promise<void>;
}

interface FrameErrorBoundaryProps {
  children: React.ReactNode;
  onError: (message: string) => void;
}

interface FrameErrorBoundaryState {
  error: string | null;
}

class FrameErrorBoundary extends React.Component<FrameErrorBoundaryProps, FrameErrorBoundaryState> {
  state: FrameErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): FrameErrorBoundaryState {
    return {
      error: error instanceof Error ? error.message : "Tool failed to render",
    };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error instanceof Error ? error.message : "Tool failed to render");
  }

  render() {
    if (this.state.error) {
      return (
        <p role="alert" className="text-destructive p-3 text-sm">
          {this.state.error}
        </p>
      );
    }
    return this.props.children;
  }
}

function requestAction(action: ToolAction): Record<string, unknown> {
  return action.type === "submit"
    ? { action: "submit", value: action.value }
    : action.type === "reply"
      ? { action: "reply", text: action.text }
      : { action: action.type };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    !!value &&
    typeof value === "object" &&
    Object.values(value as Record<string, unknown>).every(isJsonValue)
  );
}

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return MAX_RESULT_BYTES + 1;
  }
}

function newChannel(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatResult(result: { kind: "submitted" | "dismissed"; value?: JsonValue }) {
  if (result.kind === "dismissed") return "Skipped";
  const value = result.value;
  if (value === "") return "Empty answer";
  const text =
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value, null, 2);
  return text.length > 8_000 ? `${text.slice(0, 8_000)}...` : text;
}

const STATE_LABEL: Record<ToolInteraction["state"], string> = {
  open: "Needs your input",
  ready: "Ready to send",
  sent: "Sent",
  "awaiting-answer": "Awaiting your reply",
  resolved: "",
};

const ACTION_PROGRESS: Record<ToolAction["type"], string> = {
  submit: "Saving answer...",
  reset: "Resetting...",
  dismiss: "Skipping question...",
  reply: "Replying...",
};

export function ToolFrame({ sessionId, interaction, onAction }: ToolFrameProps) {
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const channelRef = React.useRef(newChannel());
  const initializedRef = React.useRef(false);
  const [height, setHeight] = React.useState(DEFAULT_TOOL_HEIGHT);
  const [error, setError] = React.useState<string | null>(null);
  const [reply, setReply] = React.useState("");
  const [pendingAction, setPendingAction] = React.useState<ToolAction["type"] | null>(null);
  const busy = pendingAction !== null;
  const isDark = useIsDark();

  const action = React.useCallback(
    async (next: ToolAction) => {
      if (busy) return;
      setPendingAction(next.type);
      setError(null);
      try {
        if (onAction) await onAction(next);
        else {
          const response = await fetch(`/api/session/${sessionId}/tool/${interaction.id}/action`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestAction(next)),
          });
          if (!response.ok) throw new Error(`Tool action failed (${response.status})`);
        }
        if (next.type === "reply") setReply("");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Tool action failed");
      } finally {
        setPendingAction(null);
      }
    },
    [busy, interaction.id, onAction, sessionId]
  );

  const post = React.useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  const sendInit = React.useCallback(() => {
    if (!frameRef.current?.contentWindow) return;
    post({
      type: "piew:init",
      channel: channelRef.current,
      prompt: interaction.request.prompt,
      data: interaction.request.data,
      theme: isDark ? "dark" : "light",
    });
    initializedRef.current = true;
  }, [interaction.request.data, interaction.request.prompt, isDark, post]);

  React.useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "piew:ready") {
        sendInit();
        return;
      }
      if (message.channel !== channelRef.current || !initializedRef.current) return;
      if (message.type === "piew:resize") {
        if (typeof message.height !== "number" || !Number.isFinite(message.height)) return;
        setHeight(Math.max(MIN_TOOL_HEIGHT, Math.min(MAX_TOOL_HEIGHT, Math.round(message.height))));
        return;
      }
      if (message.type !== "piew:submit") return;
      if (interaction.state !== "open") {
        setError("Tool cannot submit in its current state");
        return;
      }
      if (!("value" in message) || !isJsonValue(message.value)) {
        setError("Tool result must be JSON");
        return;
      }
      if (jsonBytes(message.value) > MAX_RESULT_BYTES) {
        setError("Tool result is too large");
        return;
      }
      void action({ type: "submit", value: message.value });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [action, interaction.state, sendInit]);

  React.useEffect(() => {
    if (initializedRef.current) {
      post({
        type: "piew:theme",
        channel: channelRef.current,
        theme: isDark ? "dark" : "light",
      });
    }
  }, [isDark, post]);

  const resolvedLabel =
    interaction.state === "resolved"
      ? interaction.status === "applied"
        ? "Applied"
        : "Skipped"
      : null;
  const statusLabel = pendingAction
    ? ACTION_PROGRESS[pendingAction]
    : (resolvedLabel ?? STATE_LABEL[interaction.state]);
  const canReset = interaction.state === "ready" && interaction.replies.length === 0;
  const hasFooter =
    interaction.state === "open" || canReset || interaction.state === "awaiting-answer";

  return (
    <FrameErrorBoundary onError={setError}>
      <section
        className="border-primary/40 bg-card text-card-foreground relative overflow-hidden rounded-lg border border-s-2 shadow-xs"
        data-tool-id={interaction.id}
        data-tool-state={interaction.state}
        aria-busy={busy}
      >
        <span
          aria-hidden="true"
          className="bg-primary ring-card absolute start-0 top-4 z-10 size-2 rounded-full ring-2"
        />
        <div className="flex items-start gap-3 border-b px-3 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-muted-foreground text-xs font-medium">
              Agent asks / {interaction.tool} /{" "}
              {interaction.request.anchor ? "In review" : "Feedback rail"}
            </div>
            <p
              data-testid="tool-prompt"
              className="mt-1 break-words text-sm font-medium text-pretty"
            >
              {interaction.request.prompt}
            </p>
          </div>
          <Badge
            variant="secondary"
            className="h-auto min-h-6 max-w-32 shrink-0 whitespace-normal px-2 py-1 text-right text-xs leading-4"
            data-testid="tool-status"
            aria-live="polite"
          >
            {statusLabel}
          </Badge>
        </div>

        {interaction.state === "open" ? (
          <iframe
            ref={frameRef}
            title={`${interaction.tool} interaction`}
            src={`/api/session/${sessionId}/tool/${interaction.id}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            style={{ height }}
            className="block w-full max-w-full border-0"
            onLoad={sendInit}
            onError={() => setError("Tool frame failed to load")}
          />
        ) : (
          <div className="max-h-40 overflow-auto px-3 py-3">
            <div className="text-muted-foreground text-xs font-medium">Your answer</div>
            <pre
              data-testid="tool-result"
              className="mt-1 max-w-full overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs"
            >
              {formatResult(interaction.result)}
            </pre>
          </div>
        )}

        {error && (
          <p role="alert" className="text-destructive px-3 py-2 text-xs" aria-live="polite">
            {error}
          </p>
        )}
        {hasFooter && (
          <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
            {interaction.state === "open" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void action({ type: "dismiss" })}
                className="min-h-11 touch-manipulation"
              >
                Skip this question
              </Button>
            )}
            {canReset && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void action({ type: "reset" })}
                className="min-h-11 touch-manipulation"
              >
                Reset
              </Button>
            )}
            {interaction.state === "awaiting-answer" && (
              <form
                className="flex min-w-0 flex-1 gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (reply.trim()) void action({ type: "reply", text: reply });
                }}
              >
                <label className="sr-only" htmlFor={`tool-reply-${interaction.id}`}>
                  Reply to tool
                </label>
                <Input
                  id={`tool-reply-${interaction.id}`}
                  name="reply"
                  aria-label="Reply to tool"
                  autoComplete="off"
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  placeholder="Reply to the agent"
                  className="min-h-11"
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={busy || !reply.trim()}
                  className="min-h-11 touch-manipulation"
                >
                  Reply
                </Button>
              </form>
            )}
          </div>
        )}
      </section>
    </FrameErrorBoundary>
  );
}
