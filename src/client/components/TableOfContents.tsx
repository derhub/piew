import React from "react";
import { PanelRight } from "lucide-react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { extractHeadings, type HeadingItem } from "~/lib/headings";

const HIDDEN_KEY = "piew:toc-hidden";

/** Wanting the nav out of the way is a habit, not a per-document choice, so it sticks. */
function prefersHidden(): boolean {
  return localStorage.getItem(HIDDEN_KEY) === "1";
}

/** Marks the last heading scrolled past, like the shadcn docs "On This Page" nav. */
function useActiveHeading(ids: string[]) {
  const [active, setActive] = React.useState("");

  React.useEffect(() => {
    if (ids.length === 0) return;

    // ponytail: rect-per-heading on every crossing; switch to cached offsets if a doc ever has thousands.
    const update = () => {
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 120) current = id;
      }
      setActive(current);
    };

    update();

    // The document scrolls inside its panel, and a scroll event from an element
    // reaches neither window nor a capturing listener on document. An observer
    // watches the viewport itself, so it does not care what moved the page.
    const observer = new IntersectionObserver(update, { threshold: [0, 1] });
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [ids]);

  return active;
}

export function TableOfContents({ markdown }: { markdown: string }) {
  const headings = React.useMemo(() => extractHeadings(markdown), [markdown]);
  const ids = React.useMemo(() => headings.map((h) => h.id), [headings]);
  const active = useActiveHeading(ids);
  const [hidden, setHidden] = React.useState(prefersHidden);

  if (headings.length === 0) return null;

  const toggle = () => {
    localStorage.setItem(HIDDEN_KEY, hidden ? "0" : "1");
    setHidden(!hidden);
  };

  const scrollTo = (item: HeadingItem) => {
    const el =
      document.getElementById(item.id) ||
      document.querySelector(`[data-line-start="${item.line}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <aside
      className={cn(
        "sticky top-12 hidden h-[calc(100dvh-3rem)] shrink-0 overflow-y-auto py-10 xl:block",
        hidden ? "w-12 pr-2" : "w-60 pr-6"
      )}
    >
      <div className={cn("mb-3 flex items-center", hidden ? "justify-center" : "gap-1 pl-4")}>
        {!hidden && (
          <p className="text-muted-foreground flex-1 truncate text-xs font-medium">On This Page</p>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={hidden ? "Show table of contents" : "Hide table of contents"}
          onClick={toggle}
        >
          <PanelRight />
        </Button>
      </div>
      <nav className={cn("flex-col", hidden ? "hidden" : "flex")}>
        {headings.map((heading) => (
          <button
            key={`${heading.id}-${heading.line}`}
            type="button"
            onClick={() => scrollTo(heading)}
            title={heading.text}
            aria-current={active === heading.id ? "location" : undefined}
            className={cn(
              "truncate border-l-2 py-1.5 pr-2 text-left text-sm transition-colors",
              heading.level > 2 ? "pl-8" : "pl-4",
              active === heading.id
                ? "border-foreground text-foreground"
                : "text-muted-foreground hover:text-foreground border-transparent"
            )}
          >
            {heading.text}
          </button>
        ))}
      </nav>
    </aside>
  );
}
