import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import type { DiffFile, DiffStatus } from "../lib/types";

export interface DiffSource {
  repoRoot: string;
  range: string;
  staged: boolean;
  /** True when the new side is the working tree, so the diff can go out of date. */
  liveHead: boolean;
}

export interface ResolvedDiff extends DiffSource {
  files: DiffFile[];
}

export interface DiffOptions {
  staged?: boolean;
  cwd?: string;
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: res.status === 0,
    stdout: res.stdout ?? "",
    stderr: (res.stderr ?? "").trim(),
  };
}

function gitBuffer(args: string[], cwd: string): { ok: boolean; stdout: Buffer } {
  const res = spawnSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return { ok: res.status === 0, stdout: res.stdout ?? Buffer.alloc(0) };
}

export function repoRoot(cwd: string): string {
  const res = git(["rev-parse", "--show-toplevel"], cwd);
  if (!res.ok) {
    throw new Error(`Not a git repository: ${cwd}`);
  }
  return res.stdout.trim();
}

const STATUS_CODES: Record<string, DiffStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "renamed",
  T: "modified",
};

interface Entry {
  status: DiffStatus;
  oldPath?: string;
  newPath?: string;
}

// --name-status -M emits "R096\told\tnew" for renames and "M\tpath" otherwise.
export function parseNameStatus(stdout: string): Entry[] {
  const entries: Entry[] = [];

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0]?.[0] ?? "";
    const status = STATUS_CODES[code];
    if (!status) continue;

    if (status === "renamed" && parts.length >= 3) {
      entries.push({ status, oldPath: parts[1], newPath: parts[2] });
    } else if (status === "added") {
      entries.push({ status, newPath: parts[1] });
    } else if (status === "deleted") {
      entries.push({ status, oldPath: parts[1] });
    } else {
      entries.push({ status, oldPath: parts[1], newPath: parts[1] });
    }
  }

  return entries;
}

// Where each side's bytes live. `git diff` without a range compares the index to
// the working tree, so neither side is a ref; --cached moves the new side to the
// index and the old side to HEAD.
export type Side =
  | { kind: "ref"; ref: string }
  | { kind: "merge-base"; left: string; right: string }
  | { kind: "index" }
  | { kind: "worktree" };

export function endpoints(range: string, staged: boolean): { base: Side; head: Side } {
  if (range) {
    // Three-dot asks git for changes since the merge base, so the old blobs must
    // come from that commit and not from the left ref, which may have moved on.
    if (range.includes("...")) {
      const [left, right] = range.split("...");
      return {
        base: { kind: "merge-base", left: left || "HEAD", right: right || "HEAD" },
        head: { kind: "ref", ref: right || "HEAD" },
      };
    }
    if (range.includes("..")) {
      const [left, right] = range.split("..");
      return {
        base: { kind: "ref", ref: left || "HEAD" },
        head: { kind: "ref", ref: right || "HEAD" },
      };
    }
    // A bare ref means "that commit against the working tree".
    return { base: { kind: "ref", ref: range }, head: { kind: "worktree" } };
  }
  if (staged) {
    return { base: { kind: "ref", ref: "HEAD" }, head: { kind: "index" } };
  }
  return { base: { kind: "index" }, head: { kind: "worktree" } };
}

function resolveSide(side: Side, root: string): Side {
  if (side.kind !== "merge-base") return side;
  const res = git(["merge-base", side.left, side.right], root);
  if (!res.ok) throw new Error(`No merge base for ${side.left}...${side.right}`);
  return { kind: "ref", ref: res.stdout.trim() };
}

/** Git stores no text/binary flag, so the usual heuristic is a NUL in the bytes. */
function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

function readSide(side: Side, filePath: string, root: string): { content?: string; hash?: string } {
  let bytes: Buffer;
  if (side.kind === "worktree") {
    try {
      const fullPath = path.join(root, filePath);
      bytes = fs.lstatSync(fullPath).isSymbolicLink()
        ? Buffer.from(fs.readlinkSync(fullPath))
        : fs.readFileSync(fullPath);
    } catch {
      return {};
    }
  } else {
    if (side.kind === "merge-base") return {};
    const spec = side.kind === "index" ? `:${filePath}` : `${side.ref}:${filePath}`;
    const result = gitBuffer(["show", spec], root);
    if (!result.ok) return {};
    bytes = result.stdout;
  }
  return {
    hash: crypto.createHash("sha1").update(bytes).digest("hex"),
    ...(isBinary(bytes) ? {} : { content: bytes.toString("utf8") }),
  };
}

export function diffArgs(range: string, staged: boolean): string[] {
  const args = ["diff", "--name-status", "-M"];
  if (staged) args.push("--cached");
  if (range) args.push(range);
  return args;
}

/** Path list and statuses only. Blobs are fetched per file when a page is opened. */
export function resolveDiff(range: string, options: DiffOptions = {}): ResolvedDiff {
  const cwd = options.cwd ?? process.cwd();
  const staged = !!options.staged;
  const root = repoRoot(cwd);

  const listed = git(diffArgs(range, staged), root);
  if (!listed.ok) {
    throw new Error(listed.stderr || `git diff failed for range: ${range || "working tree"}`);
  }

  const { head } = endpoints(range, staged);
  const entries = parseNameStatus(listed.stdout);

  if (head.kind === "worktree") {
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], root);
    if (!untracked.ok) throw new Error(untracked.stderr || "git ls-files failed");
    for (const file of untracked.stdout.split("\0")) {
      if (file) entries.push({ status: "added", newPath: file });
    }
  }

  const files: DiffFile[] = entries.map((entry) => ({
    status: entry.status,
    oldPath: entry.oldPath,
    newPath: entry.newPath,
  }));

  return {
    repoRoot: root,
    range: rangeLabel(range, staged),
    staged,
    liveHead: head.kind === "worktree",
    files,
  };
}

/** Fills both blob sides for one file. Undefined content means added, deleted, or binary. */
export function readDiffBlobs(source: DiffSource, file: DiffFile): DiffFile {
  const rawRange =
    source.range === "working-tree" || source.range === "--staged" ? "" : source.range;
  const { base, head } = endpoints(rawRange, source.staged);
  const resolvedBase = resolveSide(base, source.repoRoot);
  const oldSide = file.oldPath ? readSide(resolvedBase, file.oldPath, source.repoRoot) : {};
  const newSide = file.newPath ? readSide(head, file.newPath, source.repoRoot) : {};

  return {
    ...file,
    oldContent: oldSide.content,
    newContent: newSide.content,
    newHash: newSide.hash,
  };
}

export function rangeLabel(range: string, staged: boolean): string {
  if (range) return range;
  return staged ? "--staged" : "working-tree";
}
