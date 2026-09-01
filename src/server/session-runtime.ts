import fs from "node:fs";
import type { ReviewBatch, ReviewSession } from "../lib/types";
import type { FileWatcher } from "./watcher";

export interface PollerRecord {
  resolve: (batch: ReviewBatch | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

type RuntimeSession = {
  sseClients: Set<ReadableStreamDefaultController>;
  pollers: Set<PollerRecord>;
  watchedSources: Set<string>;
};

export type RuntimeCounts = {
  sessions: number;
  sse: number;
  pollers: number;
  timers: number;
};

export class SessionRuntime {
  private sessions = new Map<string, RuntimeSession>();
  private sourceSessions = new Map<string, Set<string>>();

  constructor(private watcher: FileWatcher) {}

  private ensure(sessionId: string): RuntimeSession {
    let runtime = this.sessions.get(sessionId);
    if (!runtime) {
      runtime = { sseClients: new Set(), pollers: new Set(), watchedSources: new Set() };
      this.sessions.set(sessionId, runtime);
    }
    return runtime;
  }

  private releaseSources(sessionId: string, runtime: RuntimeSession): void {
    for (const file of runtime.watchedSources) {
      const sessions = this.sourceSessions.get(file);
      sessions?.delete(sessionId);
      if (!sessions?.size) {
        this.sourceSessions.delete(file);
        this.watcher.unwatch(file);
      }
    }
    runtime.watchedSources.clear();
  }

  private deleteIfIdle(sessionId: string, runtime: RuntimeSession): void {
    if (runtime.sseClients.size || runtime.pollers.size) return;
    this.releaseSources(sessionId, runtime);
    this.sessions.delete(sessionId);
  }

  private addSources(sessionId: string, runtime: RuntimeSession, session: ReviewSession): void {
    for (const page of Object.values(session.pages)) {
      if ((page.kind === "diff" && !page.liveHead) || !fs.existsSync(page.file)) continue;
      if (runtime.watchedSources.has(page.file)) continue;
      let sessions = this.sourceSessions.get(page.file);
      if (!sessions) {
        if (!this.watcher.watch(page.file)) continue;
        sessions = new Set();
        this.sourceSessions.set(page.file, sessions);
      }
      runtime.watchedSources.add(page.file);
      sessions.add(sessionId);
    }
  }

  public connect(
    sessionId: string,
    client: ReadableStreamDefaultController,
    session: ReviewSession
  ): void {
    const runtime = this.ensure(sessionId);
    if (runtime.sseClients.has(client)) return;
    const firstClient = runtime.sseClients.size === 0;
    runtime.sseClients.add(client);
    if (!firstClient) return;
    this.addSources(sessionId, runtime, session);
  }

  public disconnect(sessionId: string, client: ReadableStreamDefaultController): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return;
    runtime.sseClients.delete(client);
    if (runtime.sseClients.size === 0) this.releaseSources(sessionId, runtime);
    this.deleteIfIdle(sessionId, runtime);
  }

  public emit(sessionId: string, event: string, data: unknown): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return;
    const payload = new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const client of runtime.sseClients) {
      try {
        client.enqueue(payload);
      } catch {
        this.disconnect(sessionId, client);
      }
    }
  }

  public sessionsForSource(file: string): readonly string[] {
    return [...(this.sourceSessions.get(file) ?? [])];
  }

  public hasSse(sessionId: string): boolean {
    return !!this.sessions.get(sessionId)?.sseClients.size;
  }

  public refreshSources(sessionId: string, session: ReviewSession): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime?.sseClients.size) return;
    this.releaseSources(sessionId, runtime);
    this.addSources(sessionId, runtime, session);
  }

  public addPoller(sessionId: string, poller: PollerRecord): void {
    this.ensure(sessionId).pollers.add(poller);
  }

  public removePoller(sessionId: string, poller: PollerRecord): void {
    if (poller.timer) {
      clearTimeout(poller.timer);
      poller.timer = null;
    }
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return;
    runtime.pollers.delete(poller);
    this.deleteIfIdle(sessionId, runtime);
  }

  public takePollers(sessionId: string): PollerRecord[] {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return [];
    const pollers = [...runtime.pollers];
    runtime.pollers.clear();
    for (const poller of pollers) {
      if (poller.timer) clearTimeout(poller.timer);
      poller.timer = null;
    }
    this.deleteIfIdle(sessionId, runtime);
    return pollers;
  }

  public hasPollers(sessionId: string): boolean {
    return !!this.sessions.get(sessionId)?.pollers.size;
  }

  public release(sessionId: string): void {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return;
    this.releaseSources(sessionId, runtime);
    for (const client of runtime.sseClients) {
      try {
        client.close();
      } catch {}
    }
    for (const poller of runtime.pollers) {
      if (poller.timer) clearTimeout(poller.timer);
      poller.timer = null;
      poller.resolve(null);
    }
    this.sessions.delete(sessionId);
  }

  public releaseAll(): void {
    for (const sessionId of this.sessions.keys()) this.release(sessionId);
  }

  public counts(): RuntimeCounts {
    let sse = 0;
    let pollers = 0;
    let timers = 0;
    for (const runtime of this.sessions.values()) {
      sse += runtime.sseClients.size;
      pollers += runtime.pollers.size;
      for (const poller of runtime.pollers) timers += poller.timer ? 1 : 0;
    }
    return { sessions: this.sessions.size, sse, pollers, timers };
  }
}
