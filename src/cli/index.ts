import fs from "node:fs";
import path from "node:path";
import { canonicalTarget, stateDir } from "./paths";
import { ensureDaemonRunning, openBrowser, readServerRecord, isServerAlive } from "./daemon";
import { resolveDiff } from "./git";
import type { ReviewMap } from "../lib/types";

function writeJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function projectAgentOutput(value: Record<string, unknown>) {
  const { sent_at, next_step, overall_note, ...output } = value;
  return overall_note ? { ...output, overall_note } : output;
}

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

  const body = (await res.json()) as { sessionId: string; path: string };
  const url = `http://127.0.0.1:${daemon.port}${body.path}`;
  openBrowser(url);

  writeJson({ sessionId: body.sessionId, url });

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

  const body = (await res.json()) as { sessionId: string; path: string };
  const url = `http://127.0.0.1:${daemon.port}${body.path}`;
  openBrowser(url);

  writeJson({ sessionId: body.sessionId, url });

  return body.sessionId;
}

export async function mapCommand(sessionId: string, raw?: string): Promise<void> {
  const daemon = await ensureDaemonRunning();

  if (raw === undefined) {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/api/session/${sessionId}`);
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      reviewMap?: ReviewMap;
    };
    if (!response.ok || !body.reviewMap) {
      console.error(`Review Map lookup failed: ${body.error || response.statusText}`);
      process.exit(1);
      return;
    }
    writeJson(body.reviewMap);
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error: any) {
    console.error(`Could not read the Review Map JSON: ${error.message}`);
    process.exit(1);
    return;
  }
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
      writeJson({ status: "timeout", waited_seconds: options.timeoutSecs });
      return;
    }

    const query = new URLSearchParams({
      ...(ack ? { ack: "1" } : {}),
      ...(remainingSecs ? { timeout: String(remainingSecs) } : {}),
    });

    let batch: Record<string, unknown>;
    try {
      const res = await fetch(
        `http://127.0.0.1:${daemon.port}/api/session/${sessionId}/poll?${query.toString()}`
      );
      if (!res.ok) {
        process.stderr.write(`Poll error: ${res.statusText}\n`);
        process.exit(1);
      }
      batch = (await res.json()) as Record<string, unknown>;
    } catch (err: any) {
      process.stderr.write(`Connection failed: ${err.message}\n`);
      process.exit(1);
    }

    if (batch?.status !== "timeout") {
      writeJson(projectAgentOutput(batch));
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
  writeJson(body);
}

export async function statusCommand(sessionId: string) {
  const saved = readServerRecord();

  if (saved && (await isServerAlive(saved.port))) {
    const res = await fetch(`http://127.0.0.1:${saved.port}/api/session/${sessionId}/status`);
    if (res.ok) {
      const data = await res.json();
      writeJson(data);
      return;
    }
  }

  let session: any;
  try {
    const stored = JSON.parse(
      fs.readFileSync(path.join(stateDir(), "state-v4", "sessions", `${sessionId}.json`), "utf8")
    );
    if (stored.schemaVersion === 4) session = stored.session;
  } catch {}

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
  writeJson(payload);
}

export async function pruneCommand(): Promise<void> {
  const daemon = await ensureDaemonRunning();
  const response = await fetch(`http://127.0.0.1:${daemon.port}/api/sessions`, {
    method: "DELETE",
    headers: { "x-piew-token": daemon.token },
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    sessions?: number;
    files?: number;
  };
  if (!response.ok) {
    console.error(`Prune failed: ${body.error || response.statusText}`);
    process.exit(1);
  }
  writeJson({ sessions: body.sessions ?? 0, files: body.files ?? 0 });
}
