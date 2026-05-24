import { describe, test, expect } from "bun:test";
import { classifyDrainError } from "../src/core/session.ts";

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
