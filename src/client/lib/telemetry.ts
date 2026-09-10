export type BrowserTelemetryKind = "load" | "render" | "longtask" | "refresh";

type BrowserTelemetryRuntime = {
  location?: { origin: string };
  PerformanceObserver?: new (
    callback: (list: { getEntries: () => PerformanceEntry[] }) => void
  ) => {
    observe(options: { type: string; buffered?: boolean }): void;
    disconnect(): void;
  };
  fetch?: (input: string, init?: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  setInterval?: (callback: () => void, delay: number) => unknown;
  clearInterval?: (id: unknown) => void;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (id: unknown) => void;
};

export type BrowserTelemetryOptions = BrowserTelemetryRuntime & {
  window?: BrowserTelemetryRuntime;
};

export type BrowserTelemetry = {
  cleanup(): void;
};

const FLUSH_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 1_000;
const MAX_DURATION_MS = 3_600_000;
const MAX_COUNT = 10_000;
const KINDS: BrowserTelemetryKind[] = ["load", "render", "longtask", "refresh"];

type TimedEntry = PerformanceEntry & { loadEventEnd?: number };
type TelemetryResponse = { ok: boolean; json(): Promise<unknown> };

function entryDuration(entry: TimedEntry, navigation = false, paint = false): number | undefined {
  const duration = paint
    ? entry.startTime
    : navigation && entry.loadEventEnd && entry.loadEventEnd > entry.startTime
      ? entry.loadEventEnd - entry.startTime
      : entry.duration;
  return Number.isFinite(duration) && duration >= 0 && duration <= MAX_DURATION_MS
    ? duration
    : undefined;
}

export function startBrowserTelemetry(options: BrowserTelemetryOptions = {}): BrowserTelemetry {
  const runtime = globalThis as unknown as BrowserTelemetryOptions & {
    location?: { origin: string };
    PerformanceObserver?: BrowserTelemetryOptions["PerformanceObserver"];
  };
  const source = options.window ?? runtime;
  const location = options.location ?? source.location;
  const Observer = options.PerformanceObserver ?? source.PerformanceObserver;
  const fetcher = options.fetch ?? source.fetch?.bind(source);
  const setIntervalFn =
    options.setInterval ??
    source.setInterval ??
    ((callback, delay) => globalThis.setInterval(callback, delay));
  const clearIntervalFn =
    options.clearInterval ??
    source.clearInterval ??
    ((id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>));
  const setTimeoutFn =
    options.setTimeout ??
    source.setTimeout ??
    ((callback, delay) => globalThis.setTimeout(callback, delay));
  const clearTimeoutFn =
    options.clearTimeout ??
    source.clearTimeout ??
    ((id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>));
  const samples = new Map<BrowserTelemetryKind, { duration: number; count: number }>();
  const observers: { disconnect(): void }[] = [];
  let enabled = true;
  let configPending = false;
  let requestPending = false;
  let cleanedUp = false;
  let interval: unknown;

  const stopCollection = () => {
    enabled = false;
    for (const observer of observers) observer.disconnect();
    observers.length = 0;
    if (interval !== undefined) clearIntervalFn(interval);
  };

  const record = (kind: BrowserTelemetryKind, duration: number | undefined) => {
    if (cleanedUp || !enabled || duration === undefined) return;
    const previous = samples.get(kind);
    if (previous?.count === MAX_COUNT) return;
    samples.set(kind, {
      duration: previous ? Math.max(previous.duration, duration) : duration,
      count: (previous?.count ?? 0) + 1,
    });
  };

  const sessionResourceKind = (name: string): BrowserTelemetryKind | undefined => {
    if (!location?.origin) return undefined;
    try {
      const url = new URL(name, location.origin);
      if (url.origin !== location.origin || !/^\/api\/session\/[^/]+(?:\/|$)/.test(url.pathname)) {
        return undefined;
      }
      return "refresh";
    } catch {
      return undefined;
    }
  };

  const observe = (type: string, callback: (entry: TimedEntry) => void) => {
    if (!Observer) return;
    try {
      const observer = new Observer((list) => {
        if (cleanedUp) return;
        for (const entry of list.getEntries()) callback(entry as TimedEntry);
      });
      observer.observe({ type, buffered: true });
      observers.push(observer);
    } catch {
      // Browsers expose PerformanceObserver before they expose every entry type.
    }
  };

  observe("navigation", (entry) => record("load", entryDuration(entry, true)));
  observe("longtask", (entry) => record("longtask", entryDuration(entry)));
  // Paint entries are browser paint milestones; they do not measure React CPU time.
  observe("paint", (entry) => record("render", entryDuration(entry, false, true)));
  // Session resources are refresh timings, including initial session/page fetches.
  observe("resource", (entry) => {
    const kind = sessionResourceKind(String(entry.name));
    if (kind) record(kind, entryDuration(entry));
  });

  const request = async <T = TelemetryResponse>(
    input: string,
    init: RequestInit,
    consume: (response: TelemetryResponse) => Promise<T> = async (response) => response as T
  ) => {
    if (!fetcher) return undefined;
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    let timeout: unknown;
    const network = Promise.resolve()
      .then(() => fetcher(input, controller ? { ...init, signal: controller.signal } : init))
      .then(consume)
      .catch(() => undefined);
    const expired = new Promise<undefined>((resolve) => {
      timeout = setTimeoutFn(() => {
        controller?.abort();
        resolve(undefined);
      }, REQUEST_TIMEOUT_MS);
    });
    return Promise.race([network, expired]).finally(() => {
      if (timeout !== undefined) clearTimeoutFn(timeout);
    });
  };

  const checkEnabled = async () => {
    if (!fetcher) return;
    configPending = true;
    const body = await request("/api/telemetry", { method: "GET" }, async (response) => {
      if (!response.ok) return undefined;
      return response.json().catch(() => undefined);
    });
    if (typeof body === "object" && body !== null && "enabled" in body) {
      enabled = (body as { enabled?: unknown }).enabled !== false;
      if (!enabled) {
        samples.clear();
        stopCollection();
      }
    }
    configPending = false;
  };

  const flush = () => {
    if (
      cleanedUp ||
      !fetcher ||
      !enabled ||
      configPending ||
      requestPending ||
      samples.size === 0
    ) {
      return;
    }
    const payload = {
      samples: KINDS.flatMap((kind) => {
        const sample = samples.get(kind);
        return sample
          ? [{ browser_kind: kind, duration_ms: sample.duration, count: sample.count }]
          : [];
      }),
    };
    samples.clear();
    requestPending = true;
    void request("/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).finally(() => {
      requestPending = false;
    });
  };

  interval = setIntervalFn(flush, FLUSH_INTERVAL_MS);
  if (fetcher) {
    void checkEnabled().catch(() => {
      configPending = false;
    });
  }

  return {
    cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      clearIntervalFn(interval);
      for (const observer of observers) observer.disconnect();
      observers.length = 0;
    },
  };
}
