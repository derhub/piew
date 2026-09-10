import { describe, expect, it, spyOn } from "bun:test";
import { Telemetry } from "../../src/server/telemetry";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("diagnose a slow review", () => {
  it("releases shutdown when an exporter never settles", async () => {
    let deadline: (() => void) | undefined;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      deadline = callback;
      return 1;
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    try {
      const telemetry = new Telemetry({
        send: (async () => new Promise(() => undefined)) as typeof fetch,
      });
      const stopping = telemetry.stop();
      expect(typeof deadline).toBe("function");
      deadline?.();
      await stopping;
    } finally {
      timer.mockRestore();
      clear.mockRestore();
    }
  });
  it("keeps a bounded local log when export is offline", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piew-telemetry-"));
    const logPath = path.join(dir, "telemetry.log");
    fs.writeFileSync(logPath, "x".repeat(1024 * 1024));
    const telemetry = new Telemetry({
      logPath,
      send: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    try {
      await telemetry.request(
        new Request("http://localhost/health"),
        async () => new Response("ok")
      );
      await telemetry.flush();
      const log = fs.readFileSync(logPath, "utf8");
      expect({
        rotated: fs.existsSync(`${logPath}.1`),
        bounded: log.length < 1024 * 1024,
        event: log.startsWith("{") ? JSON.parse(log).attributes[0].value.stringValue : null,
      }).toEqual({ rotated: true, bounded: true, event: "piew.request" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("flushes shutdown after an export already in flight", async () => {
    const events: string[][] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const telemetry = new Telemetry({
      send: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        events.push(
          body.resourceLogs[0].scopeLogs[0].logRecords.map(
            (record: any) => record.attributes[0].value.stringValue
          )
        );
        await pending;
        return new Response("{}");
      }) as typeof fetch,
    });
    await telemetry.request(new Request("http://localhost/health"), async () => new Response("ok"));
    const exporting = telemetry.flush();
    const stopping = telemetry.stop();
    release();
    await Promise.all([exporting, stopping]);
    expect(events).toEqual([["piew.request"], ["piew.stop"]]);
  });
  it("exports request timing without private URL or error content", async () => {
    const batches: unknown[] = [];
    let now = 10;
    const telemetry = new Telemetry({
      now: () => now,
      send: (async (_url, init) => {
        batches.push(JSON.parse(String(init?.body)));
        return new Response("{}");
      }) as typeof fetch,
    });
    const req = new Request("http://localhost/api/session/s_private/page/p_secret?path=private.md");
    await expect(
      telemetry.request(req, async () => {
        now = 35;
        throw new Error("private document contents");
      })
    ).rejects.toThrow("private document contents");
    await telemetry.flush();
    const records = (batches[0] as any)?.resourceLogs[0].scopeLogs[0].logRecords;
    expect(records?.map((record: any) => record.attributes)).toEqual([
      [
        { key: "event.name", value: { stringValue: "piew.request" } },
        { key: "route", value: { stringValue: "page" } },
        { key: "method", value: { stringValue: "GET" } },
        { key: "status_code", value: { doubleValue: 500 } },
        { key: "duration_ms", value: { doubleValue: 25 } },
      ],
    ]);
  });

  it("bounds queued events while the collector is unavailable", async () => {
    const sizes: number[] = [];
    const telemetry = new Telemetry({
      send: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        sizes.push(body.resourceLogs[0].scopeLogs[0].logRecords.length);
        throw new Error("offline");
      }) as typeof fetch,
    });
    for (let i = 0; i < 250; i++) {
      await telemetry.request(
        new Request("http://localhost/health"),
        async () => new Response("ok")
      );
    }
    await telemetry.flush();
    await telemetry.flush();
    expect(sizes).toEqual([200]);
  });

  it("accepts only bounded same-origin browser measurements", async () => {
    const telemetry = new Telemetry();
    const request = (body: string, origin = "http://localhost") =>
      new Request("http://localhost/api/telemetry", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body,
      });
    const statuses = await Promise.all(
      [
        request('{"samples":[{"browser_kind":"load","duration_ms":12,"count":1}]}'),
        request('{"samples":[{"browser_kind":"private path","duration_ms":12,"count":1}]}'),
        request('{"samples":[{"browser_kind":"load","duration_ms":-1,"count":1}]}'),
        request('{"samples":[{"browser_kind":"load","duration_ms":12,"count":1,"path":"secret"}]}'),
        request('{"samples":[]}', "https://evil.test"),
        request(" ".repeat(2049)),
      ].map(async (req) => (await telemetry.browser(req)).status)
    );
    expect(statuses).toEqual([204, 400, 400, 400, 403, 413]);
  });
});
