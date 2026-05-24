import { describe, test, expect } from "bun:test";
import {
  classifyDrainError,
  runQueryWithRetryUsing,
  textIsUsageLimit,
  type RetryDeps,
  type SessionResult,
} from "../src/core/session.ts";
import { silentReporter } from "../src/core/reporter.ts";
import type { HarnessConfig } from "../src/core/types.ts";

// classifyDrainError maps the Agent SDK's SDKResultError + surrounding stream
// signals into a SessionOutcome. See node_modules/@anthropic-ai/claude-agent-
// sdk/sdk.d.ts (SDKResultError, TerminalReason, SDKAssistantMessageError,
// SDKRateLimitInfo) for the source field definitions.

describe("classifyDrainError", () => {
  test("terminal_reason='blocking_limit' → usage_limit with resumeAt", () => {
    const r = classifyDrainError({
      subtype: "error_during_execution",
      terminalReason: "blocking_limit",
      rateLimitInfo: { status: "rejected", resetsAt: 1_900_000_000, rateLimitType: "five_hour" },
    });
    expect(r.outcome).toBe("usage_limit");
    expect(r.resumeAt).toBe(1_900_000_000);
  });

  test("terminal_reason='rapid_refill_breaker' → usage_limit", () => {
    const r = classifyDrainError({
      subtype: "error_during_execution",
      terminalReason: "rapid_refill_breaker",
    });
    expect(r.outcome).toBe("usage_limit");
  });

  test("assistant error 'billing_error' → usage_limit", () => {
    const r = classifyDrainError({
      subtype: "error_during_execution",
      assistantError: "billing_error",
    });
    expect(r.outcome).toBe("usage_limit");
  });

  test("assistant error 'rate_limit' → usage_limit", () => {
    const r = classifyDrainError({
      subtype: "error_during_execution",
      assistantError: "rate_limit",
    });
    expect(r.outcome).toBe("usage_limit");
  });

  test("rate_limit_info.status='rejected' → usage_limit even without terminal_reason", () => {
    const r = classifyDrainError({
      subtype: "error_during_execution",
      rateLimitInfo: { status: "rejected", resetsAt: 1_800_000_000 },
    });
    expect(r.outcome).toBe("usage_limit");
    expect(r.resumeAt).toBe(1_800_000_000);
  });

  test("error_max_turns → fatal_error (not retryable)", () => {
    const r = classifyDrainError({ subtype: "error_max_turns", terminalReason: "max_turns" });
    expect(r.outcome).toBe("fatal_error");
  });

  test("terminal_reason='prompt_too_long' → fatal_error", () => {
    const r = classifyDrainError({
      subtype: "error_during_execution",
      terminalReason: "prompt_too_long",
    });
    expect(r.outcome).toBe("fatal_error");
  });

  test("error_max_budget_usd → fatal_error", () => {
    const r = classifyDrainError({ subtype: "error_max_budget_usd" });
    expect(r.outcome).toBe("fatal_error");
  });

  test("error_during_execution with no rate-limit signal → transient_error", () => {
    const r = classifyDrainError({
      subtype: "error_during_execution",
      errorsText: "upstream connect timeout",
    });
    expect(r.outcome).toBe("transient_error");
  });

  test("error_during_execution with 'usage limit reached' in errors[] → usage_limit", () => {
    const r = classifyDrainError({
      subtype: "error_during_execution",
      errorsText: "API request failed: Claude usage limit reached for this account",
    });
    expect(r.outcome).toBe("usage_limit");
  });

  test("error_during_execution with 'credit balance is too low' → usage_limit", () => {
    const r = classifyDrainError({
      subtype: "error_during_execution",
      errorsText: "Your credit balance is too low to access the Anthropic API",
    });
    expect(r.outcome).toBe("usage_limit");
  });

  test("terminal_reason wins over rate_limit_info on conflicting signals", () => {
    // If the SDK said blocking_limit, trust it as usage_limit even when
    // rate_limit_info.status is not yet 'rejected' (eg. concurrent updates).
    const r = classifyDrainError({
      subtype: "error_during_execution",
      terminalReason: "blocking_limit",
      rateLimitInfo: { status: "allowed_warning" },
    });
    expect(r.outcome).toBe("usage_limit");
  });

  test("unknown subtype with no other signals → fatal_error", () => {
    const r = classifyDrainError({ subtype: "error" });
    expect(r.outcome).toBe("fatal_error");
  });

  test("propagates a human-readable message", () => {
    const r = classifyDrainError({
      subtype: "error_during_execution",
      errorsText: "upstream timeout",
    });
    expect(r.message).toBe("upstream timeout");
  });

  test("falls back to assistantError when errorsText is missing", () => {
    const r = classifyDrainError({
      subtype: "error_during_execution",
      assistantError: "billing_error",
    });
    expect(r.message).toContain("billing_error");
  });
});

describe("textIsUsageLimit", () => {
  test("matches the real subscription-limit response text", () => {
    // The actual SDK output we saw in the wild:
    //   "You've hit your limit · resets 11:50pm (America/Toronto)"
    expect(textIsUsageLimit("You've hit your limit · resets 11:50pm (America/Toronto)")).toBe(true);
  });

  test("matches the SDK's thrown exit error wrapping the limit text", () => {
    expect(
      textIsUsageLimit(
        "Claude Code returned an error result: You've hit your limit · resets 11:50pm",
      ),
    ).toBe(true);
  });

  test("matches Opus-specific subscription limit", () => {
    expect(textIsUsageLimit("You've hit your Opus limit · resets Mon 9:00am")).toBe(true);
  });

  test("matches credit-balance API-key flow", () => {
    expect(textIsUsageLimit("Your credit balance is too low to access the Anthropic API")).toBe(true);
  });

  test("does not match unrelated SDK errors", () => {
    expect(textIsUsageLimit("Claude Code process exited with code 1")).toBe(false);
    expect(textIsUsageLimit("connection reset by peer")).toBe(false);
    expect(textIsUsageLimit(undefined)).toBe(false);
    expect(textIsUsageLimit("")).toBe(false);
  });

  test("matches 'usage limit reached' phrasing in arbitrary text", () => {
    expect(textIsUsageLimit("API request failed: usage limit reached for project")).toBe(true);
  });
});

// Build a minimal HarnessConfig that's complete enough for runQueryWithRetry.
// Only retries-related fields matter here.
function fakeConfig(maxTransientRetries = 2): HarnessConfig {
  return {
    maxIterations: 10,
    appPath: "/tmp/app",
    prdPath: "/tmp/prd.json",
    model: "claude-sonnet-4-6",
    builderModel: "claude-sonnet-4-6",
    verifierModel: "claude-sonnet-4-6",
    orchestratorModel: "claude-sonnet-4-6",
    pricing: {},
    buildTimeoutMs: 0,
    verifyTimeoutMs: 0,
    fixTimeoutMs: 0,
    orchestrateTimeoutMs: 0,
    maxTransientRetries,
    costBudgetUsdPerStory: 0,
    costBudgetUsdTotal: 0,
    maxFixAttempts: 3,
  };
}

const emptyStats = {
  costUsd: 0,
  durationMs: 0,
  durationApiMs: 0,
  numTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
};

function successResult(): SessionResult {
  return {
    result: "ok",
    sessionId: "sess-success",
    model: "claude-sonnet-4-6",
    outcome: "success",
    stats: { ...emptyStats },
  };
}

function usageLimitResult(resumeAtSec: number, message = "You've hit your limit"): SessionResult {
  return {
    result: "",
    sessionId: "sess-limit",
    model: "claude-sonnet-4-6",
    outcome: "usage_limit",
    errorMessage: message,
    resumeAt: resumeAtSec,
    stats: { ...emptyStats },
  };
}

function transientResult(): SessionResult {
  return {
    result: "",
    sessionId: "",
    model: "claude-sonnet-4-6",
    outcome: "transient_error",
    errorMessage: "ECONNRESET",
    stats: { ...emptyStats },
  };
}

// Fake clock + non-sleeping deps for fast tests. `runQuery` is scripted via
// an array of outcomes; advancing the clock past resumeAt is automatic
// (sleep() just bumps the fake "now" and returns).
function makeDeps(outcomes: SessionResult[]): {
  deps: RetryDeps;
  calls: SessionResult[];
  promptCount: () => number;
  fakeNow: { value: number };
} {
  const fakeNow = { value: 1_000_000 }; // arbitrary ms epoch
  const calls: SessionResult[] = [];
  const remaining = [...outcomes];
  const deps: RetryDeps = {
    runQuery: async () => {
      const next = remaining.shift();
      if (!next) throw new Error("test: ran out of scripted outcomes");
      calls.push(next);
      return next;
    },
    sleep: async (ms: number) => {
      fakeNow.value += ms;
    },
    now: () => fakeNow.value,
  };
  return { deps, calls, promptCount: () => calls.length, fakeNow };
}

describe("runQueryWithRetryUsing — usage_limit retry path", () => {
  test("usage_limit on first call, success on retry → returns success", async () => {
    const { deps, fakeNow, promptCount } = makeDeps([
      usageLimitResult(Math.floor((1_000_000 + 100) / 1000)), // resumes 100ms later
      successResult(),
    ]);
    const ac = new AbortController();
    const result = await runQueryWithRetryUsing(
      deps,
      fakeConfig(),
      "prompt",
      0,
      undefined,
      ac.signal,
      silentReporter,
    );
    expect(result.outcome).toBe("success");
    expect(promptCount()).toBe(2);
    // fakeNow advanced past resumeAt + buffer
    expect(fakeNow.value).toBeGreaterThanOrEqual(1_000_000 + 100);
  });

  test("waits the full resumeAt + buffer before retrying", async () => {
    // resumeAt is 60 real seconds in the future
    const resumeAtSec = Math.floor((1_000_000 + 60_000) / 1000);
    const { deps, fakeNow } = makeDeps([
      usageLimitResult(resumeAtSec),
      successResult(),
    ]);
    const ac = new AbortController();
    await runQueryWithRetryUsing(deps, fakeConfig(), "prompt", 0, undefined, ac.signal, silentReporter);
    // We should have slept at least (60s + 30s buffer) of fake time.
    expect(fakeNow.value).toBeGreaterThanOrEqual(1_000_000 + 60_000 + 30_000);
  });

  test("usage_limit does not consume the transient retry budget", async () => {
    // 5 consecutive usage_limit responses, then one transient_error, then
    // maxTransientRetries=2 transient retries before final failure. The 5
    // usage_limit waits must NOT count against the transient budget.
    const resumeSoon = Math.floor((1_000_000 + 50) / 1000);
    const outcomes: SessionResult[] = [
      usageLimitResult(resumeSoon),
      usageLimitResult(resumeSoon),
      usageLimitResult(resumeSoon),
      usageLimitResult(resumeSoon),
      usageLimitResult(resumeSoon),
      // Now real attempts: 1, retry 2, retry 3 (= maxTransientRetries + 1 = 3 tries)
      transientResult(),
      transientResult(),
      transientResult(),
    ];
    const { deps, promptCount } = makeDeps(outcomes);
    const ac = new AbortController();
    const result = await runQueryWithRetryUsing(
      deps,
      fakeConfig(2), // maxTransientRetries=2 → 3 total transient attempts
      "prompt",
      0,
      undefined,
      ac.signal,
      silentReporter,
    );
    // Returns the last transient_error after exhausting retries.
    expect(result.outcome).toBe("transient_error");
    // All 8 scripted outcomes were consumed.
    expect(promptCount()).toBe(8);
  });

  test("falls back to default cooldown when resumeAt is missing", async () => {
    const noResumeAt: SessionResult = {
      result: "",
      sessionId: "",
      model: "claude-sonnet-4-6",
      outcome: "usage_limit",
      errorMessage: "You've hit your limit",
      // resumeAt deliberately omitted
      stats: { ...emptyStats },
    };
    const { deps, fakeNow } = makeDeps([noResumeAt, successResult()]);
    const ac = new AbortController();
    const result = await runQueryWithRetryUsing(
      deps,
      fakeConfig(),
      "prompt",
      0,
      undefined,
      ac.signal,
      silentReporter,
    );
    expect(result.outcome).toBe("success");
    // Default cooldown is 5 minutes.
    expect(fakeNow.value).toBeGreaterThanOrEqual(1_000_000 + 5 * 60 * 1000);
  });

  test("aborting during a usage_limit pause returns the usage_limit result immediately", async () => {
    // resumeAt very far in the future so we'd otherwise sleep a long time.
    const farFuture = Math.floor((1_000_000 + 60 * 60 * 1000) / 1000);
    const { deps, promptCount } = makeDeps([usageLimitResult(farFuture), successResult()]);
    const ac = new AbortController();
    // Make sleep abort on first call so we leave the pause loop fast.
    const realSleep = deps.sleep;
    deps.sleep = async (ms: number) => {
      ac.abort();
      await realSleep(ms);
    };
    const result = await runQueryWithRetryUsing(
      deps,
      fakeConfig(),
      "prompt",
      0,
      undefined,
      ac.signal,
      silentReporter,
    );
    expect(result.outcome).toBe("usage_limit");
    // Only the first call happened — we did not retry after abort.
    expect(promptCount()).toBe(1);
  });

  test("a stale resumeAt (already in the past) uses default cooldown, not negative wait", async () => {
    const stalePast = Math.floor((1_000_000 - 60_000) / 1000); // 1 min ago
    const { deps, fakeNow } = makeDeps([usageLimitResult(stalePast), successResult()]);
    const ac = new AbortController();
    const result = await runQueryWithRetryUsing(
      deps,
      fakeConfig(),
      "prompt",
      0,
      undefined,
      ac.signal,
      silentReporter,
    );
    expect(result.outcome).toBe("success");
    // Default cooldown applied since resumeAt was in the past.
    expect(fakeNow.value).toBeGreaterThanOrEqual(1_000_000 + 5 * 60 * 1000);
  });
});
