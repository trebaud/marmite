import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { die } from "../args.ts";

// `marmite stats [path]` — post-run summary over .marmite/events.jsonl.
//
// Computes:
//   - cost grouped by model
//   - p50/p95 phase durations
//   - retry count per phase (attempts > 1)
//   - sensor failure rate
//   - cache-hit ratio across all sessions
//
// If multiple runs share the same events.jsonl, the latest run (by runId)
// is summarized; pass `--run <id>` to pick a specific one, `--all` to fold
// everything together.

interface Args {
  path: string;
  runFilter: "latest" | "all" | { id: string };
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(3);
  let path: string | undefined;
  let runFilter: Args["runFilter"] = "latest";
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-h" || a === "--help") {
      console.log(`Usage: marmite stats [path] [--run <id>|--all] [--json]

Summarizes a .marmite/events.jsonl log. Defaults to ./.marmite/events.jsonl.

Options:
  --run <id>   Restrict to events from a specific runId
  --all        Fold all runs in the file together (default: latest run only)
  --json       Emit machine-readable JSON instead of a formatted table
  -h, --help   Show this help`);
      process.exit(0);
    }
    if (a === "--run") {
      const v = args[++i];
      if (!v) die("--run requires a runId");
      runFilter = { id: v };
      continue;
    }
    if (a === "--all") { runFilter = "all"; continue; }
    if (a === "--json") { json = true; continue; }
    if (a.startsWith("-")) die(`unknown flag: ${a}`);
    if (path !== undefined) die(`unexpected positional arg: ${a}`);
    path = a;
  }
  return {
    path: resolve(path ?? resolve(process.cwd(), ".marmite", "events.jsonl")),
    runFilter,
    json,
  };
}

interface Event {
  ts?: string;
  kind: string;
  runId?: string;
  iteration?: number;
  [k: string]: unknown;
}

function readEvents(path: string): Event[] {
  if (!existsSync(path)) die(`events file not found: ${path}`);
  const text = readFileSync(path, "utf-8");
  const out: Event[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && typeof obj.kind === "string") {
        out.push(obj as Event);
      }
    } catch {
      // skip malformed lines — keep stats robust against partial writes
    }
  }
  return out;
}

function filterByRun(events: Event[], filter: Args["runFilter"]): { runId: string | null; events: Event[] } {
  if (filter === "all") return { runId: null, events };
  if (typeof filter === "object") {
    return { runId: filter.id, events: events.filter((e) => e.runId === filter.id) };
  }
  // latest: pick the runId of the last `run_start` event we see; fall back to
  // the most recent event with a runId stamp.
  let latest: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "run_start" && typeof e.runId === "string") {
      latest = e.runId;
      break;
    }
  }
  if (!latest) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (typeof e.runId === "string") { latest = e.runId; break; }
    }
  }
  if (!latest) return { runId: null, events };
  return { runId: latest, events: events.filter((e) => e.runId === latest) };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

interface Summary {
  runId: string | null;
  totalEvents: number;
  sessionCount: number;
  costByModel: Record<string, { costUsd: number; sessions: number }>;
  phaseDurations: Record<string, { count: number; p50Ms: number; p95Ms: number; totalMs: number }>;
  retriesByPhase: Record<string, number>;
  sensors: { total: number; failed: number; failureRate: number };
  cache: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    outputTokens: number;
    hitRatio: number;
  };
  totalCostUsd: number;
}

export function summarize(events: Event[], runFilter: Args["runFilter"] = "all"): Summary {
  const { runId, events: scoped } = filterByRun(events, runFilter);

  const sessions = scoped.filter((e) => e.kind === "session_result");
  const sensorEnds = scoped.filter((e) => e.kind === "sensor_end");

  const costByModel: Summary["costByModel"] = {};
  let totalCostUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreateTokens = 0;
  const durationsByPhase = new Map<string, number[]>();
  const retriesByPhase: Record<string, number> = {};

  for (const s of sessions) {
    const model = typeof s.model === "string" ? s.model : "unknown";
    const cost = typeof s.costUsd === "number" ? s.costUsd : 0;
    totalCostUsd += cost;
    if (!costByModel[model]) costByModel[model] = { costUsd: 0, sessions: 0 };
    costByModel[model].costUsd += cost;
    costByModel[model].sessions++;

    const phase = typeof s.phase === "string" ? s.phase : "unknown";
    const dur = typeof s.durationMs === "number" ? s.durationMs : 0;
    if (!durationsByPhase.has(phase)) durationsByPhase.set(phase, []);
    durationsByPhase.get(phase)!.push(dur);

    const attempt = typeof s.attempt === "number" ? s.attempt : 0;
    // Treat attempt > 1 as a retry of that phase.
    if (attempt > 1) retriesByPhase[phase] = (retriesByPhase[phase] ?? 0) + 1;

    inputTokens += typeof s.inputTokens === "number" ? s.inputTokens : 0;
    outputTokens += typeof s.outputTokens === "number" ? s.outputTokens : 0;
    cacheReadTokens += typeof s.cacheReadTokens === "number" ? s.cacheReadTokens : 0;
    cacheCreateTokens += typeof s.cacheCreateTokens === "number" ? s.cacheCreateTokens : 0;
  }

  const phaseDurations: Summary["phaseDurations"] = {};
  for (const [phase, durs] of durationsByPhase) {
    const sorted = [...durs].sort((a, b) => a - b);
    const totalMs = sorted.reduce((a, b) => a + b, 0);
    phaseDurations[phase] = {
      count: sorted.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      totalMs,
    };
  }

  const sensorFailed = sensorEnds.filter((e) => typeof e.exitCode === "number" && e.exitCode !== 0).length;
  const sensorTotal = sensorEnds.length;

  const hitDenom = cacheReadTokens + inputTokens;
  const hitRatio = hitDenom === 0 ? 0 : cacheReadTokens / hitDenom;

  return {
    runId,
    totalEvents: scoped.length,
    sessionCount: sessions.length,
    costByModel,
    phaseDurations,
    retriesByPhase,
    sensors: {
      total: sensorTotal,
      failed: sensorFailed,
      failureRate: sensorTotal === 0 ? 0 : sensorFailed / sensorTotal,
    },
    cache: { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, hitRatio },
    totalCostUsd,
  };
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toFixed(0)}s`;
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function fmtPct(r: number): string {
  return `${(r * 100).toFixed(1)}%`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function render(summary: Summary, source: string): void {
  console.log(`Source: ${source}`);
  console.log(`Run:    ${summary.runId ?? "(all runs)"}`);
  console.log(`Events: ${summary.totalEvents}  Sessions: ${summary.sessionCount}`);
  console.log("");

  console.log(`Total cost: ${fmtCost(summary.totalCostUsd)}`);
  if (Object.keys(summary.costByModel).length > 0) {
    console.log("  by model:");
    const rows = Object.entries(summary.costByModel).sort((a, b) => b[1].costUsd - a[1].costUsd);
    for (const [model, m] of rows) {
      console.log(`    ${model.padEnd(24)} ${fmtCost(m.costUsd).padStart(10)}  (${m.sessions} sessions)`);
    }
  }
  console.log("");

  console.log("Phase durations:");
  if (Object.keys(summary.phaseDurations).length === 0) {
    console.log("  (no session_result events)");
  } else {
    const rows = Object.entries(summary.phaseDurations);
    for (const [phase, p] of rows) {
      const retries = summary.retriesByPhase[phase] ?? 0;
      console.log(
        `  ${phase.padEnd(12)} n=${String(p.count).padEnd(4)} p50=${fmtDur(p.p50Ms).padEnd(8)} p95=${fmtDur(p.p95Ms).padEnd(8)} total=${fmtDur(p.totalMs).padEnd(10)} retries=${retries}`,
      );
    }
  }
  console.log("");

  console.log(`Sensors: ${summary.sensors.total} runs, ${summary.sensors.failed} failed (${fmtPct(summary.sensors.failureRate)})`);
  console.log("");

  const ch = summary.cache;
  console.log(
    `Cache: hit_ratio=${fmtPct(ch.hitRatio)}  ` +
      `in=${fmtTokens(ch.inputTokens)} out=${fmtTokens(ch.outputTokens)} ` +
      `cache_read=${fmtTokens(ch.cacheReadTokens)} cache_create=${fmtTokens(ch.cacheCreateTokens)}`,
  );
}

export async function runStats(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const events = readEvents(args.path);
  const summary = summarize(events, args.runFilter);
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  render(summary, args.path);
}
