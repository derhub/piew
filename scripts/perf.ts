import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Browser, CDPSession, Page } from "playwright";
import type { ReviewServer } from "../src/server/server";

export type Workload = "markdown" | "diff" | "multi-root";

export interface PerfRun {
  schema: 1;
  revision: string;
  environment: { bun: string; chromium: string; os: string; arch: string };
  workload: Workload;
  samples: Record<string, number[]>;
  resources: Record<"sessions" | "watchers" | "sse" | "pollers" | "timers", number>;
}

export interface Comparison {
  ok: boolean;
  errors: string[];
}

const metricNames = [
  "uiUsableMs",
  "uiInteractionMs",
  "apiMs",
  "clientHeapMb",
  "serverHeapMb",
  "clientRetainedHeapMb",
  "serverRetainedHeapMb",
  "clientHeapSlopeMbPerCycle",
  "serverHeapSlopeMbPerCycle",
  "transferredJsBytes",
] as const;

const metricBudgets: Record<string, number> = {
  uiUsableMs: 1_000,
  uiInteractionMs: 100,
  apiMs: 25,
  clientRetainedHeapMb: 2,
  serverRetainedHeapMb: 2,
  clientHeapSlopeMbPerCycle: 0.1,
  serverHeapSlopeMbPerCycle: 0.1,
};

const workloads: Workload[] = ["markdown", "diff", "multi-root"];
const mb = 1024 * 1024;

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function p95(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function coefficientOfVariation(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return values.every((value) => value === 0) ? 0 : Infinity;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

function slope(values: number[]): number {
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index++) {
    numerator += (index - xMean) * (values[index] - yMean);
    denominator += (index - xMean) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

async function forEachSequential<T>(
  values: T[],
  task: (value: T, index: number) => Promise<void>,
  index = 0
): Promise<void> {
  if (index === values.length) return;
  await task(values[index], index);
  await forEachSequential(values, task, index + 1);
}

export function verifyRuns(runs: PerfRun[]): Comparison {
  const errors: string[] = [];
  for (const run of runs) {
    if (
      JSON.stringify(Object.keys(run.samples).toSorted()) !==
      JSON.stringify([...metricNames].toSorted())
    ) {
      errors.push(`${run.workload} metrics mismatch`);
      continue;
    }
    for (const [metric, budget] of Object.entries(metricBudgets)) {
      const samples = run.samples[metric];
      if (samples && p95(samples) > budget) {
        errors.push(`${run.workload}.${metric} exceeds its ${budget} budget`);
      }
    }
    for (const [resource, count] of Object.entries(run.resources)) {
      if (count !== 0) errors.push(`${run.workload}.${resource} did not return to zero`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function compareRuns(
  baseline: PerfRun[],
  candidate: PerfRun[],
  primary: `${Workload}.${string}`
): Comparison {
  const errors: string[] = [];
  const separator = primary.indexOf(".");
  const primaryWorkload = primary.slice(0, separator) as Workload;
  const primaryMetric = primary.slice(separator + 1);

  const baselineWorkloads = baseline.map((run) => run.workload).toSorted();
  const candidateWorkloads = candidate.map((run) => run.workload).toSorted();
  if (JSON.stringify(baselineWorkloads) !== JSON.stringify(candidateWorkloads)) {
    return { ok: false, errors: ["workload mismatch"] };
  }

  for (const baselineRun of baseline) {
    const candidateRun = candidate.find((run) => run.workload === baselineRun.workload)!;
    if (baselineRun.schema !== candidateRun.schema) {
      errors.push(`${baselineRun.workload} schema mismatch`);
    }
    if (
      Object.keys(baselineRun.environment).some(
        (key) =>
          baselineRun.environment[key as keyof PerfRun["environment"]] !==
          candidateRun.environment[key as keyof PerfRun["environment"]]
      )
    ) {
      errors.push(`${baselineRun.workload} environment mismatch`);
    }
    const baselineMetrics = Object.keys(baselineRun.samples).toSorted();
    const candidateMetrics = Object.keys(candidateRun.samples).toSorted();
    if (JSON.stringify(baselineMetrics) !== JSON.stringify(candidateMetrics)) {
      errors.push(`${baselineRun.workload} metrics mismatch`);
      continue;
    }
    if (
      baselineMetrics.some(
        (metric) => baselineRun.samples[metric].length !== candidateRun.samples[metric].length
      )
    ) {
      errors.push(`${baselineRun.workload} sample count mismatch`);
      continue;
    }

    const isPrimaryWorkload = baselineRun.workload === primaryWorkload;
    if (isPrimaryWorkload && !baselineRun.samples[primaryMetric]) {
      errors.push(`${primary} is not a recorded metric`);
      continue;
    }
    if (isPrimaryWorkload) {
      for (const run of [baselineRun, candidateRun]) {
        if (coefficientOfVariation(run.samples[primaryMetric]) > 0.1) {
          errors.push(`${primary} coefficient of variation exceeds 10%`);
        }
      }
      const baselinePrimary = median(baselineRun.samples[primaryMetric]);
      const candidatePrimary = median(candidateRun.samples[primaryMetric]);
      if (baselinePrimary <= 0) {
        errors.push(`${primary} baseline must be positive`);
      } else if ((baselinePrimary - candidatePrimary) / baselinePrimary < 0.05) {
        errors.push(`${primary} improved by less than 5%`);
      }
    }

    for (const [metric, candidateSamples] of Object.entries(candidateRun.samples)) {
      if (isPrimaryWorkload && metric === primaryMetric) continue;
      const baselineSamples = baselineRun.samples[metric];
      const baselineP95 = p95(baselineSamples);
      const budget = metricBudgets[metric] ?? Infinity;
      if (
        baselineP95 > 0 &&
        baselineP95 <= budget &&
        coefficientOfVariation(baselineSamples) <= 0.1 &&
        coefficientOfVariation(candidateSamples) <= 0.1 &&
        p95(candidateSamples) - baselineP95 >= 1 &&
        p95(candidateSamples) / baselineP95 > 1.02
      ) {
        errors.push(`${baselineRun.workload}.${metric} regressed by more than 2%`);
      }
    }
  }

  if (!baseline.some((run) => run.workload === primaryWorkload)) {
    errors.push(`${primaryWorkload} primary workload is not recorded`);
  }
  errors.push(...verifyRuns(candidate).errors);

  return { ok: errors.length === 0, errors };
}

interface WorkloadFixture {
  workload: Workload;
  body: unknown;
}

interface SessionResponse {
  sessionId: string;
  activePageId: string;
  reviewMap: { items: Array<{ pageId: string; path: string }> };
}

interface Sample {
  uiUsableMs: number;
  uiInteractionMs: number;
  apiMs: number;
  clientHeapMb: number;
  serverHeapMb: number;
  clientRetainedHeapMb: number;
  serverRetainedHeapMb: number;
  clientHeapSlopeMbPerCycle: number;
  serverHeapSlopeMbPerCycle: number;
  transferredJsBytes: number;
}

function command(args: string[], cwd = process.cwd()): string {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function git(args: string[], cwd: string, date?: string): string {
  const env = date
    ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    : process.env;
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function createFixtures(root: string): Promise<WorkloadFixture[]> {
  const markdownDir = path.join(root, "markdown");
  const firstRoot = path.join(root, "workspace-a");
  const secondRoot = path.join(root, "workspace-b");
  const diffRoot = path.join(root, "diff");
  for (const dir of [markdownDir, firstRoot, secondRoot, diffRoot]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const markdown = path.join(markdownDir, "review.md");
  fs.writeFileSync(
    markdown,
    `# Performance review\n\n${"## Section\n\nDeterministic review content.\n\n".repeat(160)}`
  );

  const multiRootFiles: string[] = [];
  for (const [rootDir, prefix] of [
    [firstRoot, "A"],
    [secondRoot, "B"],
  ] as const) {
    for (let index = 0; index < 8; index++) {
      const file = path.join(rootDir, `${prefix.toLowerCase()}-${index}.md`);
      fs.writeFileSync(file, `# Root ${prefix} ${index}\n\n${"Review body.\n\n".repeat(40)}`);
      multiRootFiles.push(file);
    }
  }

  git(["init", "-q", "-b", "main"], diffRoot);
  git(["config", "user.email", "perf@example.com"], diffRoot);
  git(["config", "user.name", "Piew performance"], diffRoot);
  fs.mkdirSync(path.join(diffRoot, "src"));
  for (let index = 0; index < 20; index++) {
    fs.writeFileSync(
      path.join(diffRoot, "src", `file-${index}.ts`),
      `export const value = ${index};\n`.repeat(120)
    );
  }
  git(["add", "."], diffRoot);
  git(["commit", "-qm", "base"], diffRoot, "2026-01-01T00:00:00Z");
  for (let index = 0; index < 20; index++) {
    fs.writeFileSync(
      path.join(diffRoot, "src", `file-${index}.ts`),
      `export const value = ${index + 1};\n`.repeat(120)
    );
  }
  git(["add", "."], diffRoot);
  git(["commit", "-qm", "candidate"], diffRoot, "2026-01-01T00:01:00Z");
  const { resolveDiff } = await import("../src/cli/git");

  return [
    { workload: "markdown", body: { files: [markdown] } },
    { workload: "diff", body: { diff: resolveDiff("HEAD~1..HEAD", { cwd: diffRoot }) } },
    { workload: "multi-root", body: { files: multiRootFiles } },
  ];
}

function collectServerHeap(): number {
  Bun.gc(true);
  return process.memoryUsage().heapUsed / mb;
}

async function collectClientHeap(cdp: CDPSession): Promise<number> {
  await cdp.send("HeapProfiler.collectGarbage");
  const result = (await cdp.send("Performance.getMetrics")) as {
    metrics: Array<{ name: string; value: number }>;
  };
  const heap = result.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value;
  if (heap === undefined) throw new Error("Chromium did not report JSHeapUsedSize");
  return heap / mb;
}

async function waitForRenderedReview(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const content = document.querySelector("main");
        const text = content?.textContent?.trim() ?? "";
        if (text && !text.startsWith("Loading ")) return true;
        return !!content
          ?.querySelector("diffs-container")
          ?.shadowRoot?.querySelector("[data-line]");
      },
      undefined,
      { timeout: 5_000 }
    );
  } catch {
    const body = (await page.locator("body").innerText()).slice(0, 300).replaceAll("\n", " ");
    throw new Error(`review did not render: ${body}`);
  }
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}

async function waitForReview(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForRenderedReview(page);
}

async function sampleWorkload(
  browser: Browser,
  server: ReviewServer,
  port: number,
  fixture: WorkloadFixture
): Promise<Sample> {
  const serverHeapBefore = collectServerHeap();
  const started = performance.now();
  const apiStarted = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fixture.body),
  });
  const apiMs = performance.now() - apiStarted;
  if (!response.ok) throw new Error(`${fixture.workload} session failed: ${response.status}`);
  const session = (await response.json()) as SessionResponse;

  const context = await browser.newContext();
  const page = await context.newPage();
  await waitForReview(page, `http://127.0.0.1:${port}/review/${session.sessionId}`);
  const uiUsableMs = performance.now() - started;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");

  await page.evaluate(() => {
    const state = window as typeof window & { __piewFindStarted?: number; __piewFindMs?: number };
    state.__piewFindStarted = performance.now();
    const observer = new MutationObserver(() => {
      if (!document.querySelector('[aria-label="Find in this page"]')) return;
      requestAnimationFrame(() => {
        state.__piewFindMs = performance.now() - state.__piewFindStarted!;
        observer.disconnect();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await page.keyboard.press("/");
  try {
    await page.waitForFunction(() => "__piewFindMs" in window, undefined, { timeout: 5_000 });
  } catch {
    const state = await page.evaluate(() => ({
      activeElement: document.activeElement?.tagName,
      dialogOpen: !!document.querySelector("dialog[open]"),
      findMounted: !!document.querySelector('[aria-label="Find in this page"]'),
    }));
    throw new Error(`find did not open: ${JSON.stringify(state)}`);
  }
  const uiInteractionMs = await page.evaluate(
    () => (window as typeof window & { __piewFindMs: number }).__piewFindMs
  );
  await page.keyboard.press("Escape");

  const transferredJsBytes = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => (entry as PerformanceResourceTiming).initiatorType === "script")
      .reduce((total, entry) => total + (entry as PerformanceResourceTiming).transferSize, 0)
  );
  const items = session.reviewMap.items;
  let activeIndex = Math.max(
    0,
    items.findIndex((item) => item.pageId === session.activePageId)
  );
  const clientHeaps: number[] = [];
  const serverHeaps: number[] = [];
  const firstMeasuredCycle = Math.max(0, items.length - 2);
  const cycleCount = Math.max(1, items.length * 2 - 1);

  await forEachSequential(Array.from({ length: cycleCount }), async (_, cycle) => {
    if (items.length > 1) {
      activeIndex = (activeIndex + 1) % items.length;
      const next = items[activeIndex];
      const previousHeader = await page.locator('[data-testid="content"] header').textContent();
      await page.getByRole("treeitem", { name: path.basename(next.path), exact: true }).click();
      try {
        await page.waitForFunction(
          (previous) =>
            document.querySelector('[data-testid="content"] header')?.textContent !== previous,
          previousHeader,
          { timeout: 5_000 }
        );
      } catch {
        throw new Error(`page switch ${cycle + 1} did not change the content header`);
      }
      await waitForRenderedReview(page);
    }
    // The first lap initializes each distinct document; measure the complete lap after that.
    if (cycle >= firstMeasuredCycle) {
      clientHeaps.push(await collectClientHeap(cdp));
      serverHeaps.push(collectServerHeap());
    }
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForRenderedReview(page);

  await context.close();
  server.cleanupExpiredSessions(Number.MAX_SAFE_INTEGER);
  const serverHeapAfter = collectServerHeap();

  return {
    uiUsableMs,
    uiInteractionMs,
    apiMs,
    clientHeapMb: clientHeaps.at(-1)!,
    serverHeapMb: serverHeaps.at(-1)!,
    clientRetainedHeapMb: Math.max(0, clientHeaps.at(-1)! - clientHeaps[0]),
    serverRetainedHeapMb: Math.max(0, serverHeapAfter - serverHeapBefore),
    clientHeapSlopeMbPerCycle: Math.max(0, slope(clientHeaps)),
    serverHeapSlopeMbPerCycle: Math.max(0, slope(serverHeaps)),
    transferredJsBytes,
  };
}

async function record(runs: number, output: string): Promise<void> {
  command(["bun", "run", "build"]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piew-perf-"));
  process.env.PIEW_DIR = path.join(root, "state");
  process.env.PIEW_NO_OPEN = "1";

  let browser: Browser | undefined;
  try {
    const fixtures = await createFixtures(root);
    const { chromium } = await import("playwright");
    const activeBrowser = await chromium.launch();
    browser = activeBrowser;
    const environment = {
      bun: Bun.version,
      chromium: activeBrowser.version(),
      os: `${os.platform()}-${os.release()}`,
      arch: os.arch(),
    };
    const revision = command(["git", "rev-parse", "--short=12", "HEAD"]);
    const recorded: PerfRun[] = [];
    const { ReviewServer } = await import("../src/server/server");

    await forEachSequential(fixtures, async (fixture) => {
      const server = new ReviewServer();
      const port = await server.start(5920);
      const samples: Record<string, number[]> = {};
      try {
        await sampleWorkload(activeBrowser, server, port, fixture);
        await forEachSequential(Array.from({ length: runs }), async () => {
          const sample = await sampleWorkload(activeBrowser, server, port, fixture);
          for (const [metric, value] of Object.entries(sample)) {
            (samples[metric] ??= []).push(value);
          }
        });
      } catch (error) {
        throw new Error(
          `${fixture.workload}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      } finally {
        server.cleanupExpiredSessions(Number.MAX_SAFE_INTEGER);
        server.stop();
      }
      recorded.push({
        schema: 1,
        revision,
        environment,
        workload: fixture.workload,
        samples,
        resources: server.resourceCounts(),
      });
    });

    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(recorded, null, 2)}\n`);
    process.stdout.write(`recorded ${runs} runs for ${workloads.join(", ")} in ${output}\n`);
  } finally {
    await browser?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function isPerfRun(value: unknown): value is PerfRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<PerfRun>;
  const environment = run.environment as Partial<PerfRun["environment"]> | undefined;
  const validSamples =
    run.samples &&
    Object.values(run.samples).every(
      (samples) =>
        Array.isArray(samples) &&
        samples.length > 0 &&
        samples.every((sample) => Number.isFinite(sample) && sample >= 0)
    );
  const sampleCounts = run.samples
    ? new Set(Object.values(run.samples).map((samples) => samples.length))
    : new Set();
  const validMetricNames = run.samples
    ? JSON.stringify(Object.keys(run.samples).toSorted()) ===
      JSON.stringify([...metricNames].toSorted())
    : false;
  const resourceNames = ["sessions", "watchers", "sse", "pollers", "timers"];
  const validResources =
    run.resources &&
    resourceNames.every((name) => {
      const count = run.resources?.[name as keyof PerfRun["resources"]];
      return Number.isInteger(count) && count! >= 0;
    });
  return Boolean(
    run.schema === 1 &&
    typeof run.revision === "string" &&
    environment &&
    typeof environment.bun === "string" &&
    typeof environment.chromium === "string" &&
    typeof environment.os === "string" &&
    typeof environment.arch === "string" &&
    workloads.includes(run.workload as Workload) &&
    validSamples &&
    validMetricNames &&
    sampleCounts.size === 1 &&
    validResources
  );
}

function readRuns(file: string): PerfRun[] {
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(value) || value.length === 0 || !value.every(isPerfRun)) {
    throw new Error(`${file} is not a valid performance run`);
  }
  return value;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args[0] === "record") {
    const runs = Number(option(args, "--runs"));
    const output = option(args, "--output");
    if (!Number.isInteger(runs) || runs < 1 || !output) {
      throw new Error("usage: bun run perf -- record --runs <count> --output <file>");
    }
    await record(runs, output);
    return;
  }
  if (args[0] === "compare") {
    const primary = option(args, "--primary");
    if (!primary || !/^(markdown|diff|multi-root)\.[a-zA-Z][a-zA-Z0-9]*$/.test(primary)) {
      throw new Error(
        "usage: bun run perf -- compare <baseline> <candidate> --primary <workload.metric>"
      );
    }
    const result = compareRuns(
      readRuns(args[1]),
      readRuns(args[2]),
      primary as `${Workload}.${string}`
    );
    process.stdout.write(`${result.ok ? "accepted" : result.errors.join("\n")}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (args[0] === "verify" && args.length === 2) {
    const result = verifyRuns(readRuns(args[1]));
    process.stdout.write(`${result.ok ? "accepted" : result.errors.join("\n")}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  throw new Error(
    "usage: bun run perf -- record --runs <count> --output <file> | verify <run> | compare <baseline> <candidate> --primary <workload.metric>"
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
