import { ensureDaemonRunning } from "./daemon";
import type { JsonValue } from "../lib/tool-api";
import { discoverToolPackages, readToolInstructions, type ToolPackage } from "../lib/tools";

const MAX_REQUEST_BYTES = 64 * 1024;

export interface ToolInvocationRequest {
  prompt: string;
  data: JsonValue;
  anchor?: { pageId: string; line: number };
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

export function parseToolInvocationRequest(raw: string): ToolInvocationRequest {
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new Error(`request exceeds ${MAX_REQUEST_BYTES} byte limit`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `request is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request must be a JSON object");
  }
  const request = value as Record<string, unknown>;
  if (typeof request.prompt !== "string") throw new Error("request prompt must be a string");
  if (!("data" in request)) throw new Error("request data is required");
  if (!isJsonValue(request.data)) throw new Error("request data must be JSON");
  if (request.anchor !== undefined) {
    const anchor = request.anchor as Record<string, unknown>;
    if (
      !anchor ||
      typeof anchor !== "object" ||
      Array.isArray(anchor) ||
      typeof anchor.pageId !== "string" ||
      anchor.pageId.length === 0 ||
      !Number.isInteger(anchor.line) ||
      (anchor.line as number) < 1
    ) {
      throw new Error("request anchor must contain a pageId and positive line");
    }
  }
  return request as unknown as ToolInvocationRequest;
}

function packageByName(packages: ToolPackage[], name: string): ToolPackage | undefined {
  return packages.find((tool) => tool.name === name);
}

function usage(): void {
  process.stdout.write(
    `Usage: piew tools [<tool> ...] [-h]\n` +
      `       piew tools <tool> <session-id> < request.json\n`
  );
}

function reportInvalid(invalid: string[]): void {
  for (const message of invalid) process.stderr.write(`Invalid tool package: ${message}\n`);
}

async function invokeTool(tool: ToolPackage, sessionId: string, raw: string): Promise<void> {
  let request: ToolInvocationRequest;
  try {
    request = parseToolInvocationRequest(raw);
  } catch (error) {
    process.stderr.write(
      `Tool request failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
    return;
  }
  const daemon = await ensureDaemonRunning();
  const response = await fetch(
    `http://127.0.0.1:${daemon.port}/api/session/${encodeURIComponent(sessionId)}/tool/${encodeURIComponent(tool.name)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    process.stderr.write(
      `Tool invocation failed: ${(body as { error?: string }).error || response.statusText}\n`
    );
    process.exitCode = 1;
    return;
  }
  output(body);
}

export async function toolsCommand(args: string[], rawInput?: string): Promise<void> {
  const wantsHelp = args.includes("-h") || args.includes("--help");
  const positional = args.filter((arg) => !arg.startsWith("-"));
  const unknownOption = args.find((arg) => arg.startsWith("-") && arg !== "-h" && arg !== "--help");
  if (unknownOption) {
    process.stderr.write(`Unknown tools option: ${unknownOption}\n`);
    usage();
    process.exitCode = 1;
    return;
  }

  const discovery = discoverToolPackages();
  if (positional.length === 0) {
    if (wantsHelp) usage();
    else
      for (const tool of discovery.packages)
        process.stdout.write(`${tool.name} - ${tool.description} (${tool.when})\n`);
    reportInvalid(discovery.invalid);
    if (discovery.invalid.length > 0) process.exitCode = 1;
    return;
  }

  if (wantsHelp) {
    for (const name of positional) {
      const tool = packageByName(discovery.packages, name);
      if (!tool) {
        process.stderr.write(`Unknown tool package: ${name}\n`);
        process.exitCode = 1;
        continue;
      }
      process.stdout.write(`${readToolInstructions(tool)}\n`);
    }
    reportInvalid(discovery.invalid);
    if (discovery.invalid.length > 0) process.exitCode = 1;
    return;
  }

  if (positional.length !== 2) {
    usage();
    process.exitCode = 1;
    return;
  }
  const [name, sessionId] = positional;
  const tool = packageByName(discovery.packages, name);
  if (!tool) {
    process.stderr.write(`Unknown tool package: ${name}\n`);
    process.exitCode = 1;
    return;
  }
  reportInvalid(discovery.invalid);
  await invokeTool(tool, sessionId, rawInput ?? (await Bun.stdin.text()));
}
