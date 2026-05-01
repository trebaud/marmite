import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunStats, SessionStats } from "./types.ts";

// Reporter is the only channel core uses to surface human-readable output.
// The CLI provides a console-backed implementation (src/cli/log.ts);
// tests and alternative hosts can pass `silentReporter` or their own.

export type BranchAction = "created" | "switched" | "already_on";

export interface ResumeInfo {
  iteration: number;
  storyId: string;
  lastPhase: string;
}

export interface Reporter {
  start(maxIterations: number): void;
  iterationStart(iteration: number, max: number, storyId?: string): void;
  complete(iteration: number, max: number): void;
  maxReached(max: number): void;
  archive(branch: string, folder: string): void;
  branchSetup(branch: string, action: BranchAction): void;
  feedbackDetected(bytes: number, preview: string): void;
  feedbackForceArchived(target: string): void;
  resume(state: ResumeInfo): void;
  budgetExceeded(storyId: string, spent: number, budget: number): void;
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
  complete: () => {},
  maxReached: () => {},
  archive: () => {},
  branchSetup: () => {},
  feedbackDetected: () => {},
  feedbackForceArchived: () => {},
  resume: () => {},
  budgetExceeded: () => {},
  error: () => {},
  message: () => {},
  sessionReport: () => {},
  finalReport: () => {},
  info: () => {},
  stderr: () => {},
};
