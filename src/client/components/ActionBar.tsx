import React from "react";
import { Minus, MessageSquare, Monitor, Moon, Palette, Plus, Send, Sun } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { AgentStatus, type AgentState } from "~/components/AgentStatus";
import { useThemePreference, type ThemePreference } from "~/hooks/use-theme";
import { CODE_THEMES, useCodeTheme, type CodeThemeName } from "~/hooks/use-code-theme";

const THEMES: { value: ThemePreference; label: string; icon: React.ElementType }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

interface ActionBarProps {
  agentState: AgentState;
  count: number;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  feedbackHidden: boolean;
  onToggleFeedback: () => void;
  onSend: () => Promise<void>;
}

export function ActionBar({
  agentState,
  count,
  zoom,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  feedbackHidden,
  onToggleFeedback,
  onSend,
}: ActionBarProps) {
  const [sending, setSending] = React.useState(false);
  const { preference, setPreference } = useThemePreference();
  const { name: codeTheme, setName: setCodeTheme } = useCodeTheme();

  const send = async () => {
    setSending(true);
    try {
      await onSend();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="pointer-events-none sticky bottom-6 z-40 flex shrink-0 justify-center px-4">
      <div className="bg-background pointer-events-auto flex items-center gap-1 rounded-full border p-1 pl-3 shadow-lg">
        <AgentStatus state={agentState} />

        <Separator
          orientation="vertical"
          className="mx-1 h-4 max-md:hidden data-vertical:self-center"
        />

        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-full max-md:hidden"
          aria-label="Zoom out"
          onClick={onZoomOut}
        >
          <Minus />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="rounded-full px-1 font-mono text-xs tabular-nums max-md:hidden"
          aria-label="Reset zoom"
          title="Reset text size"
          onClick={onResetZoom}
        >
          {Math.round(zoom * 100)}%
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-full max-md:hidden"
          aria-label="Zoom in"
          onClick={onZoomIn}
        >
          <Plus />
        </Button>

        <Separator
          orientation="vertical"
          className="mx-1 h-4 max-md:hidden data-vertical:self-center"
        />

        <Select value={codeTheme} onValueChange={(v) => setCodeTheme(v as CodeThemeName)}>
          <SelectTrigger
            size="sm"
            aria-label="Syntax theme"
            title="Syntax theme"
            className="h-8 gap-1 rounded-full border-0 px-2 shadow-none focus-visible:ring-0 max-md:hidden"
          >
            <Palette className="size-4" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="center">
            {Object.entries(CODE_THEMES).map(([value, { label }]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={preference} onValueChange={(v) => setPreference(v as ThemePreference)}>
          <SelectTrigger
            size="sm"
            aria-label="Theme"
            className="h-8 gap-1 rounded-full border-0 px-2 shadow-none focus-visible:ring-0 [&>svg:last-child]:hidden"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="center">
            {THEMES.map(({ value, label, icon: Icon }) => (
              <SelectItem key={value} value={value}>
                <Icon className="size-4" />
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Separator orientation="vertical" className="mx-1 h-4 data-vertical:self-center" />

        <Button
          variant="ghost"
          size="sm"
          className="rounded-full"
          aria-pressed={!feedbackHidden}
          aria-label={feedbackHidden ? "Show feedback" : "Hide feedback"}
          onClick={onToggleFeedback}
        >
          <MessageSquare />
          <span className="max-md:hidden">Feedback</span>
          {count > 0 && (
            <span className="bg-muted text-foreground ml-0.5 rounded-full px-1.5 text-xs tabular-nums">
              {count}
            </span>
          )}
        </Button>

        <Button size="sm" className="rounded-full" disabled={sending || count === 0} onClick={send}>
          <Send />
          {sending ? "Sending" : "Send"}
        </Button>
      </div>
    </div>
  );
}
