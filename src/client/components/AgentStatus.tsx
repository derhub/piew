import { cn } from "~/lib/utils";

export type AgentState = "listening" | "working" | "stranded" | "idle";

const STATES: Record<AgentState, { label: string; dot: string }> = {
  listening: { label: "Listening", dot: "bg-emerald-500" },
  working: { label: "Working", dot: "bg-amber-500" },
  stranded: { label: "Queued", dot: "bg-violet-500" },
  idle: { label: "Idle", dot: "bg-muted-foreground" },
};

export function AgentStatus({ state, className }: { state: AgentState; className?: string }) {
  const { label, dot } = STATES[state] ?? { label: "Offline", dot: "bg-muted-foreground" };

  return (
    <span
      className={cn("text-muted-foreground flex items-center gap-1.5 text-xs", className)}
      title={`Agent: ${label}`}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
      {label}
    </span>
  );
}
