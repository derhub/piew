import React from "react";

const KEY = "doc-zoom";
const MIN = 0.8;
const MAX = 1.6;
const STEP = 0.1;

const clamp = (value: number) => Math.min(MAX, Math.max(MIN, Number(value.toFixed(2))));

/** Zoom for the rendered document, persisted so it survives reloads. */
export function useDocZoom() {
  const [zoom, setZoom] = React.useState(() => {
    const stored = Number(localStorage.getItem(KEY));
    return stored ? clamp(stored) : 1;
  });

  React.useEffect(() => {
    localStorage.setItem(KEY, String(zoom));
  }, [zoom]);

  return {
    zoom,
    zoomIn: () => setZoom((z) => clamp(z + STEP)),
    zoomOut: () => setZoom((z) => clamp(z - STEP)),
    reset: () => setZoom(1),
  };
}
