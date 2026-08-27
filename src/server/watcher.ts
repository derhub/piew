import fs from "node:fs";
import crypto from "node:crypto";

export interface WatcherCallback {
  (file: string, content: string, hash: string): void;
}

export class FileWatcher {
  private watched = new Map<
    string,
    { watcher: fs.FSWatcher; timer: ReturnType<typeof setTimeout> | null }
  >();
  private hashes = new Map<string, string>();
  private onReload: WatcherCallback;

  constructor(onReload: WatcherCallback) {
    this.onReload = onReload;
  }

  public hash(text: string): string {
    return crypto.createHash("sha1").update(text).digest("hex");
  }

  public setLastHash(file: string, hash: string) {
    this.hashes.set(file, hash);
  }

  public count() {
    return this.watched.size;
  }

  public watch(file: string) {
    if (this.watched.has(file)) return;
    if (!fs.existsSync(file)) return;

    try {
      const initial = fs.readFileSync(file, "utf8");
      this.hashes.set(file, this.hash(initial));

      const watcher = fs.watch(file, (eventType) => {
        if (eventType !== "change" && eventType !== "rename") return;
        const entry = this.watched.get(file);
        if (!entry) return;

        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          try {
            if (!fs.existsSync(file)) return;
            const current = fs.readFileSync(file, "utf8");
            const newHash = this.hash(current);
            if (this.hashes.get(file) === newHash) return;

            this.hashes.set(file, newHash);
            this.onReload(file, current, newHash);
          } catch {
            // Ignore temporary read lock during save
          }
        }, 150);
      });

      this.watched.set(file, { watcher, timer: null });
    } catch {
      // Ignore initial watch errors
    }
  }

  public unwatch(file: string) {
    const entry = this.watched.get(file);
    if (entry) {
      clearTimeout(entry.timer);
      entry.watcher.close();
      this.watched.delete(file);
      this.hashes.delete(file);
    }
  }

  public closeAll() {
    for (const file of this.watched.keys()) {
      this.unwatch(file);
    }
  }
}
