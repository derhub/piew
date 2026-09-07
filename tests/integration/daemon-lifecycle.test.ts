import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  SERVER_PROTOCOL,
  daemonLockPath,
  daemonLogPath,
  serverRecordPath,
  stateDir,
} from "../../src/cli/paths";

const DAEMON_MODULE = pathToFileURL(path.resolve(__dirname, "../../src/cli/daemon.ts")).href;
const CLI = path.resolve(__dirname, "../../bin/piew.ts");
const startedPids = new Set<number>();

async function startDaemon(dir: string) {
  const script = `
    const { ensureDaemonRunning } = await import(${JSON.stringify(DAEMON_MODULE)});
    console.log(JSON.stringify(await ensureDaemonRunning()));
  `;
  const proc = Bun.spawn(["bun", "--eval", script], {
    env: { ...process.env, PIEW_DIR: dir, PIEW_NO_OPEN: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout);
  const record = JSON.parse(stdout.trim());
  startedPids.add(record.pid);
  return record as { pid: number; port: number; protocol: number; token: string };
}

async function stopProcess(pid: number) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
      await Bun.sleep(25);
    } catch {
      return;
    }
  }
}

async function stopStartedDaemons() {
  await Promise.all([...startedPids].map(stopProcess));
  startedPids.clear();
}

async function restartDaemon(dir: string) {
  const proc = Bun.spawn([process.execPath, CLI, "restart"], {
    env: { ...process.env, PIEW_DIR: dir, PIEW_NO_OPEN: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout);
  const record = JSON.parse(stdout.trim()) as { pid: number; port: number };
  startedPids.add(record.pid);
  return record;
}

describe("daemon lifecycle", () => {
  afterEach(stopStartedDaemons);

  it("uses protocol 4 and keeps lifecycle files in the state directory", () => {
    expect(SERVER_PROTOCOL).toBe(4);
    expect(serverRecordPath()).toBe(path.join(stateDir(), "server-v4.json"));
    expect(daemonLockPath()).toBe(path.join(stateDir(), "daemon-v4.lock"));
    expect(daemonLogPath()).toBe(path.join(stateDir(), "daemon.log"));
  });

  it("concurrent starts converge on the daemon that owns the lifetime lock", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piew-daemon-concurrent-"));
    fs.writeFileSync(path.join(dir, "daemon.log"), "x".repeat(1024 * 1024 + 1));

    try {
      const records = await Promise.all(Array.from({ length: 20 }, () => startDaemon(dir)));
      const first = records[0]!;

      expect(new Set(records.map((record) => record.pid))).toEqual(new Set([first.pid]));
      expect(first.protocol).toBe(4);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "daemon-v4.lock"), "utf8")).pid).toBe(
        first.pid
      );
      expect(fs.statSync(path.join(dir, "daemon.log")).size).toBeLessThanOrEqual(1024 * 1024);
      await stopStartedDaemons();
      expect(fs.existsSync(path.join(dir, "daemon-v4.lock"))).toBe(false);
    } finally {
      await stopStartedDaemons();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces a lock owned by a dead process", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piew-daemon-stale-"));
    fs.writeFileSync(
      path.join(dir, "daemon-v4.lock"),
      JSON.stringify({ pid: 2_147_483_647, startedAt: 1 })
    );

    try {
      const record = await startDaemon(dir);
      expect(record.pid).not.toBe(2_147_483_647);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "daemon-v4.lock"), "utf8")).pid).toBe(
        record.pid
      );
    } finally {
      await stopStartedDaemons();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restarts the running daemon", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piew-daemon-restart-"));

    try {
      const first = await startDaemon(dir);
      const restarted = await restartDaemon(dir);

      expect(restarted.pid).not.toBe(first.pid);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "daemon-v4.lock"), "utf8")).pid).toBe(
        restarted.pid
      );
    } finally {
      await stopStartedDaemons();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restart recovers from a stale lock and record left by a killed daemon", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piew-daemon-killed-"));
    const deadPid = 2_147_483_647;
    const closedServer = Bun.serve({ port: 0, fetch: () => new Response() });
    const closedPort = closedServer.port;
    closedServer.stop(true);

    fs.writeFileSync(
      path.join(dir, "daemon-v4.lock"),
      JSON.stringify({ pid: deadPid, startedAt: 1 })
    );
    fs.writeFileSync(
      path.join(dir, "server-v4.json"),
      JSON.stringify({
        port: closedPort,
        protocol: SERVER_PROTOCOL,
        pid: deadPid,
        token: "dead-token",
      })
    );

    try {
      const restarted = await restartDaemon(dir);

      expect(restarted.pid).not.toBe(deadPid);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "daemon-v4.lock"), "utf8")).pid).toBe(
        restarted.pid
      );
    } finally {
      await stopStartedDaemons();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces an old lock whose PID now belongs to another process", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piew-daemon-reused-pid-"));
    fs.writeFileSync(
      path.join(dir, "daemon-v4.lock"),
      JSON.stringify({ pid: process.pid, startedAt: 1 })
    );

    try {
      const record = await startDaemon(dir);
      expect(record.pid).not.toBe(process.pid);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "daemon-v4.lock"), "utf8")).pid).toBe(
        record.pid
      );
    } finally {
      await stopStartedDaemons();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not trust a same-protocol record for a different process", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piew-daemon-stale-record-"));
    const token = "stale-record-token";
    let shutdownToken = "";
    let staleServer: ReturnType<typeof Bun.serve>;
    staleServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health") {
          return Response.json({ pid: process.pid, protocol: SERVER_PROTOCOL });
        }
        if (url.pathname === "/shutdown" && req.method === "POST") {
          shutdownToken = req.headers.get("x-piew-token") ?? "";
          setTimeout(() => staleServer.stop(true), 0);
          return new Response(null, { status: 202 });
        }
        return new Response(null, { status: 404 });
      },
    });
    fs.writeFileSync(
      path.join(dir, "server-v4.json"),
      JSON.stringify({
        port: staleServer.port,
        protocol: SERVER_PROTOCOL,
        pid: 2_147_483_647,
        token,
      })
    );

    try {
      const record = await startDaemon(dir);
      expect(shutdownToken).toBe(token);
      expect(record.pid).not.toBe(2_147_483_647);
    } finally {
      await stopStartedDaemons();
      staleServer.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("start piew while a daemon of another protocol is running", () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let dir = "";
    let oldServer: ReturnType<typeof Bun.serve>;
    let started: { pid: number; port: number; protocol: number };
    let pushEvent: (text: string) => void = () => {};
    let events: ReadableStreamDefaultReader<Uint8Array>;
    let pollState = "pending";

    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "piew-daemon-foreign-protocol-"));
      oldServer = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/health") {
            return Response.json({ ok: true, pid: process.pid, protocol: 3, port: oldServer.port });
          }
          if (url.pathname === "/api/sessions") {
            return Response.json([{ id: "old-protocol-session" }]);
          }
          if (url.pathname === "/events") {
            return new Response(
              new ReadableStream({
                start(controller) {
                  pushEvent = (text) => controller.enqueue(encoder.encode(text));
                  controller.enqueue(encoder.encode("data: open\n\n"));
                },
              }),
              { headers: { "content-type": "text/event-stream" } }
            );
          }
          if (url.pathname === "/api/poll") return new Promise<Response>(() => {});
          if (url.pathname === "/shutdown" && req.method === "POST") {
            setTimeout(() => oldServer.stop(true), 0);
            return new Response(null, { status: 202 });
          }
          return new Response(null, { status: 404 });
        },
      });
      const base = `http://127.0.0.1:${oldServer.port}`;
      fs.writeFileSync(
        path.join(dir, "server.json"),
        JSON.stringify({
          port: oldServer.port,
          protocol: 3,
          pid: process.pid,
          token: "old-daemon-token",
        })
      );

      events = (await fetch(`${base}/events`)).body!.getReader();
      await events.read();
      void fetch(`${base}/api/poll`).then(
        () => {
          pollState = "resolved";
        },
        () => {
          pollState = "aborted";
        }
      );

      started = await startDaemon(dir);
    });

    afterAll(async () => {
      await events.cancel().catch(() => {});
      oldServer.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("leaves the other daemon serving its own sessions", async () => {
      const response = await fetch(`http://127.0.0.1:${oldServer.port}/api/sessions`);

      expect(await response.json()).toEqual([{ id: "old-protocol-session" }]);
    });

    it("keeps that daemon's open SSE client connected", async () => {
      pushEvent("data: alive\n\n");

      expect(decoder.decode((await events.read()).value)).toBe("data: alive\n\n");
    });

    it("keeps that daemon's in-flight poll unresolved", () => {
      expect(pollState).toBe("pending");
    });

    it("starts a second daemon on its own port and record file", () => {
      expect(started.protocol).toBe(4);
      expect(started.port).not.toBe(oldServer.port);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "server-v4.json"), "utf8")).pid).toBe(
        started.pid
      );
      expect(JSON.parse(fs.readFileSync(path.join(dir, "server.json"), "utf8")).protocol).toBe(3);
    });
  });

  it("points startup failures to the daemon log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piew-daemon-failure-"));
    const logPath = path.join(dir, "daemon.log");
    fs.mkdirSync(logPath);
    const script = `
      const { ensureDaemonRunning } = await import(${JSON.stringify(DAEMON_MODULE)});
      await ensureDaemonRunning();
    `;

    try {
      const proc = Bun.spawn(["bun", "--eval", script], {
        env: { ...process.env, PIEW_DIR: dir, PIEW_NO_OPEN: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain(logPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
