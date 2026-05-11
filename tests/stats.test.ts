import { describe, test, expect } from "bun:test";
import { summarize } from "../src/cli/commands/stats.ts";

// summarize is the pure half of the `marmite stats` command — it eats
// pre-parsed events and returns the rolled-up Summary. We exercise the
// roll-up logic here; the CLI wrapper that reads JSONL from disk is trivial.

function ev(kind: string, extra: Record<string, unknown> = {}) {
  return { kind, ...extra };
}

describe("summarize", () => {
  test("empty input → empty summary", () => {
    const s = summarize([]);
    expect(s.sessionCount).toBe(0);
    expect(s.totalCostUsd).toBe(0);
    expect(s.cache.hitRatio).toBe(0);
    expect(s.sensors.total).toBe(0);
    expect(s.runId).toBe(null);
  });

  test("rolls cost by model across sessions", () => {
    const events = [
      ev("session_result", { model: "sonnet", costUsd: 0.1, phase: "build", durationMs: 1000 }),
      ev("session_result", { model: "sonnet", costUsd: 0.2, phase: "build", durationMs: 1200 }),
      ev("session_result", { model: "haiku", costUsd: 0.05, phase: "verify", durationMs: 500 }),
    ];
    const s = summarize(events);
    expect(s.totalCostUsd).toBeCloseTo(0.35, 6);
    expect(s.costByModel.sonnet?.costUsd).toBeCloseTo(0.3, 6);
    expect(s.costByModel.sonnet?.sessions).toBe(2);
    expect(s.costByModel.haiku?.costUsd).toBeCloseTo(0.05, 6);
  });

  test("p50/p95 phase durations", () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      ev("session_result", {
        model: "m",
        costUsd: 0,
        phase: "build",
        durationMs: (i + 1) * 1000, // 1000, 2000, 3000, 4000, 5000
      }),
    );
    const s = summarize(events);
    expect(s.phaseDurations.build?.count).toBe(5);
    expect(s.phaseDurations.build?.p50Ms).toBe(3000);
    // p95 over [1000,2000,3000,4000,5000] = sorted[4-1=3.8] interpolated = 4800
    expect(s.phaseDurations.build?.p95Ms).toBeCloseTo(4800, 1);
    expect(s.phaseDurations.build?.totalMs).toBe(15000);
  });

  test("counts retries (attempt > 1)", () => {
    const events = [
      ev("session_result", { phase: "verify", attempt: 1, durationMs: 0, costUsd: 0, model: "m" }),
      ev("session_result", { phase: "verify", attempt: 2, durationMs: 0, costUsd: 0, model: "m" }),
      ev("session_result", { phase: "fix", attempt: 3, durationMs: 0, costUsd: 0, model: "m" }),
    ];
    const s = summarize(events);
    expect(s.retriesByPhase.verify).toBe(1);
    expect(s.retriesByPhase.fix).toBe(1);
  });

  test("sensor failure rate", () => {
    const events = [
      ev("sensor_end", { sensor: "eslint", durationMs: 100, exitCode: 0 }),
      ev("sensor_end", { sensor: "tsc", durationMs: 100, exitCode: 1 }),
      ev("sensor_end", { sensor: "vitest", durationMs: 100, exitCode: 2 }),
    ];
    const s = summarize(events);
    expect(s.sensors.total).toBe(3);
    expect(s.sensors.failed).toBe(2);
    expect(s.sensors.failureRate).toBeCloseTo(2 / 3, 6);
  });

  test("cache hit ratio", () => {
    const events = [
      ev("session_result", {
        model: "m",
        costUsd: 0,
        phase: "build",
        durationMs: 0,
        inputTokens: 1000,
        cacheReadTokens: 4000,
      }),
    ];
    const s = summarize(events);
    expect(s.cache.hitRatio).toBeCloseTo(0.8, 6); // 4000 / (4000 + 1000)
  });

  test("filter='latest' picks events for the last run_start runId", () => {
    const events = [
      ev("run_start", { runId: "r-old" }),
      ev("session_result", {
        runId: "r-old",
        model: "m",
        costUsd: 5,
        phase: "build",
        durationMs: 0,
      }),
      ev("run_start", { runId: "r-new" }),
      ev("session_result", {
        runId: "r-new",
        model: "m",
        costUsd: 1,
        phase: "build",
        durationMs: 0,
      }),
    ];
    const s = summarize(events, "latest");
    expect(s.runId).toBe("r-new");
    expect(s.totalCostUsd).toBe(1);
  });

  test("filter={id} pins to a specific run", () => {
    const events = [
      ev("session_result", {
        runId: "r-a",
        model: "m",
        costUsd: 3,
        phase: "build",
        durationMs: 0,
      }),
      ev("session_result", {
        runId: "r-b",
        model: "m",
        costUsd: 7,
        phase: "build",
        durationMs: 0,
      }),
    ];
    const s = summarize(events, { id: "r-b" });
    expect(s.runId).toBe("r-b");
    expect(s.totalCostUsd).toBe(7);
  });

  test("filter='all' folds across runs", () => {
    const events = [
      ev("session_result", { runId: "x", model: "m", costUsd: 1, phase: "build", durationMs: 0 }),
      ev("session_result", { runId: "y", model: "m", costUsd: 2, phase: "build", durationMs: 0 }),
    ];
    const s = summarize(events, "all");
    expect(s.runId).toBe(null);
    expect(s.totalCostUsd).toBe(3);
  });
});
