import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunStats, SessionStats } from "../core/types.ts";
import type { BranchAction, Reporter } from "../core/reporter.ts";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
  bgCyan: "\x1b[46m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
};

function ts(): string {
  return `${c.gray}${new Date().toISOString()}${c.reset}`;
}

function tag(label: string): string {
  return `${c.cyan}[${label}]${c.reset}`;
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem.toFixed(0)}s`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function outcomeBadge(outcome: string): string {
  switch (outcome) {
    case "success": return `${c.bgGreen}${c.bold} OK ${c.reset}`;
    case "timeout": return `${c.bgYellow}${c.bold} TIMEOUT ${c.reset}`;
    case "transient_error": return `${c.bgYellow}${c.bold} TRANSIENT ${c.reset}`;
    case "fatal_error": return `${c.bgRed}${c.bold} FATAL ${c.reset}`;
    case "aborted": return `${c.bgRed}${c.bold} ABORTED ${c.reset}`;
    default: return outcome;
  }
}

function logStart(maxIterations: number): void {
  console.log(`\nStarting Harness - Max iterations: ${maxIterations}`);
}

function logIterationStart(i: number, max: number, storyId?: string): void {
  console.log("");
  console.log("===============================================================");
  console.log(`  Harness Iteration ${i} of ${max}${storyId ? ` — ${storyId}` : ""}`);
  console.log("===============================================================");
}

function logComplete(iteration: number, max: number): void {
  console.log("");
  console.log("Harness completed all tasks!");
  console.log(`Completed at iteration ${iteration} of ${max}`);
}

function logMaxReached(max: number): void {
  console.log("");
  console.log(`Harness reached max iterations (${max}) without completing all tasks.`);
  console.log("Check .marmite/progress.txt for status.");
}

function logBranchSetup(branchName: string, action: BranchAction): void {
  switch (action) {
    case "created":
      console.log(`Branch ${c.green}created${c.reset}: ${c.cyan}${branchName}${c.reset}`);
      break;
    case "switched":
      console.log(`Branch ${c.yellow}switched${c.reset}: ${c.cyan}${branchName}${c.reset}`);
      break;
    case "already_on":
      console.log(`Branch ${c.dim}already on${c.reset}: ${c.cyan}${branchName}${c.reset}`);
      break;
  }
}

function logFeedbackDetected(bytes: number, preview: string): void {
  const trimmed = preview.replace(/\s+/g, " ").trim().slice(0, 120);
  const ellipsis = preview.length > 120 ? "…" : "";
  console.log("");
  console.log(`${c.bgCyan}${c.bold} 📝 ASYNC FEEDBACK ${c.reset} ${bytes}B — ${c.white}"${trimmed}${ellipsis}"${c.reset}`);
  console.log(`${c.dim}  Will be applied this iteration; orchestrator deletes after consumption.${c.reset}`);
}

function logFeedbackForceCleared(): void {
  console.log(`  ${c.yellow}[feedback]${c.reset} orchestrator did not delete .marmite/feedback.md — force-cleared`);
}

function logBudgetExceeded(storyId: string, spent: number, budget: number): void {
  console.log(`  ${c.bgRed}${c.bold} BUDGET ${c.reset} story=${storyId} spent=$${spent.toFixed(4)} budget=$${budget.toFixed(2)} — stopping fix loop`);
}

function logError(context: string, err: unknown, category: string): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`  ${c.red}[${category}]${c.reset} ${context}: ${msg}`);
}

function logMessage(message: SDKMessage, agentLabel: string = "harness"): void {
  const t = tag(agentLabel);
  const time = ts();

  switch (message.type) {
    case "system":
      if (message.subtype === "init") {
        const msg = message as any;
        console.log(`${time} ${t} ${c.blue}INIT${c.reset} model=${c.white}${msg.model ?? "?"}${c.reset} cwd=${c.white}${message.cwd}${c.reset} v=${message.claude_code_version}`);
        if (msg.tools?.length) {
          console.log(`${time} ${t} ${c.blue}INIT${c.reset} tools=[${msg.tools.join(", ")}]`);
        }
        if (msg.mcp_servers?.length) {
          const mcps = msg.mcp_servers.map((s: any) => `${s.name}(${s.status})`).join(", ");
          console.log(`${time} ${t} ${c.blue}INIT${c.reset} mcp=[${mcps}]`);
        }
      } else if (message.subtype === "status") {
        console.log(`${time} ${t} ${c.blue}STATUS${c.reset} ${message.status}`);
      } else if ((message as any).subtype === "task_notification") {
        const msg = message as any;
        const status = msg.status === "completed" ? `${c.green}${msg.status}${c.reset}` : `${c.red}${msg.status}${c.reset}`;
        console.log(`${time} ${t} ${c.magenta}TASK${c.reset} id=${msg.task_id} ${status} ${msg.summary ?? ""}`);
        if (msg.usage) {
          console.log(`${time} ${t} ${c.magenta}TASK${c.reset}   tokens=${msg.usage.total_tokens} tools=${msg.usage.tool_uses} dur=${msg.usage.duration_ms}ms`);
        }
      } else {
        console.log(`${time} ${t} ${c.blue}SYSTEM${c.reset}/${message.subtype}`);
      }
      break;

    case "assistant": {
      const blocks = message.message.content;
      for (const block of blocks as any[]) {
        if (block.type === "thinking") {
          const preview = block.thinking?.slice(0, 200) ?? "";
          console.log(`${time} ${t} ${c.dim}THINK${c.reset} ${c.gray}${preview}${preview.length >= 200 ? "..." : ""}${c.reset}`);
        } else if (block.type === "text") {
          console.log(`${time} ${t} ${c.green}TEXT${c.reset}  ${block.text}`);
        } else if (block.type === "tool_use") {
          const input = JSON.stringify(block.input ?? {});
          const inputPreview = input.length > 300 ? input.slice(0, 300) + "..." : input;
          console.log(`${time} ${t} ${c.yellow}TOOL${c.reset}  ${c.bold}${block.name}${c.reset} ${c.gray}${inputPreview}${c.reset}`);
        } else {
          console.log(`${time} ${t} ${c.dim}BLOCK${c.reset} type=${block.type}`);
        }
      }
      break;
    }

    case "user": {
      const blocks = (message as any).message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type === "tool_result") {
            const content = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c: any) => c.text ?? `[${c.type}]`).join(" ")
                : "";
            const preview = content.slice(0, 300);
            const status = block.is_error ? `${c.red}ERR${c.reset}` : `${c.green}OK${c.reset}`;
            console.log(`${time} ${t} ${c.dim}RESULT${c.reset} [${status}] ${c.gray}${preview}${content.length > 300 ? "..." : ""}${c.reset}`);
          } else if (block.type === "text") {
            console.log(`${time} ${t} ${c.dim}USER${c.reset}  ${block.text?.slice(0, 200) ?? ""}`);
          }
        }
      } else {
        console.log(`${time} ${t} ${c.dim}USER${c.reset}  (message)`);
      }
      break;
    }

    case "result": {
      const r = message as any;
      if (message.subtype === "success") {
        console.log(`${time} ${t} ${c.bgGreen}${c.bold} DONE ${c.reset} ${message.result.slice(0, 300)}`);
      } else {
        console.log(`${time} ${t} ${c.bgRed}${c.bold} FAIL ${c.reset} ${r.error?.slice(0, 300) ?? "unknown error"}`);
      }
      const cost = r.total_cost_usd != null ? `$${r.total_cost_usd.toFixed(4)}` : "?";
      const dur = r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : "?";
      const durApi = r.duration_api_ms != null ? `${(r.duration_api_ms / 1000).toFixed(1)}s` : "?";
      const turns = r.num_turns ?? "?";
      console.log(`${time} ${t} ${c.cyan}STATS${c.reset} cost=${c.bold}${cost}${c.reset} dur=${dur} api=${durApi} turns=${turns}`);
      if (r.usage) {
        const u = r.usage;
        console.log(`${time} ${t} ${c.cyan}STATS${c.reset} tokens: in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} cache_create=${u.cache_creation_input_tokens ?? 0}`);
      }
      if (r.modelUsage) {
        for (const [model, usage] of Object.entries(r.modelUsage) as [string, any][]) {
          console.log(`${time} ${t} ${c.cyan}MODEL${c.reset} ${model}: $${usage.costUSD?.toFixed(4) ?? "?"} in=${usage.inputTokens ?? 0} out=${usage.outputTokens ?? 0}`);
        }
      }
      break;
    }

    case "tool_progress": {
      const tp = message as any;
      console.log(`${time} ${t} ${c.yellow}PROGRESS${c.reset} ${c.bold}${tp.tool_name}${c.reset} ${tp.elapsed_time_seconds?.toFixed(1) ?? "?"}s`);
      break;
    }

    case "rate_limit_event": {
      const rl = (message as any).rate_limit_info ?? {};
      const status = rl.status === "rejected" ? `${c.red}${rl.status}${c.reset}` : `${c.yellow}${rl.status}${c.reset}`;
      const util = rl.utilization != null ? ` util=${(rl.utilization * 100).toFixed(0)}%` : "";
      const resets = rl.resetsAt ? ` resets=${new Date(rl.resetsAt * 1000).toISOString()}` : "";
      console.log(`${time} ${t} ${c.bgYellow}${c.bold} RATE ${c.reset} ${status}${util}${resets}`);
      break;
    }

    default:
      console.log(`${time} ${t} ${c.dim}${message.type}${"subtype" in message ? `/${(message as any).subtype}` : ""}${c.reset}`);
      break;
  }
}

function logSessionReport(stats: SessionStats): void {
  const label = stats.phase.toUpperCase() + (stats.attempt != null ? ` #${stats.attempt}` : "");
  const line = `${c.cyan}[report]${c.reset}`;
  const flagTxt = stats.anomalyFlags.length > 0
    ? `${c.bgYellow}${c.bold} ⚠ ${stats.anomalyFlags.join(",")} ${c.reset} `
    : "";
  console.log("");
  console.log(`${line} ── ${flagTxt}Session Report: ${c.bold}${label}${c.reset} (iteration ${stats.iteration}) ${outcomeBadge(stats.outcome)} ──`);
  if (stats.errorMessage) {
    console.log(`${line}   Error: ${c.red}${stats.errorMessage.slice(0, 200)}${c.reset}`);
  }
  console.log(`${line}   Cost: ${c.bold}${fmtCost(stats.costUsd)}${c.reset}  Duration: ${fmtDuration(stats.durationMs)} (API: ${fmtDuration(stats.durationApiMs)})  Turns: ${stats.numTurns}`);
  console.log(`${line}   Tokens: in=${fmtTokens(stats.inputTokens)} out=${fmtTokens(stats.outputTokens)} cache_read=${fmtTokens(stats.cacheReadTokens)} cache_create=${fmtTokens(stats.cacheCreateTokens)}`);
}

function logFinalReport(runStats: RunStats): void {
  const elapsed = Date.now() - runStats.startedAt.getTime();
  const totalCost = runStats.sessions.reduce((sum, s) => sum + s.costUsd, 0);
  const totalDuration = runStats.sessions.reduce((sum, s) => sum + s.durationMs, 0);
  const totalApiDuration = runStats.sessions.reduce((sum, s) => sum + s.durationApiMs, 0);
  const totalTurns = runStats.sessions.reduce((sum, s) => sum + s.numTurns, 0);
  const totalIn = runStats.sessions.reduce((sum, s) => sum + s.inputTokens, 0);
  const totalOut = runStats.sessions.reduce((sum, s) => sum + s.outputTokens, 0);
  const totalCacheRead = runStats.sessions.reduce((sum, s) => sum + s.cacheReadTokens, 0);
  const totalCacheCreate = runStats.sessions.reduce((sum, s) => sum + s.cacheCreateTokens, 0);

  const orchestrateSessions = runStats.sessions.filter(s => s.phase === "orchestrate");
  const buildSessions = runStats.sessions.filter(s => s.phase === "build");
  const verifySessions = runStats.sessions.filter(s => s.phase === "verify");
  const fixSessions = runStats.sessions.filter(s => s.phase === "fix");

  const orchestrateCost = orchestrateSessions.reduce((sum, s) => sum + s.costUsd, 0);
  const buildCost = buildSessions.reduce((sum, s) => sum + s.costUsd, 0);
  const verifyCost = verifySessions.reduce((sum, s) => sum + s.costUsd, 0);
  const fixCost = fixSessions.reduce((sum, s) => sum + s.costUsd, 0);

  const outcomes: Record<string, number> = {};
  for (const s of runStats.sessions) {
    outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;
  }

  const sep = "═".repeat(65);
  const line = `${c.cyan}[report]${c.reset}`;

  console.log("");
  console.log(`${line} ${c.bold}${sep}${c.reset}`);
  console.log(`${line} ${c.bold}  HARNESS RUN SUMMARY${c.reset}`);
  console.log(`${line} ${c.bold}${sep}${c.reset}`);
  console.log(`${line}   Wall time:         ${fmtDuration(elapsed)}`);
  console.log(`${line}   Session time:      ${fmtDuration(totalDuration)} (API: ${fmtDuration(totalApiDuration)})`);
  console.log(`${line}   Iterations:        ${runStats.iterationsCompleted}`);
  console.log(`${line}   Sessions:          ${runStats.sessions.length} (orchestrate: ${orchestrateSessions.length}, build: ${buildSessions.length}, verify: ${verifySessions.length}, fix: ${fixSessions.length})`);
  console.log(`${line}   Outcomes:          ${Object.entries(outcomes).map(([k, v]) => `${k}=${v}`).join(", ") || "n/a"}`);
  console.log(`${line}   Stories passed:    ${runStats.storiesPassed}`);
  console.log(`${line}   Stories failed:    ${runStats.storiesFailed}`);
  console.log(`${line}`);
  console.log(`${line}   ${c.bold}Total API Cost:     ${fmtCost(totalCost)}${c.reset}`);
  console.log(`${line}     Orchestrate:     ${fmtCost(orchestrateCost)}`);
  console.log(`${line}     Build:           ${fmtCost(buildCost)}`);
  console.log(`${line}     Verify:          ${fmtCost(verifyCost)}`);
  console.log(`${line}     Fix:             ${fmtCost(fixCost)}`);
  console.log(`${line}`);

  if (runStats.storyOutcomes.length > 0) {
    console.log(`${line}   ${c.bold}Per-story cost:${c.reset}`);
    for (const o of runStats.storyOutcomes) {
      const status = o.passed
        ? `${c.green}PASS${c.reset}`
        : `${c.red}FAIL${c.reset}${o.reason ? ` (${o.reason})` : ""}`;
      console.log(`${line}     ${o.storyId.padEnd(10)} ${status}  ${fmtCost(o.costUsd)}`);
    }
    console.log(`${line}`);
  }

  console.log(`${line}   Total turns:       ${totalTurns}`);
  console.log(`${line}   Tokens:            in=${fmtTokens(totalIn)} out=${fmtTokens(totalOut)}`);
  console.log(`${line}                      cache_read=${fmtTokens(totalCacheRead)} cache_create=${fmtTokens(totalCacheCreate)}`);
  console.log(`${line} ${c.bold}${sep}${c.reset}`);
}

export const consoleReporter: Reporter = {
  start: logStart,
  iterationStart: logIterationStart,
  complete: logComplete,
  maxReached: logMaxReached,
  branchSetup: logBranchSetup,
  feedbackDetected: logFeedbackDetected,
  feedbackForceCleared: logFeedbackForceCleared,
  budgetExceeded: logBudgetExceeded,
  error: logError,
  message: logMessage,
  sessionReport: logSessionReport,
  finalReport: logFinalReport,
  info: (msg) => console.log(msg),
  stderr: (line) => {
    if (line) console.error(`${c.gray}[stderr]${c.reset} ${line}`);
  },
};
