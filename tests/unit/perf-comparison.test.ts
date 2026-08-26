import { describe, expect, it } from "bun:test";
import { compareRuns, type PerfRun, verifyRuns } from "../../scripts/perf";

const environment = {
  bun: "1.4.0",
  chromium: "140.0.0",
  os: "darwin-24.6.0",
  arch: "arm64",
};

function run(samples: PerfRun["samples"], workload: PerfRun["workload"] = "markdown"): PerfRun {
  return {
    schema: 1,
    revision: "baseline",
    environment,
    workload,
    samples: {
      uiUsableMs: [100, 100, 100, 100, 100, 100, 100],
      uiInteractionMs: [10, 10, 10, 10, 10, 10, 10],
      apiMs: [5, 5, 5, 5, 5, 5, 5],
      clientHeapMb: [10, 10, 10, 10, 10, 10, 10],
      serverHeapMb: [20, 20, 20, 20, 20, 20, 20],
      clientRetainedHeapMb: [0, 0, 0, 0, 0, 0, 0],
      serverRetainedHeapMb: [0, 0, 0, 0, 0, 0, 0],
      clientHeapSlopeMbPerCycle: [0, 0, 0, 0, 0, 0, 0],
      serverHeapSlopeMbPerCycle: [0, 0, 0, 0, 0, 0, 0],
      transferredJsBytes: [100, 100, 100, 100, 100, 100, 100],
      ...samples,
    },
    resources: { sessions: 0, watchers: 0, sse: 0, pollers: 0, timers: 0 },
  };
}

describe("performance comparison", () => {
  it("accepts a stable candidate with a qualifying gain and no regression", () => {
    const baseline = run({
      uiUsableMs: [100, 101, 99, 100, 100, 101, 99],
      apiMs: [20, 20, 20, 20, 20, 20, 20],
    });
    const candidate = run({
      uiUsableMs: [94, 95, 93, 94, 94, 95, 93],
      apiMs: [20.2, 20.2, 20.2, 20.2, 20.2, 20.2, 20.2],
    });

    expect(compareRuns([baseline], [candidate], "markdown.uiUsableMs")).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("rejects mismatched schemas, environments, workloads, metrics, and sample counts", () => {
    const baseline = run({
      uiUsableMs: [100, 100, 100, 100, 100, 100, 100],
      apiMs: [20, 20, 20, 20, 20, 20, 20],
    });
    const qualifying = run({
      uiUsableMs: [94, 94, 94, 94, 94, 94, 94],
      apiMs: [20, 20, 20, 20, 20, 20, 20],
    });
    const cases: Array<[string, PerfRun]> = [
      ["schema", { ...qualifying, schema: 2 } as unknown as PerfRun],
      ["environment", { ...qualifying, environment: { ...environment, arch: "x64" } }],
      ["workload", { ...qualifying, workload: "diff" }],
      ["metrics", { ...qualifying, samples: { uiUsableMs: qualifying.samples.uiUsableMs } }],
      ["sample count", { ...qualifying, samples: { ...qualifying.samples, apiMs: [20, 20, 20] } }],
    ];

    for (const [expected, candidate] of cases) {
      const result = compareRuns([baseline], [candidate], "markdown.uiUsableMs");
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain(expected);
    }
  });

  it("rejects a coefficient of variation above 10%", () => {
    const baseline = run({
      uiUsableMs: [100, 100, 100, 100, 100, 100, 100],
      apiMs: [20, 20, 20, 20, 20, 20, 20],
    });
    const candidate = run({
      uiUsableMs: [70, 118, 70, 118, 70, 118, 70],
      apiMs: [20, 20, 20, 20, 20, 20, 20],
    });

    const result = compareRuns([baseline], [candidate], "markdown.uiUsableMs");
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("coefficient of variation");
  });

  it("rejects a primary metric whose baseline is zero", () => {
    const baseline = run({ serverRetainedHeapMb: [0, 0, 0, 0, 0, 0, 0] });
    const candidate = run({ serverRetainedHeapMb: [0, 0, 0, 0, 0, 0, 0] });

    expect(
      compareRuns([baseline], [candidate], "markdown.serverRetainedHeapMb").errors.join("\n")
    ).toContain("baseline must be positive");
  });

  it("rejects an under-5% gain or an over-2% regression", () => {
    const baseline = run({
      uiUsableMs: [100, 100, 100, 100, 100, 100, 100],
      apiMs: [20, 20, 20, 20, 20, 20, 20],
    });
    const smallGain = run({
      uiUsableMs: [96, 96, 96, 96, 96, 96, 96],
      apiMs: [20, 20, 20, 20, 20, 20, 20],
    });
    const regression = run({
      uiUsableMs: [94, 94, 94, 94, 94, 94, 94],
      apiMs: [21.5, 21.5, 21.5, 21.5, 21.5, 21.5, 21.5],
    });

    expect(compareRuns([baseline], [smallGain], "markdown.uiUsableMs").errors.join("\n")).toContain(
      "less than 5%"
    );
    expect(
      compareRuns([baseline], [regression], "markdown.uiUsableMs").errors.join("\n")
    ).toContain("more than 2%");
  });

  it("requires the gain only for the selected workload and metric", () => {
    const baseline = [
      run({ uiUsableMs: [100, 100, 100, 100, 100, 100, 100] }),
      run({ uiUsableMs: [200, 200, 200, 200, 200, 200, 200] }, "diff"),
    ];
    const candidate = [
      run({ uiUsableMs: [94, 94, 94, 94, 94, 94, 94] }),
      run({ uiUsableMs: [200, 200, 200, 200, 200, 200, 200] }, "diff"),
    ];

    expect(compareRuns(baseline, candidate, "markdown.uiUsableMs")).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("uses p95 for absolute budgets and stability only for the primary metric", () => {
    const baseline = run({
      uiUsableMs: [100, 100, 100, 100, 100, 100, 100],
      uiInteractionMs: [50, 50, 50, 50, 50, 50, 120],
      serverRetainedHeapMb: [0, 0.1, 0, 0.2, 0, 0.1, 0],
    });
    const candidate = run({
      uiUsableMs: [94, 94, 94, 94, 94, 94, 94],
      uiInteractionMs: [50, 50, 50, 50, 50, 50, 120],
      serverRetainedHeapMb: [0, 0.1, 0, 0.2, 0, 0.1, 0],
    });

    const result = compareRuns([baseline], [candidate], "markdown.uiUsableMs");
    expect(result.errors.join("\n")).toContain("uiInteractionMs exceeds its 100 budget");
    expect(result.errors.join("\n")).not.toContain("serverRetainedHeapMb coefficient");
  });

  it("does not claim a secondary regression from unstable samples", () => {
    const baseline = run({
      uiUsableMs: [100, 100, 100, 100, 100, 100, 100],
      apiMs: [10, 10, 10, 20, 24, 24, 24],
    });
    const candidate = run({
      uiUsableMs: [94, 94, 94, 94, 94, 94, 94],
      apiMs: [10, 10, 10, 21, 24, 24, 24],
    });

    expect(compareRuns([baseline], [candidate], "markdown.uiUsableMs")).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("does not claim a secondary regression below one millisecond", () => {
    const baseline = run({
      uiUsableMs: [100, 100, 100, 100, 100, 100, 100],
      uiInteractionMs: [6.5, 6.6, 6.7, 6.7, 6.8, 7.1, 7.3],
    });
    const candidate = run({
      uiUsableMs: [94, 94, 94, 94, 94, 94, 94],
      uiInteractionMs: [6.7, 6.8, 6.9, 7, 7, 7.1, 7.8],
    });

    expect(compareRuns([baseline], [candidate], "markdown.uiUsableMs")).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("verifies absolute budgets and released resources without requiring a candidate", () => {
    const passing = run({ uiUsableMs: [900, 900, 900, 900, 900, 900, 900] });
    const failing = {
      ...run({ uiUsableMs: [900, 900, 900, 900, 900, 900, 1_001] }),
      resources: { ...passing.resources, watchers: 1 },
    };

    expect(verifyRuns([passing])).toEqual({ ok: true, errors: [] });
    expect(verifyRuns([failing]).errors).toEqual([
      "markdown.uiUsableMs exceeds its 1000 budget",
      "markdown.watchers did not return to zero",
    ]);
  });

  it("rejects an incomplete metric artifact", () => {
    const incomplete = {
      ...run({}),
      samples: { arbitraryMetric: [1, 1, 1, 1, 1, 1, 1] },
    } as PerfRun;

    expect(verifyRuns([incomplete]).errors).toEqual(["markdown metrics mismatch"]);
  });
});
