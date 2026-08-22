import React from "react";

/** A handler returning false leaves the key to the browser. */
export type HotkeyMap = Record<string, (() => boolean | void) | undefined>;

/** "j", "]", "?", "Escape", "mod+Enter" - mod is Cmd on a Mac, Ctrl elsewhere. */
export function comboFor(event: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): string {
  const mod = event.metaKey || event.ctrlKey;
  if (event.altKey) return "";
  return mod ? `mod+${event.key}` : event.key;
}

/** A composer owns every key it can render, so nothing fires while one has focus. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || !!el.isContentEditable;
}

export function useHotkeys(map: HotkeyMap) {
  const latest = React.useRef(map);
  latest.current = map;

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      // A modal owns every key while it is open, Escape above all: swallowing that
      // one here left the diagram lightbox with no way out.
      if (document.querySelector("dialog[open]")) return;

      const handler = latest.current[comboFor(event)];
      if (!handler) return;
      if (handler() !== false) event.preventDefault();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
