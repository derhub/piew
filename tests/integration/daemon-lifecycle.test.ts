import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SERVER_PROTOCOL, daemonLockPath, daemonLogPath, stateDir } from "../../src/cli/paths";

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
    expect(daemonLockPath()).toBe(path.join(stateDir(), "daemon.lock"));
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
      expect(JSON.parse(fs.readFileSync(path.join(dir, "daemon.lock"), "utf8")).pid).toBe(
        first.pid
      );
      expect(fs.statSync(path.join(dir, "daemon.log")).size).toBeLessThanOrEqual(1024 * 1024);
      await stopStartedDaemons();
      expect(fs.existsSync(path.join(dir, "daemon.lock"))).toBe(false);
    } finally {
      await stopStartedDaemons();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces a lock owned by a dead process", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piew-daemon-stale-"));
    fs.writeFileSync(
      path.join(dir, "daemon.lock"),
      JSON.stringify({ pid: 2_147_483_647, startedAt: 1 })
    );

    try {
      const record = await startDaemon(dir);
      expect(record.pid).not.toBe(2_147_483_647);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "daemon.lock"), "utf8")).pid).toBe(
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
      expect(JSON.parse(fs.readFileSync(path.join(dir, "daemon.lock"), "utf8")).pid).toBe(
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
      path.join(dir, "daemon.lock"),
      JSON.stringify({ pid: process.pid, startedAt: 1 })
    );

    try {
      const record = await startDaemon(dir);
      expect(record.pid).not.toBe(process.pid);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "daemon.lock"), "utf8")).pid).toBe(
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
      path.join(dir, "server.json"),
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

  it("gracefully stops a reachable daemon with the wrong protocol", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piew-daemon-upgrade-"));
    const token = "old-daemon-token";
    let shutdownToken = "";
    let oldServer: ReturnType<typeof Bun.serve>;
    oldServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health") {
          return Response.json({ ok: true, pid: process.pid, protocol: 3, port: oldServer.port });
        }
        if (url.pathname === "/shutdown" && req.method === "POST") {
          shutdownToken = req.headers.get("x-piew-token") ?? "";
          setTimeout(() => oldServer.stop(true), 0);
          return new Response(null, { status: 202 });
        }
        return new Response(null, { status: 404 });
      },
    });
    fs.writeFileSync(
      path.join(dir, "server.json"),
      JSON.stringify({ port: oldServer.port, protocol: 3, pid: process.pid, token })
    );

    try {
      const record = await startDaemon(dir);
      expect(shutdownToken).toBe(token);
      expect(record.protocol).toBe(4);
    } finally {
      await stopStartedDaemons();
      oldServer.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
