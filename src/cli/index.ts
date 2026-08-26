import fs from "node:fs";
import path from "node:path";
import { canonicalTarget, stateDataPath } from "./paths";
import { ensureDaemonRunning, openBrowser, readServerRecord, isServerAlive } from "./daemon";
import { resolveDiff } from "./git";
import type { ReviewMap } from "../lib/types";

export async function openCommand(files: string[]): Promise<string> {
  if (files.length === 0) {
    console.error("Usage: piew <file-or-url> [more-files...]");
    process.exit(1);
  }

  const validFiles: string[] = [];
  for (const f of files) {
    const target = canonicalTarget(f);
    if (target.kind === "file" && !fs.existsSync(target.value)) {
      console.error(`File not found: ${target.value}`);
      process.exit(1);
    }
    validFiles.push(target.value);
  }

  const daemon = await ensureDaemonRunning();
  const res = await fetch(`http://127.0.0.1:${daemon.port}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files: validFiles }),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(`Failed to create review session: ${err.error || res.statusText}`);
    process.exit(1);
  }

  const body = (await res.json()) as { sessionId: string; path: string; reviewMap: ReviewMap };
  const url = `http://127.0.0.1:${daemon.port}${body.path}`;
  openBrowser(url);

  console.log(`Reviewing ${validFiles.map((f) => path.basename(f)).join(", ")}`);
  console.log(url);
  console.log(`Session: ${body.sessionId}`);
  console.log(`Review Map: ${JSON.stringify(body.reviewMap)}`);
  console.log(`\nWaiting for feedback? Run:\n  piew poll ${body.sessionId}`);

  return body.sessionId;
}

export async function diffCommand(
  range: string,
  options: { staged?: boolean } = {}
): Promise<string | null> {
  let resolved: ReturnType<typeof resolveDiff>;
  try {
    resolved = resolveDiff(range, { staged: options.staged });
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
    return null;
  }

  if (resolved.files.length === 0) {
    console.log(`No changes in ${resolved.range}`);
    return null;
  }

  const daemon = await ensureDaemonRunning();
  const res = await fetch(`http://127.0.0.1:${daemon.port}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ diff: resolved }),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(`Failed to create review session: ${err.error || res.statusText}`);
    process.exit(1);
  }

  const body = (await res.json()) as { sessionId: string; path: string; reviewMap: ReviewMap };
  const url = `http://127.0.0.1:${daemon.port}${body.path}`;
  openBrowser(url);

  console.log(`Reviewing ${resolved.files.length} file(s) in ${resolved.range}`);
  console.log(url);
  console.log(`Session: ${body.sessionId}`);
  console.log(`Review Map: ${JSON.stringify(body.reviewMap)}`);
  console.log(`\nWaiting for feedback? Run:\n  piew poll ${body.sessionId}`);

  return body.sessionId;
}

export async function mapCommand(sessionId: string, raw: string): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error: any) {
    console.error(`Could not read the Review Map JSON: ${error.message}`);
    process.exit(1);
    return;
  }
  const daemon = await ensureDaemonRunning();
  const response = await fetch(`http://127.0.0.1:${daemon.port}/api/session/${sessionId}/map`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    reviewMap?: { items?: unknown[] };
  };
  if (!response.ok) {
    console.error(`Review Map update failed: ${body.error || response.statusText}`);
    process.exit(1);
  }
  console.log(`Updated ${body.reviewMap?.items?.length ?? 0} Review Map items`);
}

export async function pollCommand(
  sessionId: string,
  options: { ack?: boolean; timeoutSecs?: number } = {}
) {
  const daemon = await ensureDaemonRunning();

  process.stderr.write(
    `Waiting for feedback in ${sessionId} (comment in browser, then click Send Feedback)...\n`
  );

  // The server caps a single wait below Bun's idleTimeout, so a longer request is
  // served by repeating it until the caller's own deadline runs out.
  const deadline = options.timeoutSecs ? Date.now() + options.timeoutSecs * 1000 : 0;
  let ack = options.ack;

  while (true) {
    const remainingSecs = deadline ? Math.ceil((deadline - Date.now()) / 1000) : 0;
    if (deadline && remainingSecs <= 0) {
      process.stdout.write(
        `${JSON.stringify({ status: "timeout", waited_seconds: options.timeoutSecs }, null, 2)}\n`
      );
      return;
    }

    const query = new URLSearchParams({
      ...(ack ? { ack: "1" } : {}),
      ...(remainingSecs ? { timeout: String(remainingSecs) } : {}),
    });

    let batch: any;
    try {
      const res = await fetch(
        `http://127.0.0.1:${daemon.port}/api/session/${sessionId}/poll?${query.toString()}`
      );
      if (!res.ok) {
        process.stderr.write(`Poll error: ${res.statusText}\n`);
        process.exit(1);
      }
      batch = await res.json();
    } catch (err: any) {
      process.stderr.write(`Connection failed: ${err.message}\n`);
      process.exit(1);
    }

    if (batch?.status !== "timeout") {
      process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`);
      return;
    }

    // The batch this call acked is gone; repeating the ack would clear the next one.
    ack = false;
  }
}

/**
 * The agent's half of the transcript: what it did with each delivered annotation.
 * The payload is read from stdin so a note can hold newlines and quotes freely.
 */
export async function respondCommand(sessionId: string, raw: string) {
  let payload: { note?: string; items?: unknown[] };
  try {
    payload = JSON.parse(raw);
  } catch (err: any) {
    console.error(`Could not read the response JSON: ${err.message}`);
    process.exit(1);
    return;
  }

  const daemon = await ensureDaemonRunning();
  const res = await fetch(`http://127.0.0.1:${daemon.port}/api/session/${sessionId}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = (await res.json().catch(() => ({}))) as { error?: string; unknown?: string[] };
  if (!res.ok) {
    console.error(`Respond failed: ${body.error || res.statusText}`);
    process.exit(1);
  }

  if (body.unknown?.length) {
    console.error(`Not delivered to you, so ignored: ${body.unknown.join(", ")}`);
  }
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
}

export async function statusCommand(sessionId: string) {
  const saved = readServerRecord();

  if (saved && (await isServerAlive(saved.port))) {
    const res = await fetch(`http://127.0.0.1:${saved.port}/api/session/${sessionId}/status`);
    if (res.ok) {
      const data = await res.json();
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      return;
    }
  }

  // Server offline fallback
  let data: any = { sessions: {} };
  try {
    data = JSON.parse(fs.readFileSync(stateDataPath(), "utf8"));
  } catch {}

  const session = data.sessions?.[sessionId];
  const pending = session?.pendingBatch;
  const pages = Object.values(session?.pages ?? {}) as Array<{ comments: any[]; edits: any[] }>;

  const payload = {
    status: pending ? "feedback-waiting" : "idle",
    feedback_waiting: !!pending,
    agent_listening: false,
    server_running: false,
    unsent: {
      comments: pages.reduce(
        (sum, page) => sum + page.comments.filter((item) => !item.sent).length,
        0
      ),
      edits: pages.reduce((sum, page) => sum + page.edits.filter((item) => !item.sent).length, 0),
    },
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
