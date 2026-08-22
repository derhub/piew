import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { endpoints, parseNameStatus, readDiffBlobs, resolveDiff } from "../../src/cli/git";

function git(args: string[], cwd: string) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout;
}

describe("parseNameStatus", () => {
  it("keeps a rename as one entry carrying both paths", () => {
    const entries = parseNameStatus("R096\told/name.ts\tnew/name.ts\n");
    expect(entries).toEqual([
      { status: "renamed", oldPath: "old/name.ts", newPath: "new/name.ts" },
    ]);
  });

  it("gives an added file no old path", () => {
    expect(parseNameStatus("A\tsrc/new.ts\n")).toEqual([
      { status: "added", newPath: "src/new.ts" },
    ]);
  });

  it("gives a deleted file no new path", () => {
    expect(parseNameStatus("D\tsrc/gone.ts\n")).toEqual([
      { status: "deleted", oldPath: "src/gone.ts" },
    ]);
  });
});

describe("endpoints", () => {
  it("reads an unstaged diff from the index against the working tree", () => {
    expect(endpoints("", false)).toEqual({ base: { kind: "index" }, head: { kind: "worktree" } });
  });

  it("reads a staged diff from HEAD against the index", () => {
    expect(endpoints("", true)).toEqual({
      base: { kind: "ref", ref: "HEAD" },
      head: { kind: "index" },
    });
  });

  it("reads a bare ref against the working tree", () => {
    expect(endpoints("HEAD~1", false)).toEqual({
      base: { kind: "ref", ref: "HEAD~1" },
      head: { kind: "worktree" },
    });
  });

  it("reads a two-dot range between its two endpoints", () => {
    expect(endpoints("main..feat", false)).toEqual({
      base: { kind: "ref", ref: "main" },
      head: { kind: "ref", ref: "feat" },
    });
  });

  it("reads a three-dot range from the merge base, not the left ref", () => {
    expect(endpoints("main...feat", false)).toEqual({
      base: { kind: "merge-base", left: "main", right: "feat" },
      head: { kind: "ref", ref: "feat" },
    });
  });
});

describe("resolveDiff", () => {
  let repo: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "piew-git-"));
    git(["init", "-q", "-b", "main"], repo);
    git(["config", "user.email", "test@example.com"], repo);
    git(["config", "user.name", "test"], repo);

    fs.writeFileSync(path.join(repo, "kept.ts"), "const a = 1;\n");
    fs.writeFileSync(path.join(repo, "gone.ts"), "const gone = true;\n");
    fs.writeFileSync(path.join(repo, "before.ts"), "const moved = 1;\n");
    fs.writeFileSync(
      path.join(repo, "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02])
    );
    git(["add", "."], repo);
    git(["commit", "-qm", "base"], repo);

    fs.writeFileSync(path.join(repo, "kept.ts"), "const a = 2;\n");
    fs.writeFileSync(path.join(repo, "added.ts"), "const added = true;\n");
    fs.writeFileSync(
      path.join(repo, "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x09, 0x09])
    );
    fs.unlinkSync(path.join(repo, "gone.ts"));
    fs.renameSync(path.join(repo, "before.ts"), path.join(repo, "after.ts"));
    git(["add", "-A"], repo);
    git(["commit", "-qm", "change"], repo);
  });

  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  const resolveWithBlobs = (range: string) => {
    const resolved = resolveDiff(range, { cwd: repo });
    return {
      resolved,
      files: resolved.files.map((f) => readDiffBlobs(resolved, f)),
    };
  };

  const find = (files: any[], name: string) =>
    files.find((f) => f.newPath === name || f.oldPath === name);

  it("includes untracked files in a working-tree diff", () => {
    const file = path.join(repo, "untracked.ts");
    fs.writeFileSync(file, "const untracked = true;\n");

    try {
      const added = find(resolveWithBlobs("").files, "untracked.ts");
      expect(added.status).toBe("added");
      expect(added.oldContent).toBeUndefined();
      expect(added.newContent).toBe("const untracked = true;\n");
    } finally {
      fs.unlinkSync(file);
    }
  });

  it("does not follow an untracked symlink outside the repository", () => {
    const target = path.join(os.tmpdir(), `piew-secret-${crypto.randomUUID()}`);
    const link = path.join(repo, "untracked-link");
    fs.writeFileSync(target, "secret\n");
    fs.symlinkSync(target, link);

    try {
      const added = find(resolveWithBlobs("").files, "untracked-link");
      expect(added.newContent).toBe(target);
    } finally {
      fs.unlinkSync(link);
      fs.unlinkSync(target);
    }
  });

  it("lists paths without reading any blob", () => {
    const resolved = resolveDiff("HEAD~1..HEAD", { cwd: repo });
    for (const file of resolved.files) {
      expect(file.oldContent).toBeUndefined();
      expect(file.newContent).toBeUndefined();
    }
    expect(resolved.files.length).toBeGreaterThan(0);
  });

  it("gives an added file no old content", () => {
    const added = find(resolveWithBlobs("HEAD~1..HEAD").files, "added.ts");
    expect(added.status).toBe("added");
    expect(added.oldContent).toBeUndefined();
    expect(added.newContent).toBe("const added = true;\n");
  });

  it("gives a deleted file no new content", () => {
    const deleted = find(resolveWithBlobs("HEAD~1..HEAD").files, "gone.ts");
    expect(deleted.status).toBe("deleted");
    expect(deleted.newContent).toBeUndefined();
    expect(deleted.oldContent).toBe("const gone = true;\n");
  });

  it("keeps a renamed file as one entry with both sides", () => {
    const renamed = find(resolveWithBlobs("HEAD~1..HEAD").files, "after.ts");
    expect(renamed.status).toBe("renamed");
    expect(renamed.oldPath).toBe("before.ts");
    expect(renamed.newPath).toBe("after.ts");
  });

  it("reads both sides of a modified file", () => {
    const modified = find(resolveWithBlobs("HEAD~1..HEAD").files, "kept.ts");
    expect(modified.oldContent).toBe("const a = 1;\n");
    expect(modified.newContent).toBe("const a = 2;\n");
  });

  it("leaves a binary blob's content unset on both sides", () => {
    const binary = find(resolveWithBlobs("HEAD~1..HEAD").files, "logo.png");
    expect(binary.status).toBe("modified");
    expect(binary.oldContent).toBeUndefined();
    expect(binary.newContent).toBeUndefined();
  });

  it("marks a committed range as fixed and a working-tree range as live", () => {
    expect(resolveDiff("HEAD~1..HEAD", { cwd: repo }).liveHead).toBe(false);
    expect(resolveDiff("", { cwd: repo }).liveHead).toBe(true);
    expect(resolveDiff("HEAD~1", { cwd: repo }).liveHead).toBe(true);
  });

  it("takes the old side of a three-dot range from the merge base", () => {
    git(["checkout", "-qb", "feat"], repo);
    fs.writeFileSync(path.join(repo, "kept.ts"), "const a = 3;\n");
    git(["commit", "-qam", "feat edit"], repo);

    // main moves on after the branch point, touching the same file.
    git(["checkout", "-q", "main"], repo);
    fs.writeFileSync(path.join(repo, "kept.ts"), "const a = 99;\n");
    git(["commit", "-qam", "main edit"], repo);

    const threeDot = find(resolveWithBlobs("main...feat").files, "kept.ts");
    expect(threeDot.oldContent).toBe("const a = 2;\n");

    const twoDot = find(resolveWithBlobs("main..feat").files, "kept.ts");
    expect(twoDot.oldContent).toBe("const a = 99;\n");
  });

  it("refuses a directory that is not a git repository", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "piew-nogit-"));
    expect(() => resolveDiff("", { cwd: bare })).toThrow(/Not a git repository/);
    fs.rmSync(bare, { recursive: true, force: true });
  });
});
