import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunStats, SessionStats } from "./types.ts";

// Reporter is the only channel core uses to surface human-readable output.
// The CLI provides a console-backed implementation (src/cli/logger.ts);
// tests and alternative hosts can pass `silentReporter` or their own.

export type BranchAction = "created" | "switched" | "already_on";

export type Phase = "orchestrate" | "build" | "verify" | "fix";

export interface PhaseStartOpts {
  iteration: number;
  storyId?: string;
  // 1-based attempt index for verify/fix loops.
  attempt?: number;
  // Maximum allowed fix attempts (only set for phase="fix").
  maxAttempts?: number;
}

export interface IterationEndOpts {
  iteration: number;
  storyId: string;
  storyTitle?: string;
  passed: boolean;
  reason?: string;
  durationMs: number;
  costUsd: number;
  fixAttempts: number;
}

export interface Reporter {
  start(maxIterations: number): void;
  iterationStart(iteration: number, max: number, storyId?: string, storyTitle?: string): void;
  iterationEnd(opts: IterationEndOpts): void;
  // Called immediately before each agent session begins so renderers can
  // surface the active step (e.g. spinner in terse mode, banner in verbose).
  phaseStart(phase: Phase, opts: PhaseStartOpts): void;
  complete(iteration: number, max: number): void;
  // Run hit the max-iterations cap without finishing every story.
  maxReached(max: number): void;
  // Run was interrupted (SIGINT/SIGTERM).
  aborted(): void;
  branchSetup(branch: string, action: BranchAction): void;
  // PRD update was committed by the harness — sha is the short hash.
  gitCommit(sha: string, message: string): void;
  feedbackDetected(bytes: number, preview: string): void;
  feedbackForceCleared(): void;
  // Surfaced from events.jsonl during the orchestrate phase (the agent emits
  // these around each sensor it runs via `marmite emit-event`).
  sensorStart(sensor: string, sensorType?: string): void;
  sensorEnd(sensor: string, sensorType: string | undefined, durationMs: number, exitCode: number): void;
  budgetExceeded(storyId: string, spent: number, budget: number): void;
  // Called when a phase hits a transient error and the harness is about to
  // sleep before retrying. Terse renderers should reflect the wait in the
  // active spinner so the user doesn't think the run is hung; verbose
  // renderers log a line.
  transientRetry(attempt: number, delayMs: number, errorKind: "transient_error" | "timeout"): void;
  error(context: string, err: unknown, category: string): void;
  message(msg: SDKMessage, agentLabel: string): void;
  sessionReport(stats: SessionStats): void;
  finalReport(runStats: RunStats): void;
  // Free-form status line for ad-hoc orchestrator output.
  info(message: string): void;
  // Forwarded SDK stderr lines.
  stderr(line: string): void;
}

export const silentReporter: Reporter = {
  start: () => {},
  iterationStart: () => {},
  iterationEnd: () => {},
  phaseStart: () => {},
  complete: () => {},
  maxReached: () => {},
  aborted: () => {},
  branchSetup: () => {},
  gitCommit: () => {},
  feedbackDetected: () => {},
  feedbackForceCleared: () => {},
  sensorStart: () => {},
  sensorEnd: () => {},
  budgetExceeded: () => {},
  transientRetry: () => {},
  error: () => {},
  message: () => {},
  sessionReport: () => {},
  finalReport: () => {},
  info: () => {},
  stderr: () => {},
};
