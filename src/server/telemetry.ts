type LogRecord = {
  timeUnixNano: string;
  attributes: { key: string; value: { stringValue: string } | { doubleValue: number } }[];
};

function requestRoute(pathname: string): string {
  if (["/health", "/events", "/shutdown"].includes(pathname)) return pathname.slice(1);
  if (pathname === "/api/sessions") return "sessions";
  if (/^\/api\/session(?:\/[^/]+)?$/.test(pathname)) return "session";
  const page = pathname.match(/^\/api\/session\/[^/]+\/page\/[^/]+(?:\/([^/]+))?/);
  if (page)
    return ["media", "refresh", "comment", "edit", "viewed"].includes(page[1]) ? page[1] : "page";
  const session = pathname.match(/^\/api\/session\/[^/]+\/([^/]+)/);
  if (session && ["poll", "status", "send", "respond", "tools", "map"].includes(session[1]))
    return session[1];
  return pathname.startsWith("/api/") ? "api.other" : "static";
}

export class Telemetry {
  private records: LogRecord[] = [];
  private flight: Promise<void> | undefined;
  private dropped = 0;
  private errors = 0;
  private requests = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private send: typeof fetch;
  private now: () => number;

  constructor(private options: { send?: typeof fetch; now?: () => number; logPath?: string } = {}) {
    this.send = options.send ?? fetch;
    this.now = options.now ?? (() => performance.now());
  }

  private record(event: string, fields: Record<string, string | number> = {}): void {
    if (this.records.length >= 200) {
      this.dropped++;
      if (event === "piew.request" || event === "piew.browser") return;
      this.records.shift();
    }
    this.records.push({
      timeUnixNano: `${Date.now()}000000`,
      attributes: Object.entries({ "event.name": event, ...fields }).map(([key, value]) => ({
        key,
        value: typeof value === "string" ? { stringValue: value } : { doubleValue: value },
      })),
    });
  }

  start(counts: () => Record<string, number>): void {
    if (this.timer) return;
    const started = this.now();
    let previous = started;
    let sampled = started;
    let lag = 0;
    this.record("piew.start");
    void this.flush();
    this.timer = setInterval(() => {
      const now = this.now();
      lag = Math.max(lag, now - previous - 1000);
      previous = now;
      if (now - sampled < 10_000) return;
      const memory = process.memoryUsage();
      this.record("piew.runtime", {
        ...counts(),
        uptime_ms: now - started,
        rss_bytes: memory.rss,
        heap_used_bytes: memory.heapUsed,
        event_loop_lag_ms: lag,
        requests: this.requests,
        dropped_events: this.dropped,
        export_errors: this.errors,
      });
      sampled = now;
      lag = 0;
      void this.flush();
    }, 1000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    this.record("piew.stop");
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await this.flush();
          await this.flush();
        })(),
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, 1500);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }

  async request(req: Request, handle: () => Promise<Response>): Promise<Response> {
    const started = this.now();
    let status = 500;
    try {
      const response = await handle();
      status = response.status;
      return response;
    } finally {
      this.requests++;
      this.record("piew.request", {
        route: requestRoute(new URL(req.url).pathname),
        method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(req.method)
          ? req.method
          : "OTHER",
        status_code: status,
        duration_ms: Math.max(0, this.now() - started),
      });
    }
  }

  async flush(): Promise<void> {
    if (this.flight) return this.flight;
    if (!this.records.length) return;
    const records = this.records.splice(0);
    this.flight = this.export(records).finally(() => {
      this.flight = undefined;
    });
    return this.flight;
  }

  private async export(records: LogRecord[]): Promise<void> {
    if (this.options.logPath) {
      try {
        const data = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
        const stat = await fs.stat(this.options.logPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        });
        if (stat && stat.size + Buffer.byteLength(data) > 1024 * 1024) {
          await fs.rename(this.options.logPath, `${this.options.logPath}.1`);
        }
        await fs.appendFile(this.options.logPath, data, { mode: 0o600 });
      } catch {
        this.errors++;
      }
    }
    try {
      const response = await this.send("http://127.0.0.1:4318/v1/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(1000),
        body: JSON.stringify({
          resourceLogs: [
            {
              resource: { attributes: [{ key: "service.name", value: { stringValue: "piew" } }] },
              scopeLogs: [{ scope: { name: "piew.performance" }, logRecords: records }],
            },
          ],
        }),
      });
      if (!response.ok) throw new Error("Telemetry export rejected");
      await response.body?.cancel();
    } catch {
      this.errors++;
      this.dropped += records.length;
    }
  }

  async browser(req: Request): Promise<Response> {
    if (req.headers.get("origin") !== new URL(req.url).origin)
      return new Response(null, { status: 403 });
    if (req.headers.get("content-type")?.split(";")[0] !== "application/json")
      return new Response(null, { status: 415 });
    const reader = req.body?.getReader();
    if (!reader) return new Response(null, { status: 400 });
    let size = 0;
    const chunks: Uint8Array[] = [];
    const timeout = setTimeout(() => void reader.cancel().catch(() => undefined), 1000);
    let body: unknown;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2048) {
          void reader.cancel().catch(() => undefined);
          return new Response(null, { status: 413 });
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return new Response(null, { status: 400 });
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
    }
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).length !== 1 ||
      !("samples" in body) ||
      !Array.isArray(body.samples) ||
      body.samples.length > 4
    )
      return new Response(null, { status: 400 });
    for (const sample of body.samples) {
      if (
        !sample ||
        typeof sample !== "object" ||
        Object.keys(sample).sort().join() !== "browser_kind,count,duration_ms" ||
        !["load", "render", "longtask", "refresh"].includes(sample.browser_kind) ||
        typeof sample.duration_ms !== "number" ||
        !Number.isFinite(sample.duration_ms) ||
        sample.duration_ms < 0 ||
        sample.duration_ms > 3_600_000 ||
        !Number.isInteger(sample.count) ||
        sample.count < 1 ||
        sample.count > 10_000
      )
        return new Response(null, { status: 400 });
    }
    for (const sample of body.samples) this.record("piew.browser", sample);
    return new Response(null, { status: 204 });
  }
}
import fs from "node:fs/promises";
