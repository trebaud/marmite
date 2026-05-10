import type { VerificationVerdict } from "./protocol.ts";

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
}

export interface HarnessConfig {
  maxIterations: number;
  appPath: string;
  prdPath: string;
  // Model & pricing
  model: string;
  builderModel: string;
  verifierModel: string;
  orchestratorModel: string;
  pricing: Record<string, ModelPricing>;
  // Timeouts (ms)
  buildTimeoutMs: number;
  verifyTimeoutMs: number;
  fixTimeoutMs: number;
  orchestrateTimeoutMs: number;
  // Retries for transient errors per phase
  maxTransientRetries: number;
  // Cost budget per story (USD). Exceeding aborts remaining fix attempts for that story. 0 disables.
  costBudgetUsdPerStory: number;
  // Total run cost budget (USD). Exceeding halts the run before the next iteration. 0 disables.
  costBudgetUsdTotal: number;
  // Fix loop retry cap
  maxFixAttempts: number;
}

export type SessionPhase = "orchestrate" | "build" | "verify" | "fix";

export type SessionOutcome =
  | "success"
  | "timeout"
  | "transient_error"
  | "fatal_error"
  | "aborted";

export interface SessionStats {
  phase: SessionPhase;
  iteration: number;
  attempt?: number;
  storyId?: string;
  outcome: SessionOutcome;
  errorMessage?: string;
  costUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  anomalyFlags: string[];
}

export interface StoryOutcome {
  storyId: string;
  passed: boolean;
  reason?: string; // e.g. "budget_exceeded", "fail_abort", "max_attempts"
  iteration: number;
  costUsd: number;
}

export interface RunStats {
  startedAt: Date;
  sessions: SessionStats[];
  storyOutcomes: StoryOutcome[];
  iterationsCompleted: number;
  storiesPassed: number;
  storiesFailed: number;
}

// Discriminated union of every event the harness emits. Add a variant here when
// introducing a new `emitEvent` call site so the call is type-checked end-to-end.
export type HarnessEvent =
  | {
      kind: "run_start";
      maxIterations: number;
      model: string;
      builderModel: string;
      verifierModel: string;
      costBudgetUsdPerStory: number;
      costBudgetUsdTotal: number;
      buildTimeoutMs: number;
      verifyTimeoutMs: number;
    }
  | { kind: "run_abort"; reason: "signal" }
  | { kind: "run_done"; reason: "total_budget_exceeded"; spent: number; budget: number }
  | { kind: "run_done"; reason: "all_stories_passing"; iteration?: number }
  | { kind: "run_end"; reason: "signal" | "max_iterations" }
  | {
      kind: "run_halt";
      iteration: number;
      reason: "awaiting_pr";
      prNum: number | undefined;
      branch: string | undefined;
    }
  | {
      kind: "phase_start";
      phase: SessionPhase;
      iteration: number;
      storyId?: string;
      attempt?: number;
    }
  | {
      kind: "phase_end";
      phase: SessionPhase;
      iteration: number;
      attempt?: number;
      outcome: SessionOutcome;
    }
  | { kind: "iteration_start"; iteration: number; storyId: string; title: string }
  | { kind: "sensors_ran"; iteration: number; storyId: string; sensors: string[] }
  // Emitted by the orchestrator agent (via `marmite emit-event`) before/after
  // each sensor it runs. Surfaced in the logger so the user sees real-time
  // sensor activity during the orchestrate phase.
  | { kind: "sensor_start"; sensor: string; sensorType?: string }
  | {
      kind: "sensor_end";
      sensor: string;
      sensorType?: string;
      durationMs: number;
      exitCode: number;
    }
  | {
      kind: "verification_verdict";
      iteration: number;
      storyId: string;
      verdict: VerificationVerdict;
      qaPass: number;
      qaFail: number;
    }
  | { kind: "feedback_detected"; iteration: number; bytes: number; preview: string }
  | { kind: "feedback_applied"; iteration: number }
  | { kind: "feedback_force_cleared"; iteration: number }
  | {
      kind: "story_selected";
      iteration: number;
      storyId: string;
      title: string;
      source: "orchestrator" | "fallback";
    }
  | {
      kind: "budget_warning";
      threshold: number;
      spent: number;
      budget: number;
    }
  | {
      kind: "agent_error";
      phase: SessionPhase;
      iteration: number;
      attempt: number | undefined;
      storyId: string;
      outcome: "fatal_error" | "transient_error";
      errorMessage: string | undefined;
    }
  | {
      kind: "session_result";
      phase: SessionPhase;
      iteration: number;
      attempt: number | undefined;
      storyId: string;
      outcome: SessionOutcome;
      costUsd: number;
      durationMs: number;
      numTurns: number;
      anomalyFlags: string[];
      errorMessage: string | undefined;
    }
  | ({ kind: "story_outcome" } & StoryOutcome);

export type HarnessEventKind = HarnessEvent["kind"];

