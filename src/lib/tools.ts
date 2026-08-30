import fs from "node:fs";
import path from "node:path";
import { toolsDir } from "../cli/paths";

export const MAX_TOOL_FILE_BYTES = 256 * 1024;
export const MAX_TOOL_INPUT_BYTES = 1024 * 1024;

export interface ToolMetadata {
  schemaVersion: 1;
  name: string;
  description: string;
  when: string;
  entry: string;
  instructions: string;
}

export interface ToolPackage extends ToolMetadata {
  directory: string;
  entryPath: string;
  instructionsPath: string;
  files: string[];
  bytes: number;
}

export class ToolPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolPackageError";
  }
}

export interface ToolDiscovery {
  packages: ToolPackage[];
  invalid: string[];
}

const STARTER_PACKAGES: Array<{
  metadata: ToolMetadata;
  instructions: string;
  source: string;
}> = [
  {
    metadata: {
      schemaVersion: 1,
      name: "question",
      description: "Ask the reviewer to choose",
      when: "A human decision blocks progress",
      entry: "Tool.tsx",
      instructions: "instructions.md",
    },
    instructions: `Use when a human decision blocks progress.

Request JSON:
{"prompt":"What should happen?","data":{"choices":["keep","change"]}}

Invoke:
echo '<request-json>' | piew tools question <session-id>`,
    source: `import { definePiewTool } from "@derhub/piew/tool";

export default definePiewTool<{ choices: string[] }, string>({
  component({ data, submit }) {
    return data.choices.map((choice) => (
      <button key={choice} onClick={() => submit(choice)}>{choice}</button>
    ));
  },
});
`,
  },
  {
    metadata: {
      schemaVersion: 1,
      name: "rating",
      description: "Ask the reviewer for a rating",
      when: "A scored human judgment is needed",
      entry: "Tool.tsx",
      instructions: "instructions.md",
    },
    instructions: `Use when a scored human judgment is needed.

Request JSON:
{"prompt":"Rate this proposal","data":{"min":1,"max":5}}

Invoke:
echo '<request-json>' | piew tools rating <session-id>`,
    source: `import { definePiewTool } from "@derhub/piew/tool";

export default definePiewTool<{ min: number; max: number }, number>({
  component({ data, submit }) {
    return Array.from({ length: data.max - data.min + 1 }, (_, i) => data.min + i).map((value) => (
      <button key={value} onClick={() => submit(value)}>{value}</button>
    ));
  },
});
`,
  },
  {
    metadata: {
      schemaVersion: 1,
      name: "button",
      description: "Offer a labeled action",
      when: "A single explicit action is needed",
      entry: "Tool.tsx",
      instructions: "instructions.md",
    },
    instructions: `Use when one explicit human action is needed.

Request JSON:
{"prompt":"Approve this change","data":{"label":"Approve","value":"approve"}}

Invoke:
echo '<request-json>' | piew tools button <session-id>`,
    source: `import { definePiewTool } from "@derhub/piew/tool";

export default definePiewTool<{ label: string; value: string }, string>({
  component({ data, submit }) {
    return <button onClick={() => submit(data.value)}>{data.label}</button>;
  },
});
`,
  },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function regularFile(file: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new ToolPackageError(`${label} is missing`);
  }
  if (stat.isSymbolicLink()) throw new ToolPackageError(`${label} must not be a symlink`);
  if (!stat.isFile()) throw new ToolPackageError(`${label} must be a regular file`);
}

function safeRelativePath(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.includes("\\")
  ) {
    throw new ToolPackageError(`${field} must be a relative path`);
  }
  const normalized = value;
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new ToolPackageError(`${field} contains an unsafe path`);
  }
  return normalized;
}

function within(directory: string, relative: string, field: string): string {
  const resolved = path.resolve(directory, relative);
  const relativeToDirectory = path.relative(directory, resolved);
  if (
    !relativeToDirectory ||
    relativeToDirectory === ".." ||
    relativeToDirectory.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToDirectory)
  ) {
    throw new ToolPackageError(`${field} resolves outside its package`);
  }
  return resolved;
}

function collectFiles(directory: string, current = directory): { files: string[]; bytes: number } {
  const files: string[] = [];
  let bytes = 0;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new ToolPackageError(`${file} must not be a symlink`);
    if (entry.isDirectory()) {
      const nested = collectFiles(directory, file);
      files.push(...nested.files);
      bytes += nested.bytes;
      continue;
    }
    if (!entry.isFile()) throw new ToolPackageError(`${file} must be a regular file`);
    const size = fs.statSync(file).size;
    if (size > MAX_TOOL_FILE_BYTES) {
      throw new ToolPackageError(`${file} exceeds ${MAX_TOOL_FILE_BYTES} byte file limit`);
    }
    files.push(path.relative(directory, file));
    bytes += size;
    if (bytes > MAX_TOOL_INPUT_BYTES) {
      throw new ToolPackageError(`package exceeds ${MAX_TOOL_INPUT_BYTES} byte input limit`);
    }
  }
  return { files, bytes };
}

export function validateToolPackage(directory: string): ToolPackage {
  const packageStat = fs.lstatSync(directory);
  if (packageStat.isSymbolicLink() || !packageStat.isDirectory()) {
    throw new ToolPackageError(`${directory} must be a regular directory`);
  }
  const metadataPath = path.join(directory, "tool.json");
  regularFile(metadataPath, "tool.json");
  const metadataBytes = fs.statSync(metadataPath).size;
  if (metadataBytes > MAX_TOOL_FILE_BYTES) {
    throw new ToolPackageError(`tool.json exceeds ${MAX_TOOL_FILE_BYTES} byte file limit`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch {
    throw new ToolPackageError("tool.json is not valid JSON");
  }
  if (!isObject(raw)) throw new ToolPackageError("tool.json must contain an object");
  if (raw.schemaVersion !== 1) throw new ToolPackageError("tool.json schemaVersion must be 1");
  for (const field of ["name", "description", "when"] as const) {
    if (typeof raw[field] !== "string" || raw[field].trim() === "") {
      throw new ToolPackageError(`tool.json ${field} must be a non-empty string`);
    }
  }
  const name = raw.name as string;
  if (name !== path.basename(directory))
    throw new ToolPackageError("tool.json name must equal package directory");
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name))
    throw new ToolPackageError("tool name contains unsafe characters");
  const entry = safeRelativePath(raw.entry, "entry");
  const instructions = safeRelativePath(raw.instructions, "instructions");
  const entryPath = within(directory, entry, "entry");
  const instructionsPath = within(directory, instructions, "instructions");
  regularFile(entryPath, "entry");
  regularFile(instructionsPath, "instructions");
  const collected = collectFiles(directory);
  if (collected.bytes > MAX_TOOL_INPUT_BYTES) {
    throw new ToolPackageError(`package exceeds ${MAX_TOOL_INPUT_BYTES} byte input limit`);
  }

  return {
    schemaVersion: 1,
    name,
    description: raw.description as string,
    when: raw.when as string,
    entry,
    instructions,
    directory,
    entryPath,
    instructionsPath,
    files: collected.files.sort(),
    bytes: collected.bytes,
  };
}

function writeIfAbsent(file: string, contents: string): void {
  try {
    fs.writeFileSync(file, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export function ensureToolRegistry(directory = toolsDir()): string {
  let created = false;
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ToolPackageError(`${directory} must be a regular directory`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.mkdirSync(directory, { recursive: true });
    created = true;
  }
  if (!created) return directory;

  for (const starter of STARTER_PACKAGES) {
    const packageDirectory = path.join(directory, starter.metadata.name);
    try {
      fs.mkdirSync(packageDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      continue;
    }
    writeIfAbsent(
      path.join(packageDirectory, "tool.json"),
      JSON.stringify(starter.metadata, null, 2) + "\n"
    );
    writeIfAbsent(
      path.join(packageDirectory, starter.metadata.instructions),
      starter.instructions + "\n"
    );
    writeIfAbsent(path.join(packageDirectory, starter.metadata.entry), starter.source);
  }
  return directory;
}

export function discoverToolPackages(directory = toolsDir()): ToolDiscovery {
  ensureToolRegistry(directory);
  const packages: ToolPackage[] = [];
  const invalid: string[] = [];
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const packageDirectory = path.join(directory, entry.name);
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new ToolPackageError("must be a regular directory");
      }
      packages.push(validateToolPackage(packageDirectory));
    } catch (error) {
      invalid.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { packages, invalid };
}

export function readToolInstructions(tool: ToolPackage): string {
  return fs.readFileSync(tool.instructionsPath, "utf8").trimEnd();
}
