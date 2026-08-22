import React from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

export interface FindMatch {
  line: number;
  text: string;
}

/** Line numbers holding the query, in file order. Source lines, not rendered prose. */
export function findMatches(source: string, query: string): FindMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const matches: FindMatch[] = [];
  source.split("\n").forEach((text, i) => {
    if (text.toLowerCase().includes(needle)) matches.push({ line: i + 1, text: text.trim() });
  });
  return matches;
}

export function FindBar({
  source,
  onJump,
  onClose,
}: {
  source: string;
  onJump: (line: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const [at, setAt] = React.useState(0);

  const matches = React.useMemo(() => findMatches(source, query), [source, query]);
  const current = matches.length ? Math.min(at, matches.length - 1) : 0;

  const step = (delta: 1 | -1) => {
    if (matches.length === 0) return;
    const next = (current + delta + matches.length) % matches.length;
    setAt(next);
    onJump(matches[next].line);
  };

  // A new query starts its own walk, and lands on the first hit without a keypress.
  React.useEffect(() => {
    setAt(0);
    if (matches.length) onJump(matches[0].line);
    // Jumping again whenever the callback identity changes would fight the user's
    // own scrolling, so this follows the query alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <div className="bg-background/95 sticky top-12 z-40 ml-auto -mb-11 mr-4 flex w-fit items-center gap-1 rounded-xl border p-1.5 shadow-lg backdrop-blur">
      <Input
        autoFocus
        aria-label="Find in this page"
        placeholder="Find"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
        }}
        className="h-7 w-44"
      />
      <span className="text-muted-foreground w-14 shrink-0 text-center text-xs tabular-nums">
        {matches.length ? `${current + 1}/${matches.length}` : query.trim() ? "0/0" : ""}
      </span>
      <Button variant="ghost" size="icon-xs" aria-label="Previous match" onClick={() => step(-1)}>
        <ChevronUp className="size-3.5" />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Next match" onClick={() => step(1)}>
        <ChevronDown className="size-3.5" />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Close find" onClick={onClose}>
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
