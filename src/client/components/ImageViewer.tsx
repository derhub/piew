import React from "react";
import { ChevronLeft, ChevronRight, Expand, Minus, Plus, RotateCcw, X } from "lucide-react";
import { Button } from "./ui/button";

export interface ImageViewerItem {
  src: string;
  alt: string;
}

interface ImageViewerProps {
  items: ImageViewerItem[];
  index: number;
  mode: "page" | "dialog";
  onIndexChange: (index: number) => void;
  onClose?: () => void;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const SCALE_STEP = 0.25;
const imageExtension = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)(?:[?#].*)?$/i;

export function isImageUrl(url: string): boolean {
  return imageExtension.test(url);
}

export function ImageViewer({ items, index, mode, onIndexChange, onClose }: ImageViewerProps) {
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const viewerRef = React.useRef<HTMLElement>(null);
  const dragRef = React.useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [scale, setScale] = React.useState(1);
  const [position, setPosition] = React.useState({ x: 0, y: 0 });
  const item = items[index];

  const reset = React.useCallback(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, []);

  React.useEffect(reset, [index, reset]);

  React.useEffect(() => {
    if (mode !== "dialog") return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => previousFocus?.focus();
  }, [mode]);

  React.useEffect(() => {
    if (scale <= 1) setPosition({ x: 0, y: 0 });
  }, [scale]);

  if (!item) return null;

  const move = (offset: number) => {
    onIndexChange((index + offset + items.length) % items.length);
  };

  const zoomBy = (amount: number) => {
    setScale((current) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, current + amount)));
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    if (scale <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX - position.x,
      y: event.clientY - position.y,
    };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPosition({ x: event.clientX - drag.x, y: event.clientY - drag.y });
  };

  const stopDragging = (event: React.PointerEvent<HTMLImageElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const content = (
    <section
      ref={viewerRef}
      className="image-viewer"
      aria-label={mode === "page" ? "Image viewer" : undefined}
      onKeyDown={(event) => {
        if (items.length < 2) return;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          move(-1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          move(1);
        }
      }}
    >
      <div className="image-viewer-toolbar">
        {items.length > 1 && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous image"
              onClick={() => move(-1)}
            >
              <ChevronLeft />
            </Button>
            <span className="image-viewer-count" aria-live="polite">
              {index + 1} / {items.length}
            </span>
            <Button variant="ghost" size="icon-sm" aria-label="Next image" onClick={() => move(1)}>
              <ChevronRight />
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom out"
          onClick={() => zoomBy(-SCALE_STEP)}
        >
          <Minus />
        </Button>
        <span className="image-viewer-count" aria-live="polite">
          {Math.round(scale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom in"
          onClick={() => zoomBy(SCALE_STEP)}
        >
          <Plus />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Reset image" onClick={reset}>
          <RotateCcw />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="View fullscreen"
          onClick={() => void viewerRef.current?.requestFullscreen().catch(() => undefined)}
        >
          <Expand />
        </Button>
        {mode === "dialog" && (
          <Button variant="ghost" size="icon-sm" aria-label="Close image viewer" onClick={onClose}>
            <X />
          </Button>
        )}
      </div>

      <div
        className="image-viewer-stage"
        onWheel={(event) => {
          event.preventDefault();
          zoomBy(event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP);
        }}
      >
        <img
          src={item.src}
          alt={item.alt}
          draggable={false}
          className={scale > 1 ? "is-pannable" : undefined}
          style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${scale})` }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
        />
      </div>
    </section>
  );

  if (mode === "page") return content;

  return (
    <dialog
      ref={dialogRef}
      className="image-viewer-dialog"
      aria-label="Image viewer"
      onCancel={(event) => {
        event.preventDefault();
        onClose?.();
      }}
    >
      {content}
    </dialog>
  );
}
