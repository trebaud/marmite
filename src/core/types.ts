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

