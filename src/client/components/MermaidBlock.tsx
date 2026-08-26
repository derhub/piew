import React from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { cn } from "~/lib/utils";
import { useIsDark } from "~/hooks/use-theme";

interface MermaidBlockProps {
  chart: string;
}

/** Below this, fitting to the column makes labels unreadable; scroll instead. */
const MIN_FIT = 0.6;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const STEP = 0.25;

const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

function naturalSize(svg: string): { width: number; height: number } | null {
  const box = /viewBox="([\d.\-\s]+)"/.exec(svg)?.[1]?.trim().split(/\s+/);
  if (box?.length !== 4) return null;
  const width = Number(box[2]);
  const height = Number(box[3]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function useRenderedChart(chart: string, id: string, isDark: boolean) {
  const [svg, setSvg] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;

    import("mermaid")
      .then(({ default: mermaid }) => {
        if (!active) return;
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? "dark" : "neutral",
          securityLevel: "loose",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          themeVariables: {
            // Mermaid's dark theme paints edge labels on a light plate, and its color
            // parser rejects the oklch() our tokens are written in — so pass hex.
            edgeLabelBackground: isDark ? "#1f1f1f" : "#ffffff",
          },
        });

        return mermaid.render(id, chart.trim());
      })
      .then((result) => {
        if (!active || !result) return;
        const { svg: rendered } = result;
        setSvg(rendered);
        setError(null);
      })
      .catch((err) => {
        // Mermaid leaves its measuring node attached when a render throws.
        document.getElementById(`d${id}`)?.remove();
        if (!active) return;
        setSvg("");
        setError(err?.message?.trim() || "Failed to render diagram");
      });

    return () => {
      active = false;
      document.getElementById(`d${id}`)?.remove();
    };
  }, [chart, id, isDark]);

  const natural = React.useMemo(() => (svg ? naturalSize(svg) : null), [svg]);
  return { svg, error, natural };
}

/** Non-passive so the handler can actually stop the page from scrolling. */
function useWheel(ref: React.RefObject<HTMLElement | null>, handler: (event: WheelEvent) => void) {
  const latest = React.useRef(handler);
  latest.current = handler;

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const listener = (event: WheelEvent) => latest.current(event);
    el.addEventListener("wheel", listener, { passive: false });
    return () => el.removeEventListener("wheel", listener);
  }, [ref]);
}

function Controls({
  percent,
  onZoomOut,
  onZoomIn,
  onReset,
  onExpand,
  className,
}: {
  percent: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onReset: () => void;
  onExpand?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-background/95 text-muted-foreground absolute top-3 right-3 z-10 flex items-center rounded-lg border p-0.5 opacity-0 shadow-sm transition-opacity",
        "group-hover/diagram:opacity-100 focus-within:opacity-100",
        className
      )}
    >
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out (-)"
        onClick={onZoomOut}
        className="hover:text-foreground hover:bg-muted flex size-6 items-center justify-center rounded-md"
      >
        <Minus className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Reset zoom"
        title="Reset zoom (0)"
        onClick={onReset}
        className="hover:text-foreground hover:bg-muted h-6 min-w-11 rounded-md text-center font-mono text-xs tabular-nums"
      >
        {Math.round(percent * 100)}%
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in (+)"
        onClick={onZoomIn}
        className="hover:text-foreground hover:bg-muted flex size-6 items-center justify-center rounded-md"
      >
        <Plus className="size-3.5" />
      </button>
      {onExpand && (
        <button
          type="button"
          aria-label="Expand diagram"
          title="Expand (F)"
          onClick={onExpand}
          className="hover:text-foreground hover:bg-muted flex size-6 items-center justify-center rounded-md"
        >
          <Maximize2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function DiagramError({ message, chart }: { message: string; chart: string }) {
  return (
    <div className="border-destructive/40 bg-destructive/5 my-6 rounded-lg border">
      <p className="text-destructive border-destructive/30 border-b px-3 py-1.5 font-mono text-xs font-medium">
        {message}
      </p>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-xs whitespace-pre">{chart}</pre>
    </div>
  );
}

export function MermaidBlock({ chart }: MermaidBlockProps) {
  const baseId = React.useId().replace(/:/g, "_");
  const isDark = useIsDark();
  const { svg, error, natural } = useRenderedChart(chart, `mermaid_${baseId}`, isDark);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = React.useState(0);
  const [zoom, setZoom] = React.useState<number | null>(null);
  const [expanded, setExpanded] = React.useState(false);

  // Measured on layout, not just from the observer: the observer's first callback
  // lands after paint, which would leave the fit scale at 1 for the first frame.
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const measure = () => {
      const style = getComputedStyle(el);
      const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      setContainerWidth(Math.max(0, el.clientWidth - padding));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fit =
    natural && containerWidth ? Math.min(1, Math.max(MIN_FIT, containerWidth / natural.width)) : 1;
  const scale = zoom ?? fit;

  const step = (delta: number) => setZoom((current) => clampZoom((current ?? fit) + delta));

  // Plain wheel must still scroll the page; only an explicit modifier zooms.
  useWheel(scrollRef, (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setZoom((current) => clampZoom((current ?? fit) * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
  });

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "+" || event.key === "=") step(STEP);
    else if (event.key === "-") step(-STEP);
    else if (event.key === "0") setZoom(null);
    else if (event.key.toLowerCase() === "f") setExpanded(true);
    else return;
    event.preventDefault();
  };

  if (error) return <DiagramError message={error} chart={chart} />;

  return (
    <figure
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="Diagram. Use plus and minus to zoom, F to expand."
      className="group/diagram bg-card focus-visible:ring-ring/50 relative my-6 rounded-lg border outline-none focus-visible:ring-2"
    >
      <div ref={scrollRef} className="overflow-auto p-4">
        {svg ? (
          <div
            className="mx-auto [&_svg]:!max-w-none [&_svg]:h-auto [&_svg]:w-full"
            style={natural ? { width: natural.width * scale } : undefined}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="text-muted-foreground flex h-32 items-center justify-center text-xs">
            Rendering diagram...
          </div>
        )}
      </div>

      {svg && (
        <Controls
          percent={scale}
          onZoomOut={() => step(-STEP)}
          onZoomIn={() => step(STEP)}
          onReset={() => setZoom(null)}
          onExpand={() => setExpanded(true)}
        />
      )}

      {expanded && <Lightbox chart={chart} isDark={isDark} onClose={() => setExpanded(false)} />}
    </figure>
  );
}

interface View {
  scale: number;
  x: number;
  y: number;
}

/**
 * Fullscreen canvas: wheel zooms toward the cursor, drag pans. Rendered with its own
 * mermaid id so its marker ids never collide with the inline copy.
 */
function Lightbox({
  chart,
  isDark,
  onClose,
}: {
  chart: string;
  isDark: boolean;
  onClose: () => void;
}) {
  const baseId = React.useId().replace(/:/g, "_");
  const { svg, error, natural } = useRenderedChart(chart, `mermaid_zoom_${baseId}`, isDark);

  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const [view, setView] = React.useState<View | null>(null);
  const [dragging, setDragging] = React.useState(false);

  React.useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const reset = React.useCallback(() => {
    const el = viewportRef.current;
    if (!el || !natural) return;
    const { width, height } = el.getBoundingClientRect();
    const scale = Math.min(1, Math.min(width / natural.width, height / natural.height));
    setView({
      scale,
      x: (width - natural.width * scale) / 2,
      y: (height - natural.height * scale) / 2,
    });
  }, [natural]);

  React.useLayoutEffect(() => reset(), [reset]);

  // Zoom about the cursor so the point under it stays put.
  useWheel(viewportRef, (event) => {
    event.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;

    setView((current) => {
      if (!current) return current;
      const next = clampZoom(current.scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
      const ratio = next / current.scale;
      return { scale: next, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio };
    });
  });

  const zoomBy = (factor: number) =>
    setView((current) => {
      const el = viewportRef.current;
      if (!current || !el) return current;
      const { width, height } = el.getBoundingClientRect();
      const next = clampZoom(current.scale * factor);
      const ratio = next / current.scale;
      const cx = width / 2;
      const cy = height / 2;
      return { scale: next, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio };
    });

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "+" || event.key === "=") zoomBy(1 + STEP);
    else if (event.key === "-") zoomBy(1 / (1 + STEP));
    else if (event.key === "0") reset();
    // Closing on its own rather than leaning on the dialog's built-in cancel: the
    // page listens for Escape too, and whoever gets it first must not swallow it.
    else if (event.key === "Escape") onClose();
    else return;
    event.preventDefault();
  };

  // Tracked on the window rather than via pointer capture, so a drag keeps working
  // when the cursor leaves the dialog and always ends on release.
  React.useEffect(() => {
    if (!dragging) return;

    const onMove = (event: PointerEvent) =>
      setView((current) =>
        current
          ? { ...current, x: current.x + event.movementX, y: current.y + event.movementY }
          : current
      );
    const onUp = () => setDragging(false);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onKeyDown={onKeyDown}
      className="bg-card text-foreground m-auto h-[92dvh] w-[94vw] max-w-none rounded-lg border p-0 backdrop:bg-black/60"
    >
      <div className="group/diagram relative h-full w-full overflow-hidden">
        {error ? (
          <p className="text-destructive p-6 font-mono text-xs">{error}</p>
        ) : (
          <div
            ref={viewportRef}
            onPointerDown={() => setDragging(true)}
            className={cn(
              "h-full w-full touch-none overflow-hidden",
              dragging ? "cursor-grabbing" : "cursor-grab"
            )}
          >
            {svg && natural && view && (
              <div
                style={{
                  width: natural.width,
                  transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                  transformOrigin: "0 0",
                }}
                className="[&_svg]:!max-w-none [&_svg]:h-auto [&_svg]:w-full"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            )}
          </div>
        )}

        {svg && view && (
          <Controls
            percent={view.scale}
            onZoomOut={() => zoomBy(1 / (1 + STEP))}
            onZoomIn={() => zoomBy(1 + STEP)}
            onReset={reset}
          />
        )}

        <p className="text-muted-foreground pointer-events-none absolute bottom-4 left-4 text-xs opacity-0 transition-opacity group-hover/diagram:opacity-100">
          Scroll to zoom · drag to pan · Esc to close
        </p>
      </div>
    </dialog>
  );
}
