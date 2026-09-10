import { afterEach, describe, expect, it } from "bun:test";
import {
  startBrowserTelemetry,
  type BrowserTelemetryOptions,
} from "../../src/client/lib/telemetry";

type Entry = PerformanceEntry & {
  loadEventEnd?: number;
};

class FakeObserver {
  static instances: FakeObserver[] = [];
  private callback: (list: { getEntries: () => Entry[] }) => void;
  private type = "";
  disconnected = false;

  constructor(callback: (list: { getEntries: () => Entry[] }) => void) {
    this.callback = callback;
    FakeObserver.instances.push(this);
  }

  observe(options: { type: string }) {
    this.type = options.type;
  }

  disconnect() {
    this.disconnected = true;
  }

  emit(entries: Entry[]) {
    this.callback({ getEntries: () => entries });
  }

  static emit(type: string, entries: Entry[]) {
    for (const observer of FakeObserver.instances) {
      if (observer.type === type) observer.emit(entries);
    }
  }
}

const response = (body: unknown) => ({
  ok: true,
  json: async () => body,
});

const entry = (values: Partial<Entry>) => values as Entry;

const settle = () =>
  Array.from({ length: 20 }).reduce((promise) => promise.then(() => undefined), Promise.resolve());

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  FakeObserver.instances = [];
});

describe("collect browser performance diagnostics", () => {
  it("aggregates navigation, paint, longtask, and session resource timings at a ten-second boundary", async () => {
    const calls: { input: string; init?: RequestInit }[] = [];
    const intervals: (() => void)[] = [];
    const options: BrowserTelemetryOptions = {
      location: { origin: "https://review.test" },
      PerformanceObserver: FakeObserver,
      fetch: async (input, init) => {
        calls.push({ input: String(input), init });
        return init?.method === "POST" ? response({}) : response({ enabled: true });
      },
      setInterval: (callback, delay) => {
        expect(delay).toBe(10_000);
        intervals.push(callback);
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {},
    };

    cleanup = startBrowserTelemetry(options).cleanup;
    await settle();
    FakeObserver.emit("navigation", [entry({ duration: 120, startTime: 0, loadEventEnd: 150 })]);
    FakeObserver.emit("paint", [
      entry({ duration: 0, startTime: 8, name: "first-contentful-paint" }),
    ]);
    FakeObserver.emit("longtask", [entry({ duration: 75 })]);
    FakeObserver.emit("resource", [
      entry({ name: "https://review.test/api/session/abc/page/one", duration: 42 }),
      entry({ name: "https://review.test/api/session/abc/page/one/refresh", duration: 18 }),
      entry({ name: "https://other.test/api/session/abc/page/one", duration: 900 }),
      entry({ name: "https://review.test/api/telemetry", duration: 900 }),
    ]);

    intervals[0]();
    await settle();
    expect(calls[1].input).toBe("/api/telemetry");
    expect(calls[1].init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      samples: [
        { browser_kind: "load", duration_ms: 150, count: 1 },
        { browser_kind: "render", duration_ms: 8, count: 1 },
        { browser_kind: "longtask", duration_ms: 75, count: 1 },
        { browser_kind: "refresh", duration_ms: 42, count: 2 },
      ],
    });
  });

  it("sends at most one bounded request while preserving samples collected during an in-flight request", async () => {
    const calls: { input: string; init?: RequestInit }[] = [];
    const intervals: (() => void)[] = [];
    let resolvePost!: () => void;
    const post = new Promise<void>((resolve) => {
      resolvePost = resolve;
    });
    const options: BrowserTelemetryOptions = {
      location: { origin: "https://review.test" },
      PerformanceObserver: FakeObserver,
      fetch: async (input, init) => {
        calls.push({ input: String(input), init });
        if (init?.method === "POST") await post;
        return response({ enabled: true });
      },
      setInterval: (callback) => {
        intervals.push(callback);
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {},
    };

    cleanup = startBrowserTelemetry(options).cleanup;
    await settle();
    FakeObserver.emit("navigation", [entry({ duration: 20 })]);
    intervals[0]();
    await settle();
    FakeObserver.emit("longtask", [entry({ duration: 60 })]);
    intervals[0]();
    expect(calls.filter(({ init }) => init?.method === "POST")).toHaveLength(1);

    resolvePost();
    await settle();
    intervals[0]();
    await settle();
    expect(calls.filter(({ init }) => init?.method === "POST")).toHaveLength(2);
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({
      samples: [{ browser_kind: "longtask", duration_ms: 60, count: 1 }],
    });
  });

  it("disables collection when the server configuration says it is disabled", async () => {
    const calls: { input: string; init?: RequestInit }[] = [];
    const intervals: (() => void)[] = [];
    const options: BrowserTelemetryOptions = {
      location: { origin: "https://review.test" },
      PerformanceObserver: FakeObserver,
      fetch: async (input, init) => {
        calls.push({ input: String(input), init });
        return response({ enabled: false });
      },
      setInterval: (callback) => {
        intervals.push(callback);
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {},
    };

    cleanup = startBrowserTelemetry(options).cleanup;
    await settle();
    FakeObserver.emit("navigation", [entry({ duration: 20 })]);
    intervals[0]();
    await settle();

    expect(calls.filter(({ init }) => init?.method === "POST")).toHaveLength(0);
    expect(FakeObserver.instances.every((observer) => observer.disconnected)).toBe(true);
  });

  it("ignores unsupported observers and failed network requests without throwing", async () => {
    const intervals: (() => void)[] = [];
    const options: BrowserTelemetryOptions = {
      location: { origin: "https://review.test" },
      fetch: async (input, init) => {
        if (init?.method === "POST") throw new Error(`offline: ${String(input)}`);
        throw new Error("offline");
      },
      setInterval: (callback) => {
        intervals.push(callback);
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {},
    };

    cleanup = startBrowserTelemetry(options).cleanup;
    await Promise.resolve();
    intervals[0]();
    await Promise.resolve();
  });

  it("releases a stalled configuration request when its JSON body misses the one-second deadline", async () => {
    const calls: { input: string; init?: RequestInit }[] = [];
    const intervals: (() => void)[] = [];
    const timeouts: (() => void)[] = [];
    const options: BrowserTelemetryOptions = {
      location: { origin: "https://review.test" },
      PerformanceObserver: FakeObserver,
      fetch: async (input, init) => {
        calls.push({ input: String(input), init });
        return init?.method === "POST"
          ? response({})
          : { ok: true, json: () => new Promise<unknown>(() => {}) };
      },
      setInterval: (callback) => {
        intervals.push(callback);
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {},
      setTimeout: (callback, delay) => {
        expect(delay).toBe(1_000);
        timeouts.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => {},
    };

    cleanup = startBrowserTelemetry(options).cleanup;
    await settle();
    FakeObserver.emit("navigation", [entry({ duration: 20 })]);
    intervals[0]();
    expect(calls.filter(({ init }) => init?.method === "POST")).toHaveLength(0);

    timeouts[0]();
    await settle();
    intervals[0]();
    await settle();
    expect(calls.filter(({ init }) => init?.method === "POST")).toHaveLength(1);
  });
});
