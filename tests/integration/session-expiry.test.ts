import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../../src/server/store";

describe("session retention", () => {
  it("restores an old session until explicit prune", () => {
    const source = path.join(process.env.PIEW_DIR!, "retained.md");
    fs.writeFileSync(source, "# Retained\n");
    const store = new Store();
    const created = store.createSession([source]);
    store.sessions.get(created.id)!.lastSeen = Date.now() - 365 * 24 * 60 * 60 * 1000;
    store.persist(created.id);

    const restored = new Store();

    expect(restored.sessions.has(created.id)).toBe(true);
  });
});
