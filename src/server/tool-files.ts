import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "../cli/paths";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024;
const COMPILER_TIMEOUT_MS = 5_000;
const ALLOWED_PACKAGES = new Set([
  "@derhub/piew/tool",
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom/client",
]);

export class CompilerError extends Error {}

export type CompilerSource = string | { encoding: "base64"; content: string };
export type CompilerInput = { entry: string; files: Record<string, CompilerSource> };
export type ToolArtifact = { digest: string; files: string[]; bytes: number };
export type ArtifactFile = { path: string; content: string | Uint8Array };

type WorkerReply =
  | { ok: true; files: Array<{ path: string; content: string }> }
  | { ok: false; diagnostic: string };

type ArtifactManifest = ToolArtifact & { version: 1 };

function safePath(value: string): boolean {
  return (
    !!value &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value) &&
    !value.split("/").some((part) => !part || part === "." || part === "..")
  );
}

function safeId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function fail(message: string): never {
  throw new CompilerError(message);
}

function clipped(message: string): string {
  return Buffer.from(message).subarray(0, MAX_DIAGNOSTIC_BYTES).toString();
}

function artifactHtml(script: Uint8Array, style?: Uint8Array): string {
  const scriptBase64 = Buffer.from(script).toString("base64");
  const styleBase64 = style ? Buffer.from(style).toString("base64") : "";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html{color-scheme:light dark}body{margin:0;padding:12px;font:14px system-ui,sans-serif}button,input,textarea,select{font:inherit}</style>
</head>
<body><div id="root"></div><script type="module">
const bytes = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const css = ${JSON.stringify(styleBase64)};
if (css) {
  const element = document.createElement("style");
  element.textContent = new TextDecoder().decode(bytes(css));
  document.head.append(element);
}
const source = bytes(${JSON.stringify(scriptBase64)});
await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
</script></body>
</html>`;
}

function validateInput(input: CompilerInput): void {
  if (!input || typeof input !== "object" || !input.files || typeof input.files !== "object") {
    fail("Invalid compiler input");
  }
  if (!safePath(input.entry) || typeof input.files[input.entry] !== "string") {
    fail("Invalid compiler entry");
  }
  let bytes = 0;
  for (const [name, source] of Object.entries(input.files)) {
    if (
      !safePath(name) ||
      /(?:^|\/)(?:package|tsconfig)\.json$|(?:^|\/)bunfig\.toml$/.test(name) ||
      (typeof source !== "string" &&
        (!source || source.encoding !== "base64" || typeof source.content !== "string"))
    ) {
      fail(`Invalid source file: ${name}`);
    }
    const content =
      typeof source === "string" ? Buffer.from(source) : Buffer.from(source.content, "base64");
    const size = content.byteLength;
    if (size > MAX_FILE_BYTES) fail(`Source file exceeds 256 KiB: ${name}`);
    bytes += size;
    if (bytes > MAX_INPUT_BYTES) fail("Compiler input exceeds 1 MiB");
    if (
      (typeof source === "string" && /\b(?:import|require)\s*\(/.test(source)) ||
      (typeof source === "string" &&
        /\b(?:process\.env|Bun\.env|import\.meta\.env)\b/.test(source)) ||
      (typeof source === "string" && /\b(?:macro:|with\s*\{\s*type\s*:\s*["']macro)/.test(source))
    ) {
      fail(`Forbidden source capability: ${name}`);
    }
    if (typeof source !== "string") continue;
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (
        specifier.startsWith("/") ||
        specifier.includes("\\") ||
        /^(?:[a-z][a-z0-9+.-]*:|node:|bun:)/i.test(specifier)
      ) {
        fail(`Forbidden import: ${specifier}`);
      }
      if (!specifier.startsWith(".") && !ALLOWED_PACKAGES.has(specifier)) {
        fail(`Forbidden import: ${specifier}`);
      }
    }
  }
}

export async function compileTool(
  input: CompilerInput
): Promise<ToolArtifact & { contents: ArtifactFile[] }> {
  validateInput(input);
  const worker = fileURLToPath(new URL("./tool-compiler-worker.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, "--no-macros", worker], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  child.stdin.write(JSON.stringify(input));
  child.stdin.end();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(new CompilerError("Tool compiler timed out after 5 seconds"));
        }, COMPILER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const [output, errors] = await Promise.all([stdout, stderr]);
  let reply: WorkerReply;
  try {
    reply = JSON.parse(output) as WorkerReply;
  } catch {
    fail(clipped(errors || "Tool compiler returned invalid output"));
  }
  if (!reply.ok) fail(clipped(reply.diagnostic || "Tool compiler failed"));

  const compiled = reply.files.map((file) => ({
    path: file.path,
    content: Buffer.from(file.content, "base64"),
  }));
  const script = compiled.find((file) => file.path === "tool.js")?.content;
  const style = compiled.find((file) => file.path === "tool.css")?.content;
  if (!script) fail("Compiler produced no JavaScript artifact");
  const contents = [{ path: "index.html", content: artifactHtml(script, style) }];
  const artifact = artifactMetadata(contents);
  return { ...artifact, contents };
}

function artifactRoot(): string {
  return path.join(stateDir(), "state-v4", "tool-artifacts");
}

function plainDirectory(directory: string): boolean {
  const root = artifactRoot();
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const parts = relative ? relative.split(path.sep) : [];
  let current = root;
  for (const part of ["", ...parts]) {
    if (part) current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function plainFile(directory: string, filePath: string): string | undefined {
  if (!plainDirectory(directory) || !safePath(filePath)) return;
  const parts = filePath.split("/");
  let current = directory;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      const final = index === parts.length - 1;
      if (stat.isSymbolicLink() || (final ? !stat.isFile() : !stat.isDirectory())) return;
    } catch {
      return;
    }
  }
  return current;
}

function ensurePlainDirectory(directory: string, recursive = false): void {
  try {
    fs.mkdirSync(directory, { recursive });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Tool artifact path is not a regular directory");
  }
}

function removeOwnedEntry(entry: string): void {
  try {
    const stat = fs.lstatSync(entry);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      fs.rmSync(entry, { recursive: true, force: true });
    } else {
      fs.unlinkSync(entry);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function toolArtifactDir(sessionId: string, interactionId: string): string {
  if (!safeId(sessionId) || !safeId(interactionId))
    throw new Error("Invalid tool artifact identity");
  return path.join(artifactRoot(), sessionId, interactionId);
}

function artifactMetadata(files: ArtifactFile[]): ToolArtifact {
  let bytes = 0;
  const names = new Set<string>();
  const digest = crypto.createHash("sha256");
  for (const file of files) {
    if (!safePath(file.path) || file.path === "manifest.json" || names.has(file.path)) {
      fail(`Invalid artifact file: ${file.path}`);
    }
    const content =
      typeof file.content === "string" ? Buffer.from(file.content) : Buffer.from(file.content);
    bytes += content.byteLength;
    if (bytes > MAX_ARTIFACT_BYTES) fail("Tool artifact exceeds 2 MiB");
    names.add(file.path);
    digest.update(file.path).update("\0").update(content);
  }
  if (!files.length) fail("Tool artifact has no files");
  return { digest: digest.digest("hex"), files: [...names], bytes };
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function writeToolArtifact(
  sessionId: string,
  interactionId: string,
  files: ArtifactFile[]
): ToolArtifact {
  const artifact = artifactMetadata(files);
  const target = toolArtifactDir(sessionId, interactionId);
  if (fs.existsSync(target)) throw new Error("Tool artifact already exists");
  ensurePlainDirectory(artifactRoot(), true);
  ensurePlainDirectory(path.dirname(target));
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(temporary);
  try {
    for (const file of files) {
      const output = path.join(temporary, file.path);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      const descriptor = fs.openSync(output, "wx");
      try {
        fs.writeFileSync(descriptor, file.content);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    const manifest: ArtifactManifest = { version: 1, ...artifact };
    const descriptor = fs.openSync(path.join(temporary, "manifest.json"), "wx");
    try {
      fs.writeFileSync(descriptor, JSON.stringify(manifest));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (!verifiedManifest(temporary)) throw new Error("Invalid tool artifact manifest");
    fsyncDirectory(temporary);
    fs.renameSync(temporary, target);
    fsyncDirectory(path.dirname(target));
    return artifact;
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function manifestFor(directory: string): ArtifactManifest | undefined {
  try {
    const manifestPath = plainFile(directory, "manifest.json");
    if (!manifestPath) return;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ArtifactManifest;
    if (
      manifest.version !== 1 ||
      !Array.isArray(manifest.files) ||
      !manifest.files.length ||
      !manifest.files.every(safePath) ||
      typeof manifest.digest !== "string" ||
      typeof manifest.bytes !== "number"
    ) {
      return undefined;
    }
    return manifest;
  } catch {
    return undefined;
  }
}

function verifiedManifest(directory: string): ArtifactManifest | undefined {
  const manifest = manifestFor(directory);
  if (!manifest) return;
  const files: ArtifactFile[] = [];
  try {
    for (const name of manifest.files) {
      const file = plainFile(directory, name);
      if (!file) return;
      files.push({ path: name, content: fs.readFileSync(file) });
    }
  } catch {
    return;
  }
  const actual = artifactMetadata(files);
  if (
    actual.digest !== manifest.digest ||
    actual.bytes !== manifest.bytes ||
    actual.files.length !== manifest.files.length ||
    actual.files.some((name, index) => name !== manifest.files[index])
  ) {
    return;
  }
  return manifest;
}

export function readToolArtifact(
  sessionId: string,
  interactionId: string,
  requestedPath: string
): Buffer | undefined {
  if (!safePath(requestedPath)) return;
  const directory = toolArtifactDir(sessionId, interactionId);
  const manifest = verifiedManifest(directory);
  if (!manifest || !manifest.files.includes(requestedPath)) return;
  const file = plainFile(directory, requestedPath);
  if (!file) return;
  try {
    return fs.readFileSync(file);
  } catch {
    return;
  }
}

export function deleteToolArtifacts(sessionId: string): void {
  if (!safeId(sessionId)) return;
  if (!plainDirectory(artifactRoot())) return;
  removeOwnedEntry(path.join(artifactRoot(), sessionId));
}

export function deleteToolArtifact(sessionId: string, interactionId: string): void {
  if (!safeId(sessionId) || !safeId(interactionId) || !plainDirectory(artifactRoot())) return;
  const interactionDirectory = toolArtifactDir(sessionId, interactionId);
  const sessionDirectory = path.dirname(interactionDirectory);
  if (!plainDirectory(sessionDirectory)) {
    removeOwnedEntry(sessionDirectory);
    return;
  }
  removeOwnedEntry(interactionDirectory);
}

export function pruneToolArtifacts(
  sessions: Iterable<string> | Map<string, Iterable<string>>
): number {
  const interactions = sessions instanceof Map ? sessions : undefined;
  const keep = new Set(interactions ? interactions.keys() : sessions);
  const root = artifactRoot();
  if (!plainDirectory(root)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const name = entry.name;
    const directory = path.join(root, name);
    if (entry.isSymbolicLink() || !entry.isDirectory() || !safeId(name) || !keep.has(name)) {
      removeOwnedEntry(directory);
      removed++;
      continue;
    }
    const keptInteractions = interactions ? new Set(interactions.get(name) ?? []) : undefined;
    for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
      const interaction = child.name;
      if (
        child.isDirectory() &&
        !child.isSymbolicLink() &&
        safeId(interaction) &&
        (!keptInteractions || keptInteractions.has(interaction))
      ) {
        continue;
      }
      removeOwnedEntry(path.join(directory, interaction));
      removed++;
    }
  }
  return removed;
}
