import React from "react";
import type { JsonValue, ToolInteraction } from "~/lib/types";

const MAX_RESULT_BYTES = 64 * 1024;

function requestAction(action: ToolAction): Record<string, unknown> {
  return action.type === "submit"
    ? { action: "submit", value: action.value }
    : action.type === "reply"
      ? { action: "reply", text: action.text }
      : { action: action.type };
}

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
    return { error: error instanceof Error ? error.message : "Tool failed to render" };
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

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return MAX_RESULT_BYTES + 1;
  }
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

function newChannel(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function defaultTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function ToolFrame({ sessionId, interaction, onAction }: ToolFrameProps) {
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const channelRef = React.useRef(newChannel());
  const [frameReady, setFrameReady] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reply, setReply] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const action = React.useCallback(
    async (next: ToolAction) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        if (onAction) {
          await onAction(next);
        } else {
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
        setBusy(false);
      }
    },
    [busy, interaction.id, onAction, sessionId]
  );

  const sendInit = React.useCallback(() => {
    const frame = frameRef.current;
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage(
      {
        type: "piew:init",
        channel: channelRef.current,
        prompt: interaction.request.prompt,
        data: interaction.request.data,
        theme: defaultTheme(),
      },
      "*"
    );
    setFrameReady(true);
  }, [interaction.request.data, interaction.request.prompt]);

  React.useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "piew:ready") {
        sendInit();
        return;
      }
      if (message.type !== "piew:submit" || message.channel !== channelRef.current) return;
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
      void action({ type: "submit", value: message.value as JsonValue });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [action, interaction.state, sendInit]);

  return (
    <FrameErrorBoundary onError={setError}>
      <section
        className="bg-card text-card-foreground overflow-hidden rounded-lg border shadow-xs"
        data-tool-id={interaction.id}
        data-tool-state={interaction.state}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{interaction.tool}</span>
          <span className="text-muted-foreground text-xs" data-testid="tool-status">
            {interaction.state}
          </span>
        </div>

        <iframe
          key={interaction.state === "open" ? "open" : "inactive"}
          ref={frameRef}
          title={`${interaction.tool} interaction`}
          src={`/api/session/${sessionId}/tool/${interaction.id}`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="h-56 w-full border-0"
          onLoad={() => setFrameReady(false)}
          onError={() => setError("Tool frame failed to load")}
        />

        {!frameReady && !error && (
          <p className="text-muted-foreground px-3 py-2 text-xs">Loading tool...</p>
        )}
        {error && (
          <p role="alert" className="text-destructive px-3 py-2 text-xs">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
          {interaction.state === "open" && (
            <button
              type="button"
              className="text-muted-foreground text-xs underline-offset-4 hover:underline"
              disabled={busy}
              onClick={() => void action({ type: "dismiss" })}
            >
              Dismiss
            </button>
          )}
          {interaction.state === "ready" && interaction.replies.length === 0 && (
            <button
              type="button"
              className="text-muted-foreground text-xs underline-offset-4 hover:underline"
              disabled={busy}
              onClick={() => void action({ type: "reset" })}
            >
              Reset
            </button>
          )}
          {interaction.state === "awaiting-answer" && (
            <form
              className="flex min-w-0 flex-1 gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (reply.trim()) void action({ type: "reply", text: reply });
              }}
            >
              <input
                aria-label="Reply to tool"
                className="bg-background min-w-0 flex-1 rounded border px-2 py-1 text-xs"
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder="Reply to the agent"
              />
              <button
                type="submit"
                disabled={busy || !reply.trim()}
                className="text-xs underline-offset-4 hover:underline"
              >
                Reply
              </button>
            </form>
          )}
        </div>
      </section>
    </FrameErrorBoundary>
  );
}
