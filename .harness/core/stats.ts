import type { RunStats, SessionPhase, SessionStats, StoryOutcome } from "./types.ts";
import { annotateAnomalies, emitEvent, logSessionReport } from "./logger.ts";
import type { SessionResult } from "./session.ts";

export function recordSession(
  runStats: RunStats,
  sessionResult: SessionResult,
  phase: SessionPhase,
  iteration: number,
  storyId: string,
  attempt?: number,
): SessionStats {
  const stats: SessionStats = {
    phase,
    iteration,
    attempt,
    storyId,
    outcome: sessionResult.outcome,
    errorMessage: sessionResult.errorMessage,
    anomalyFlags: [],
    ...sessionResult.stats,
  };
  annotateAnomalies(stats);
  runStats.sessions.push(stats);
  logSessionReport(stats);
  emitEvent("session_result", {
    phase,
    iteration,
    attempt,
    storyId,
    outcome: stats.outcome,
    costUsd: stats.costUsd,
    durationMs: stats.durationMs,
    numTurns: stats.numTurns,
    anomalyFlags: stats.anomalyFlags,
    errorMessage: stats.errorMessage,
  });
  return stats;
}

export function iterationCost(runStats: RunStats, iteration: number): number {
  return runStats.sessions
    .filter((s) => s.iteration === iteration)
    .reduce((sum, s) => sum + s.costUsd, 0);
}

export function finalizeStoryOutcome(
  runStats: RunStats,
  storyId: string,
  iteration: number,
  passed: boolean,
  reason?: string,
): void {
  const cost = iterationCost(runStats, iteration);
  const outcome: StoryOutcome = { storyId, passed, reason, iteration, costUsd: cost };
  runStats.storyOutcomes.push(outcome);
  if (passed) runStats.storiesPassed++;
  else runStats.storiesFailed++;
  emitEvent("story_outcome", outcome as unknown as Record<string, unknown>);
}
