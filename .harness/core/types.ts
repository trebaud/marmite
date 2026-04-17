export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
}

export interface HarnessConfig {
  maxIterations: number;
  projectRoot: string;
  builderMdPath: string;
  verifierMdPath: string;
  prdPath: string;
  progressPath: string;
  archiveDir: string;
  lastBranchPath: string;
  statePath: string;
  eventsPath: string;
  verificationResultsPath: string;
  lastStoryPath: string;
  buildStatusPath: string;
  // Model & pricing
  model: string;
  pricing: ModelPricing;
  // Timeouts (ms)
  buildTimeoutMs: number;
  verifyTimeoutMs: number;
  fixTimeoutMs: number;
  // Retries for transient errors per phase
  maxTransientRetries: number;
  // Cost budget per story (USD). Exceeding aborts remaining fix attempts for that story. 0 disables.
  costBudgetUsdPerStory: number;
  // Fix loop retry cap
  maxFixAttempts: number;
  // Resume from .harness/state.json if it matches current PRD/branch
  resumeIfAvailable: boolean;
}

export type SessionPhase = "build" | "verify" | "fix";

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

export interface HarnessState {
  version: string;
  branchName: string;
  iteration: number;
  storyId: string;
  buildSessionId: string;
  fixAttempts: number;
  lastPhase: SessionPhase | "idle";
  updatedAt: string;
}
