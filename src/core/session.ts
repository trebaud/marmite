import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessConfig, ModelPricing, SessionOutcome, SessionPhase } from "./types.ts";
import type { Reporter } from "./reporter.ts";
import { classifyError, sleep } from "./utils.ts";
import { PATHS } from "./paths.ts";
import { emitEvent } from "./events.ts";

const FALLBACK_PRICING: ModelPricing = { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5 };

export function pricingFor(config: HarnessConfig, model: string): ModelPricing {
  return config.pricing[model] ?? config.pricing[config.model] ?? FALLBACK_PRICING;
}

export interface SessionStatsRaw {
  costUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface SessionResult {
  result: string;
  sessionId: string;
  model: string;
  outcome: SessionOutcome;
  errorMessage?: string;
  // Unix timestamp (seconds) when an Anthropic usage limit will reset. Only
  // populated when `outcome === "usage_limit"` and the SDK surfaced a hint.
  resumeAt?: number;
  stats: SessionStatsRaw;
}

const emptyStats: SessionStatsRaw = {
  costUsd: 0,
  durationMs: 0,
  durationApiMs: 0,
  numTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
};

function baseOptions(config: HarnessConfig, model: string, abort: AbortController, reporter: Reporter) {
  return {
    cwd: PATHS.projectRoot,
    model,
    settingSources: ["project" as const],
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    abortController: abort,
    // MCP servers come exclusively from marmite.json's `mcpServers` block.
    // `strictMcpConfig: true` keeps user/global Claude Code MCP config out of
    // the picture — loading dozens of unauthenticated servers bloats the tool
    // list and cache_create cost on every agent spawn. Opt-in via marmite.json
    // is the only supported path.
    mcpServers: config.mcpServers ?? {},
    strictMcpConfig: true,
    systemPrompt: {
      type: "preset" as const,
      preset: "claude_code" as const,
      excludeDynamicSections: true,
    },
    stderr: (data: string) => {
      const line = data.trim();
      if (line) reporter.stderr(line);
    },
  };
}

function calcCost(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
): number {
  return (
    (inputTokens * pricing.inputPerMTok) / 1_000_000 +
    (outputTokens * pricing.outputPerMTok) / 1_000_000 +
    (cacheReadTokens * pricing.cacheReadPerMTok) / 1_000_000
  );
}

// Stream-derived error info captured by drain(). The Agent SDK does NOT throw
// API errors out of the async iterator — it emits them as `SDKResultError`
// (result/subtype != success) and `SDKAssistantMessage.error` codes, plus a
// `SDKRateLimitEvent` whenever subscription rate-limit state changes. We
// gather all of these so runQuery() can pick the most informative signal.
interface DrainErrorInfo {
  subtype: string;
  // From SDKResultError.terminal_reason — e.g. 'blocking_limit',
  // 'rapid_refill_breaker', 'max_turns', 'prompt_too_long'. The most reliable
  // single signal for what stopped the run.
  terminalReason?: string;
  // SDKResultError.errors[] joined for human display.
  errorsText?: string;
  // Last SDKAssistantMessage.error before termination — e.g. 'rate_limit',
  // 'billing_error', 'authentication_failed'.
  assistantError?: string;
  // Last SDKRateLimitEvent.rate_limit_info before termination (subscription
  // billing only — undefined on direct API-key flows).
  rateLimitInfo?: {
    status?: string;
    resetsAt?: number;
    rateLimitType?: string;
  };
}

interface DrainOutput {
  result: string;
  sessionId: string;
  stats: SessionStatsRaw;
  errorInfo?: DrainErrorInfo;
  // Last SDKRateLimitEvent.rate_limit_info we observed. Stays populated even
  // when the SDK ends in a thrown error and never emitted a SDKResultError —
  // common path for the subscription "You've hit your limit" flow, where the
  // iterator yields a success-shaped result containing the limit text and
  // then throws `Claude Code returned an error result: …` on subprocess exit.
  rateLimitInfo?: DrainErrorInfo["rateLimitInfo"];
  // Set when the SDK threw out of the async iterator (e.g. subprocess exit
  // with stored lastErrorResultText). Captured here so the caller can still
  // see the stream state we collected before the throw.
  thrownError?: unknown;
}

async function drain(
  config: HarnessConfig,
  model: string,
  q: AsyncIterable<SDKMessage>,
  agentLabel: string,
  reporter: Reporter,
): Promise<DrainOutput> {
  let result = "";
  let sessionId = "";
  let stats: SessionStatsRaw = { ...emptyStats };
  let errorInfo: DrainErrorInfo | undefined;
  let lastAssistantError: string | undefined;
  let lastRateLimitInfo: DrainErrorInfo["rateLimitInfo"];
  let thrownError: unknown;

  try {
    for await (const message of q) {
      reporter.message(message, agentLabel);

      // Track rolling assistant error code (most recent wins).
      if (message.type === "assistant") {
        const e = (message as any).error;
        if (typeof e === "string") lastAssistantError = e;
      }

      // Track subscription rate-limit telemetry. Only "rejected" hard-blocks,
      // but the resetsAt timestamp is the same field across statuses, so we
      // capture whichever was emitted most recently.
      if ((message as any).type === "rate_limit_event") {
        const info = (message as any).rate_limit_info;
        if (info) {
          lastRateLimitInfo = {
            status: info.status,
            resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : undefined,
            rateLimitType: info.rateLimitType,
          };
        }
      }

      if (message.type === "result") {
        const r = message as any;
        if (message.subtype === "success") {
          result = message.result;
          sessionId = r.session_id ?? "";
        } else {
          // Non-success result subtype: capture everything the SDK gave us so
          // runQuery can map this to an outcome. errors[] is a string[] per
          // SDKResultError; terminal_reason and the trailing rate_limit_info /
          // assistant error are the most actionable signals.
          sessionId = r.session_id ?? "";
          const errsRaw = Array.isArray(r.errors) ? r.errors : [];
          errorInfo = {
            subtype: String(message.subtype),
            terminalReason: typeof r.terminal_reason === "string" ? r.terminal_reason : undefined,
            errorsText: errsRaw.length > 0 ? errsRaw.map(String).join("; ") : undefined,
            assistantError: lastAssistantError,
            rateLimitInfo: lastRateLimitInfo,
          };
        }
        const inputTokens = r.usage?.input_tokens ?? 0;
        const outputTokens = r.usage?.output_tokens ?? 0;
        const cacheReadTokens = r.usage?.cache_read_input_tokens ?? 0;
        // Prefer the SDK's reported cost when available; otherwise compute from our pricing table.
        const sdkCost = typeof r.total_cost_usd === "number" ? r.total_cost_usd : null;
        stats = {
          costUsd: sdkCost ?? calcCost(pricingFor(config, model), inputTokens, outputTokens, cacheReadTokens),
          durationMs: r.duration_ms ?? 0,
          durationApiMs: r.duration_api_ms ?? 0,
          numTurns: r.num_turns ?? 0,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreateTokens: r.usage?.cache_creation_input_tokens ?? 0,
        };
      }
    }
  } catch (err) {
    // The Agent SDK throws out of the iterator on subprocess exit when it has
    // a stored error result (e.g. subscription rate-limit hit, where it emits
    // a success-shaped result with the limit text and then throws on cleanup).
    // We swallow the throw here so the caller can combine it with the
    // rate_limit_info we observed mid-stream and make a sensible decision.
    thrownError = err;
  }
  return { result, sessionId, stats, errorInfo, rateLimitInfo: lastRateLimitInfo, thrownError };
}

// Subscription limit messages the SDK surfaces either as the .result of a
// success-shaped SDKResultMessage or as the body of the thrown exit error.
// Matching is conservative: phrases that map unambiguously to "wait, the
// limit will lift" rather than transient API errors.
export function textIsUsageLimit(text: string | undefined): boolean {
  if (!text) return false;
  const s = text.toLowerCase();
  return (
    /you'?ve hit your\b.*\blimit/.test(s) ||
    /usage\s+limit\s+(reached|exceeded)/.test(s) ||
    /quota\s+(exceeded|reached)/.test(s) ||
    /credit\s+balance\s+is\s+too\s+low/.test(s) ||
    // Sentinel thrown by the SDK's QX.readMessages cleanup path —
    // node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:
    //   `Claude Code returned an error result: ${lastErrorResultText}`.
    /claude code returned an error result/.test(s)
  );
}

// Decide what to do with a non-success SDKResultError. The mapping favors the
// most reliable signal: terminal_reason first (set by the SDK and stable),
// then assistant_error code, then rate_limit_info, then the free-text errors
// blob as a last-resort regex match.
//
// Reference: node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
//   SDKResultError, TerminalReason, SDKAssistantMessageError, SDKRateLimitInfo
export function classifyDrainError(info: DrainErrorInfo): {
  outcome: SessionOutcome;
  message: string;
  resumeAt?: number;
} {
  const message =
    info.errorsText ??
    (info.assistantError ? `assistant error: ${info.assistantError}` : null) ??
    info.subtype;
  const resumeAt = info.rateLimitInfo?.resetsAt;

  // Subscription quota / rate-limit hard block. terminal_reason is the
  // canonical signal here.
  if (info.terminalReason === "blocking_limit" || info.terminalReason === "rapid_refill_breaker") {
    return { outcome: "usage_limit", message, resumeAt };
  }

  // Assistant-level error codes from the API. 'billing_error' = quota /
  // payment / credit issue; 'rate_limit' = HTTP 429.
  if (info.assistantError === "billing_error" || info.assistantError === "rate_limit") {
    return { outcome: "usage_limit", message, resumeAt };
  }

  // SDK-internal per-query budget cap (only fires if caller set maxBudgetUsd —
  // marmite doesn't, but treat as fatal so we don't hammer it).
  if (info.subtype === "error_max_budget_usd") {
    return { outcome: "fatal_error", message };
  }

  // Conversation-loop ceilings — not transient, retrying won't help.
  if (info.subtype === "error_max_turns" || info.terminalReason === "max_turns") {
    return { outcome: "fatal_error", message };
  }
  if (info.terminalReason === "prompt_too_long") {
    return { outcome: "fatal_error", message };
  }

  // error_during_execution is the generic catch-all the SDK emits when an
  // API call fails after its internal retries. If the rate-limit event came
  // through "rejected" we still trust it. Otherwise the SDK has already
  // exhausted its retries; treat as transient one more time at our layer.
  if (info.rateLimitInfo?.status === "rejected") {
    return { outcome: "usage_limit", message, resumeAt };
  }

  // Free-text fallback — covers cases where the SDK hasn't tagged the error
  // with a structured field. Be conservative: only match phrases that strongly
  // imply a quota wait (not generic 429s).
  if (info.errorsText) {
    const lower = info.errorsText.toLowerCase();
    if (
      /usage\s+limit\s+(reached|exceeded)/.test(lower) ||
      /quota\s+(exceeded|reached)/.test(lower) ||
      /credit\s+balance\s+is\s+too\s+low/.test(lower)
    ) {
      return { outcome: "usage_limit", message, resumeAt };
    }
  }

  if (info.subtype === "error_during_execution" || info.subtype === "error_max_structured_output_retries") {
    return { outcome: "transient_error", message };
  }
  return { outcome: "fatal_error", message };
}

export interface RunQueryOptions {
  phase: SessionPhase;
  reporter: Reporter;
  resumeId?: string;
  parentSignal?: AbortSignal;
  agentLabel?: string;
}

function modelForPhase(config: HarnessConfig, phase: SessionPhase): string {
  switch (phase) {
    case "orchestrate": return config.orchestratorModel;
    case "build":       return config.builderModel;
    case "fix":         return config.builderModel;
    case "verify":      return config.verifierModel;
  }
}

function timeoutForPhase(config: HarnessConfig, phase: SessionPhase): number {
  switch (phase) {
    case "orchestrate": return config.orchestrateTimeoutMs;
    case "build":       return config.buildTimeoutMs;
    case "fix":         return config.fixTimeoutMs;
    case "verify":      return config.verifyTimeoutMs;
  }
}

export async function runQuery(
  prompt: string,
  config: HarnessConfig,
  opts: RunQueryOptions,
): Promise<SessionResult> {
  const { phase, reporter, resumeId, parentSignal } = opts;
  const model = modelForPhase(config, phase);
  const timeoutMs = timeoutForPhase(config, phase);
  const agentLabel = opts.agentLabel ?? phase;

  const abort = new AbortController();
  const onParentAbort = () => abort.abort();
  if (parentSignal) {
    if (parentSignal.aborted) abort.abort();
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, timeoutMs);
  }

  try {
    const sdkOptions = {
      ...baseOptions(config, model, abort, reporter),
      ...(resumeId ? { resume: resumeId } : {}),
    };
    const q = query({ prompt, options: sdkOptions });
    const drained = await drain(config, model, q, agentLabel, reporter);

    // Signal priority for picking an outcome:
    //   1. SDKResultError with structured fields → classifyDrainError
    //   2. SDKRateLimitEvent status="rejected" before the iterator ended
    //   3. Result text or thrown-exit message matching a usage-limit phrase
    //   4. Plain thrown error (treat as transient/aborted/timeout/fatal)
    //   5. Success
    const rateLimitInfo = drained.rateLimitInfo;
    const rateLimitRejected = rateLimitInfo?.status === "rejected";
    const resumeAtFromRate = rateLimitInfo?.resetsAt;

    if (drained.errorInfo) {
      const classified = classifyDrainError(drained.errorInfo);
      return {
        result: "",
        sessionId: drained.sessionId,
        model,
        outcome: classified.outcome,
        errorMessage: classified.message,
        resumeAt: classified.resumeAt,
        stats: drained.stats,
      };
    }

    // SDK subscription-limit pattern: success-shaped result containing the
    // "You've hit your limit · resets …" text, optionally followed by a
    // thrown exit error. Prefer the structured rate_limit_event timestamp
    // over anything we'd parse from the text.
    const thrownMessage = drained.thrownError instanceof Error
      ? drained.thrownError.message
      : typeof drained.thrownError === "string"
        ? drained.thrownError
        : undefined;
    const resultLooksLikeLimit = textIsUsageLimit(drained.result);
    const thrownLooksLikeLimit = textIsUsageLimit(thrownMessage);

    if (rateLimitRejected || resultLooksLikeLimit || thrownLooksLikeLimit) {
      const errorMessage = thrownMessage ?? drained.result ?? "usage limit reached";
      return {
        result: "",
        sessionId: drained.sessionId,
        model,
        outcome: "usage_limit",
        errorMessage,
        resumeAt: resumeAtFromRate,
        stats: drained.stats,
      };
    }

    // Thrown exit error that doesn't match a usage-limit pattern. Fall back
    // to classifyError so timeouts / aborts / transient network blips still
    // route correctly.
    if (drained.thrownError !== undefined) {
      const classified = classifyError(drained.thrownError);
      let outcome: SessionOutcome = "fatal_error";
      if (timedOut || classified.category === "timeout") outcome = "timeout";
      else if (classified.category === "aborted") outcome = "aborted";
      else if (classified.category === "transient") outcome = "transient_error";
      return {
        result: "",
        sessionId: drained.sessionId,
        model,
        outcome,
        errorMessage: classified.message,
        stats: drained.stats,
      };
    }

    return {
      result: drained.result,
      sessionId: drained.sessionId,
      model,
      outcome: "success",
      stats: drained.stats,
    };
  } catch (err) {
    // Setup / connection errors that escape drain (e.g. query() throwing
    // synchronously before the iterator even starts).
    const classified = classifyError(err);
    let outcome: SessionOutcome = "fatal_error";
    if (timedOut || classified.category === "timeout") outcome = "timeout";
    else if (classified.category === "aborted") outcome = "aborted";
    else if (classified.category === "transient") outcome = "transient_error";
    return {
      result: "",
      sessionId: "",
      model,
      outcome,
      errorMessage: classified.message,
      stats: { ...emptyStats },
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
  }
}

// Cap usage_limit waits at 12h so a parser miss can't park the run forever.
// Default cooldown when the SDK gave no resumeAt: long enough that we don't
// hammer the API, short enough that an in-progress quota reset gets picked up
// reasonably soon.
const USAGE_LIMIT_MAX_WAIT_MS = 12 * 60 * 60 * 1000;
const USAGE_LIMIT_DEFAULT_WAIT_MS = 5 * 60 * 1000;
// 30s buffer past the announced reset — Anthropic's "resets 11:50pm" is
// minute-precise (resetsAt: 2026-05-25T03:50:00.000Z), so a 5s buffer was
// inside the rounding error and could land us back inside the limit window
// on retry. 30s gives reliable clearance without noticeably extending the
// total pause.
const USAGE_LIMIT_BUFFER_MS = 30_000;

export interface RunQueryWithRetryOptions {
  phase: SessionPhase;
  reporter: Reporter;
  parentSignal: AbortSignal;
  resumeId?: string;
  agentLabel?: string;
}

export async function runQueryWithRetry(
  prompt: string,
  config: HarnessConfig,
  opts: RunQueryWithRetryOptions,
): Promise<SessionResult> {
  const { phase, reporter, parentSignal } = opts;
  const agentLabel = opts.agentLabel ?? phase;
  let lastResult: SessionResult | null = null;
  let attempt = 1;
  let usageLimitWaits = 0;
  while (attempt <= config.maxTransientRetries + 1) {
    const result = await runQuery(prompt, config, opts);
    lastResult = result;

    // Usage / quota limits: pause until the Anthropic-provided reset time
    // (or a default cooldown if none). Does NOT consume the transient retry
    // budget and does NOT advance the iteration — the same call is retried
    // once the limit clears, so the harness picks up exactly where it left off.
    if (result.outcome === "usage_limit") {
      if (parentSignal.aborted) return result;
      usageLimitWaits++;
      const nowMs = Date.now();
      let waitMs: number;
      if (result.resumeAt && result.resumeAt * 1000 > nowMs) {
        waitMs = result.resumeAt * 1000 - nowMs + USAGE_LIMIT_BUFFER_MS;
      } else {
        waitMs = USAGE_LIMIT_DEFAULT_WAIT_MS;
      }
      waitMs = Math.min(waitMs, USAGE_LIMIT_MAX_WAIT_MS);
      reporter.error(
        `Anthropic usage limit reached on ${agentLabel} — pausing for ${Math.round(waitMs / 1000)}s` +
          (usageLimitWaits > 1 ? ` (consecutive pause #${usageLimitWaits})` : ""),
        result.errorMessage,
        "usage_limit",
      );
      reporter.usageLimitWait(result.resumeAt, waitMs, result.errorMessage);
      await emitEvent("usage_limit_pause", {
        phase,
        agentLabel,
        resumeAt: result.resumeAt,
        waitMs,
        consecutive: usageLimitWaits,
        errorMessage: result.errorMessage,
      });
      const pauseStart = Date.now();
      const deadline = pauseStart + waitMs;
      while (!parentSignal.aborted) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(1_000, remaining));
        if (remaining > 1_000) reporter.usageLimitWait(result.resumeAt, deadline - Date.now(), result.errorMessage);
      }
      await emitEvent("usage_limit_resume", {
        phase,
        agentLabel,
        waitedMs: Date.now() - pauseStart,
        aborted: parentSignal.aborted,
      });
      if (parentSignal.aborted) return result;
      reporter.info(`  Usage limit window cleared — retrying ${agentLabel}`);
      continue;
    }

    if (result.outcome !== "transient_error" && result.outcome !== "timeout") return result;
    if (parentSignal.aborted) return result;
    if (attempt > config.maxTransientRetries) return result;
    const delay = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
    reporter.error(
      `${result.outcome} on attempt ${attempt}, retrying in ${delay}ms`,
      result.errorMessage,
      "retry",
    );
    reporter.transientRetry(attempt, delay, result.outcome);
    // Sleep in ~1s slices so the reporter can refresh a countdown. The early
    // exit on parentSignal lets Ctrl+C interrupt the wait promptly.
    const deadline = Date.now() + delay;
    while (!parentSignal.aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(1_000, remaining));
      if (remaining > 1_000) reporter.transientRetry(attempt, deadline - Date.now(), result.outcome);
    }
    attempt++;
  }
  return lastResult!;
}

export async function readPromptFile(path: string): Promise<string> {
  return Bun.file(path).text();
}
