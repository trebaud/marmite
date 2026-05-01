import type { SessionPhase, SessionStats } from "./types.ts";

// Tracks per-phase cost/duration history and flags sessions that deviate
// significantly from the running median. Pure functions over a module-local
// history map; reset by reloading the process.

const history: Record<SessionPhase, { cost: number[]; duration: number[] }> = {
  orchestrate: { cost: [], duration: [] },
  build: { cost: [], duration: [] },
  verify: { cost: [], duration: [] },
  fix: { cost: [], duration: [] },
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function detectAnomalies(stats: SessionStats): string[] {
  const flags: string[] = [];
  const h = history[stats.phase];
  const costMed = median(h.cost);
  const durMed = median(h.duration);
  if (h.cost.length >= 3 && costMed > 0 && stats.costUsd > costMed * 3) {
    flags.push(`cost_${(stats.costUsd / costMed).toFixed(1)}x_median`);
  }
  if (h.duration.length >= 3 && durMed > 0 && stats.durationMs > durMed * 3) {
    flags.push(`duration_${(stats.durationMs / durMed).toFixed(1)}x_median`);
  }
  // Track only successful sessions; error sessions skew the baseline.
  if (stats.outcome === "success") {
    h.cost.push(stats.costUsd);
    h.duration.push(stats.durationMs);
    if (h.cost.length > 50) h.cost.shift();
    if (h.duration.length > 50) h.duration.shift();
  }
  return flags;
}

export function annotateAnomalies(stats: SessionStats): void {
  stats.anomalyFlags = detectAnomalies(stats);
}
