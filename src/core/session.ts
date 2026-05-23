import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessConfig, ModelPricing, SessionOutcome } from "./types.ts";
import type { Reporter } from "./reporter.ts";
import { classifyError, sleep } from "./utils.ts";
import { PATHS } from "./paths.ts";

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

async function drain(
  config: HarnessConfig,
  model: string,
  q: AsyncIterable<SDKMessage>,
  agentLabel: string,
  reporter: Reporter,
): Promise<{ result: string; sessionId: string; stats: SessionStatsRaw }> {
  let result = "";
  let sessionId = "";
  let stats: SessionStatsRaw = { ...emptyStats };
  for await (const message of q) {
    reporter.message(message, agentLabel);
    if (message.type === "result") {
      const r = message as any;
      if (message.subtype === "success") {
        result = message.result;
        sessionId = r.session_id ?? "";
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
  return { result, sessionId, stats };
}

export async function runQuery(
  config: HarnessConfig,
  prompt: string,
  timeoutMs: number,
  reporter: Reporter,
  resumeId?: string,
  parentSignal?: AbortSignal,
  model: string = config.model,
  agentLabel: string = "harness",
): Promise<SessionResult> {
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
    const options = {
      ...baseOptions(config, model, abort, reporter),
      ...(resumeId ? { resume: resumeId } : {}),
    };
    const q = query({ prompt, options });
    const drained = await drain(config, model, q, agentLabel, reporter);
    return {
      result: drained.result,
      sessionId: drained.sessionId,
      model,
      outcome: "success",
      stats: drained.stats,
    };
  } catch (err) {
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

export async function runQueryWithRetry(
  config: HarnessConfig,
  prompt: string,
  timeoutMs: number,
  resumeId: string | undefined,
  parentSignal: AbortSignal,
  reporter: Reporter,
  model: string = config.model,
  agentLabel: string = "harness",
): Promise<SessionResult> {
  let lastResult: SessionResult | null = null;
  for (let attempt = 1; attempt <= config.maxTransientRetries + 1; attempt++) {
    const result = await runQuery(config, prompt, timeoutMs, reporter, resumeId, parentSignal, model, agentLabel);
    lastResult = result;
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
  }
  return lastResult!;
}

export async function readPromptFile(path: string): Promise<string> {
  return Bun.file(path).text();
}
