import type { VerificationVerdict } from "./protocol.ts";
import type { McpServerConfig } from "./config.ts";

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
}

export interface HarnessConfig {
  maxIterations: number;
  appPath: string;
  prdPath: string;
  // Workflow name from marmite.json. The harness acts on it for epic-checkpoint
  // (halts at epic boundaries); otherwise it only documents which prompts were
  // installed. Undefined falls back to one-shot behavior (no halting).
  workflow?: string;
  // Set by `marmite cook --approve`. In the epic-checkpoint workflow this
  // appends an approval for the epic currently blocking and lets the run cross
  // that one checkpoint; ignored by other workflows.
  approve: boolean;
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
  // Opt-in MCP servers exposed to every agent. Empty/undefined means none.
  mcpServers?: Record<string, McpServerConfig>;
}

export type SessionPhase = "orchestrate" | "build" | "verify" | "fix";

export type SessionOutcome =
  | "success"
  | "timeout"
  | "transient_error"
  | "fatal_error"
  | "aborted"
  | "usage_limit";

export interface SessionStats {
  phase: SessionPhase;
  iteration: number;
  attempt?: number;
  storyId?: string;
  model: string;
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
      runId: string;
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
      reason: "epic_checkpoint";
      epic: string;
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
      model: string;
      outcome: SessionOutcome;
      costUsd: number;
      durationMs: number;
      numTurns: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreateTokens: number;
      anomalyFlags: string[];
      errorMessage: string | undefined;
    }
  | ({ kind: "story_outcome" } & StoryOutcome)
  // Anthropic usage / quota limit pause. Emitted by runQueryWithRetry before
  // the harness sleeps until the limit resets. `resumeAt` is the Unix timestamp
  // (seconds) Anthropic gave us; absent when the SDK didn't surface one and the
  // harness falls back to a default cooldown.
  | {
      kind: "usage_limit_pause";
      phase: SessionPhase;
      agentLabel: string;
      resumeAt?: number;
      waitMs: number;
      consecutive: number;
      errorMessage?: string;
    }
  // Paired with usage_limit_pause: emitted once the wait clears (or the run was
  // aborted mid-wait). `waitedMs` is the actual elapsed time, which can be less
  // than `waitMs` when aborted.
  | {
      kind: "usage_limit_resume";
      phase: SessionPhase;
      agentLabel: string;
      waitedMs: number;
      aborted: boolean;
    };

export type HarnessEventKind = HarnessEvent["kind"];

