import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunStats, SessionStats } from "../core/types.ts";
import type {
  BranchAction,
  IterationEndOpts,
  Phase,
  PhaseStartOpts,
  Reporter,
} from "../core/reporter.ts";

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

// ───────────────────────────── Verbose reporter ─────────────────────────────
// Raw, timestamped firehose: every SDK message, every session stat. Useful for
// debugging the harness itself.

function vStart(maxIterations: number): void {
  console.log(`\nStarting Harness - Max iterations: ${maxIterations}`);
}

function vIterationStart(i: number, max: number, storyId?: string, storyTitle?: string): void {
  const titleSuffix = storyId ? ` — ${storyId}${storyTitle ? `: ${storyTitle}` : ""}` : "";
  console.log("");
  console.log("===============================================================");
  console.log(`  Harness Iteration ${i} of ${max}${titleSuffix}`);
  console.log("===============================================================");
}

function vIterationEnd(opts: IterationEndOpts): void {
  if (opts.passed) {
    console.log(`Story ${opts.storyId} passed verification at iteration ${opts.iteration} (${fmtDuration(opts.durationMs)}, ${fmtCost(opts.costUsd)}).`);
  } else {
    console.log(`Story ${opts.storyId} did NOT pass (${opts.reason ?? "unknown"}) after ${opts.fixAttempts} fix attempt(s) (${fmtDuration(opts.durationMs)}, ${fmtCost(opts.costUsd)}). Moving on.`);
  }
}

function vAborted(): void {
  console.log("");
  console.log(`${c.bgRed}${c.bold} ABORTED ${c.reset} run interrupted by signal`);
}

function vGitCommit(sha: string, message: string): void {
  const tag = sha ? `${c.gray}[${sha}]${c.reset} ` : "";
  console.log(`  ${c.cyan}[git]${c.reset} ${tag}${message}`);
}

function vPhaseStart(phase: Phase, opts: PhaseStartOpts): void {
  switch (phase) {
    case "orchestrate":
      console.log("");
      console.log(`  Phase: ORCHESTRATE (iteration ${opts.iteration})`);
      console.log("===============================================================");
      return;
    case "build":
      console.log("  Phase: BUILD");
      console.log("===============================================================");
      return;
    case "verify":
      console.log("");
      console.log("---------------------------------------------------------------");
      console.log(`  Phase: VERIFY (iteration ${opts.iteration}, attempt ${opts.attempt})`);
      console.log("---------------------------------------------------------------");
      return;
    case "fix":
      console.log("");
      console.log("---------------------------------------------------------------");
      console.log(`  Phase: FIX (iteration ${opts.iteration}, fix ${opts.attempt} of ${opts.maxAttempts})`);
      console.log("---------------------------------------------------------------");
      return;
  }
}

function vComplete(iteration: number, max: number): void {
  console.log("");
  console.log("Harness completed all tasks!");
  console.log(`Completed at iteration ${iteration} of ${max}`);
}

function vMaxReached(max: number): void {
  console.log("");
  console.log(`Harness reached max iterations (${max}) without completing all tasks.`);
  console.log("Check .marmite/progress.txt for status.");
}

function vBranchSetup(branchName: string, action: BranchAction): void {
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

function vFeedbackDetected(bytes: number, preview: string): void {
  const trimmed = preview.replace(/\s+/g, " ").trim().slice(0, 120);
  const ellipsis = preview.length > 120 ? "…" : "";
  console.log("");
  console.log(`${c.bgCyan}${c.bold} 📝 ASYNC FEEDBACK ${c.reset} ${bytes}B — ${c.white}"${trimmed}${ellipsis}"${c.reset}`);
  console.log(`${c.dim}  Will be applied this iteration; orchestrator deletes after consumption.${c.reset}`);
}

function vFeedbackForceCleared(): void {
  console.log(`  ${c.yellow}[feedback]${c.reset} orchestrator did not delete .marmite/feedback.md — force-cleared`);
}

function vSensorStart(sensor: string, sensorType?: string): void {
  const typeTag = sensorType ? ` ${c.dim}(${sensorType})${c.reset}` : "";
  console.log(`  ${c.cyan}[sensor]${c.reset} ▸ ${c.bold}${sensor}${c.reset}${typeTag} running…`);
}

function vSensorEnd(sensor: string, sensorType: string | undefined, durationMs: number, exitCode: number): void {
  const typeTag = sensorType ? ` ${c.dim}(${sensorType})${c.reset}` : "";
  const ok = exitCode === 0;
  const sym = ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
  const exitTxt = ok ? "" : ` ${c.red}exit=${exitCode}${c.reset}`;
  console.log(`  ${c.cyan}[sensor]${c.reset} ${sym} ${c.bold}${sensor}${c.reset}${typeTag} ${c.dim}(${fmtDuration(durationMs)})${c.reset}${exitTxt}`);
}

function vBudgetExceeded(storyId: string, spent: number, budget: number): void {
  console.log(`  ${c.bgRed}${c.bold} BUDGET ${c.reset} story=${storyId} spent=$${spent.toFixed(4)} budget=$${budget.toFixed(2)} — stopping fix loop`);
}

function vError(context: string, err: unknown, category: string): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`  ${c.red}[${category}]${c.reset} ${context}: ${msg}`);
}

function vMessage(message: SDKMessage, agentLabel: string = "harness"): void {
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

function vSessionReport(stats: SessionStats): void {
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

function vFinalReport(runStats: RunStats): void {
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

export const verboseReporter: Reporter = {
  start: vStart,
  iterationStart: vIterationStart,
  iterationEnd: vIterationEnd,
  phaseStart: vPhaseStart,
  complete: vComplete,
  maxReached: vMaxReached,
  aborted: vAborted,
  branchSetup: vBranchSetup,
  gitCommit: vGitCommit,
  feedbackDetected: vFeedbackDetected,
  feedbackForceCleared: vFeedbackForceCleared,
  sensorStart: vSensorStart,
  sensorEnd: vSensorEnd,
  budgetExceeded: vBudgetExceeded,
  error: vError,
  message: vMessage,
  sessionReport: vSessionReport,
  finalReport: vFinalReport,
  info: (msg) => console.log(msg),
  stderr: (line) => {
    if (line) console.error(`${c.gray}[stderr]${c.reset} ${line}`);
  },
};

// ───────────────────────────── Terse reporter ─────────────────────────────
// Append-only progression of named steps. The active step animates a spinner
// on the bottom line; completed steps stay in the scrollback as ✓/✗ entries.
// Anything else from the SDK (raw messages, per-session stats) is hidden;
// re-run with --verbose to surface it.

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;
let spinnerLabel = "";
let spinnerStartedAt = 0;
// Cumulative cost across all completed sessions in this run; rendered next to
// the active spinner so the user always sees how much the run has spent.
let runCostUsd = 0;

function drawSpinner(): void {
  const elapsed = Date.now() - spinnerStartedAt;
  const meta: string[] = [];
  if (elapsed > 1500) meta.push(fmtDuration(elapsed));
  if (runCostUsd > 0) meta.push(`$${runCostUsd.toFixed(2)}`);
  const metaTxt = meta.length ? ` ${c.dim}${meta.join(" · ")}${c.reset}` : "";
  process.stdout.write(`\r\x1b[K  ${c.cyan}${SPINNER_FRAMES[spinnerFrame]}${c.reset} ${spinnerLabel}${metaTxt}`);
}

function startSpinner(label: string): void {
  spinnerLabel = label;
  spinnerStartedAt = Date.now();
  if (spinnerTimer) {
    drawSpinner();
    return;
  }
  spinnerFrame = 0;
  drawSpinner();
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    drawSpinner();
  }, 100);
}

function clearSpinner(): void {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
  process.stdout.write("\r\x1b[K");
}

// Append a permanent line to the transcript without losing the active spinner.
function emitLine(line: string): void {
  const wasActive = spinnerTimer != null;
  const savedLabel = spinnerLabel;
  clearSpinner();
  process.stdout.write(line + "\n");
  if (wasActive) startSpinner(savedLabel);
}

let terseMaxIterations = 0;

function tStart(maxIterations: number): void {
  terseMaxIterations = maxIterations;
  runCostUsd = 0;
  emitLine("");
  emitLine(`${c.bold}marmite${c.reset} ${c.dim}cook${c.reset}  ${c.gray}max ${maxIterations} iterations · Ctrl+C to abort${c.reset}`);
}

function tIterationStart(_iteration: number, _max: number, storyId?: string, storyTitle?: string): void {
  // Fires after orchestrate, before build. Surface the chosen story so the
  // build/verify lines below have context.
  if (!storyId) return;
  const title = storyTitle ? `  ${c.dim}${storyTitle}${c.reset}` : "";
  emitLine(`  ${c.cyan}▸${c.reset} ${c.bold}${storyId}${c.reset}${title}`);
}

function tIterationEnd(opts: IterationEndOpts): void {
  clearSpinner();
  const sym = opts.passed ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
  const verb = opts.passed
    ? `${c.green}passed${c.reset}`
    : `${c.red}failed${c.reset}${opts.reason ? ` ${c.dim}(${opts.reason})${c.reset}` : ""}`;
  const fixSuffix = !opts.passed && opts.fixAttempts > 0 ? ` ${c.dim}after ${opts.fixAttempts} fix${opts.fixAttempts === 1 ? "" : "es"}${c.reset}` : "";
  emitLine(`  ${sym} Iteration ${opts.iteration} — ${c.bold}${opts.storyId}${c.reset} ${verb} ${c.dim}(${fmtDuration(opts.durationMs)}, ${fmtCost(opts.costUsd)})${c.reset}${fixSuffix}`);
}

function phaseLabel(phase: Phase, opts: PhaseStartOpts): string {
  switch (phase) {
    case "orchestrate":
      return `orchestrating ${c.dim}(picking next story)${c.reset}`;
    case "build":
      return `building ${c.bold}${opts.storyId ?? ""}${c.reset}`;
    case "verify":
      return `verifying ${c.bold}${opts.storyId ?? ""}${c.reset} ${c.dim}(attempt ${opts.attempt})${c.reset}`;
    case "fix":
      return `fixing ${c.bold}${opts.storyId ?? ""}${c.reset} ${c.dim}(${opts.attempt}/${opts.maxAttempts})${c.reset}`;
  }
}

function tPhaseStart(phase: Phase, opts: PhaseStartOpts): void {
  if (phase === "orchestrate") {
    emitLine("");
    const max = terseMaxIterations || opts.iteration;
    emitLine(`${c.bold}━━ Iteration ${opts.iteration}${max ? ` of ${max}` : ""} ━━${c.reset}`);
  }
  startSpinner(phaseLabel(phase, opts));
}

function tComplete(iteration: number, max: number): void {
  clearSpinner();
  emitLine("");
  emitLine(`${c.green}${c.bold}✓ all stories passing${c.reset} ${c.dim}— done at iteration ${iteration} of ${max}${c.reset}`);
}

function tMaxReached(max: number): void {
  clearSpinner();
  emitLine("");
  emitLine(`${c.yellow}${c.bold}⚠ stopped${c.reset} ${c.dim}— reached max iterations (${max}) without finishing all stories${c.reset}`);
}

function tAborted(): void {
  clearSpinner();
  emitLine("");
  emitLine(`${c.yellow}${c.bold}⊘ aborted${c.reset} ${c.dim}— interrupted by user${c.reset}`);
}

function tGitCommit(sha: string, _message: string): void {
  const tag = sha ? `${c.cyan}${sha}${c.reset}` : "";
  emitLine(`    ${c.dim}↳ committed${c.reset} ${tag}`);
}

function tBranchSetup(branchName: string, action: BranchAction): void {
  const verb = action === "created" ? "created" : action === "switched" ? "switched to" : "on";
  emitLine(`  ${c.gray}branch ${verb}${c.reset} ${c.cyan}${branchName}${c.reset}`);
}

function tFeedbackDetected(bytes: number, preview: string): void {
  const trimmed = preview.replace(/\s+/g, " ").trim().slice(0, 80);
  const ellipsis = preview.length > 80 ? "…" : "";
  emitLine(`  ${c.cyan}📝 feedback${c.reset} ${c.dim}${bytes}B${c.reset} "${trimmed}${ellipsis}"`);
}

function tFeedbackForceCleared(): void {
  // Skipped in terse — surface only via --verbose.
}

function tSensorStart(sensor: string, sensorType?: string): void {
  const typeTag = sensorType ? ` ${c.dim}(${sensorType})${c.reset}` : "";
  emitLine(`    ${c.cyan}▸${c.reset} sensor ${c.bold}${sensor}${c.reset}${typeTag} ${c.dim}running…${c.reset}`);
}

function tSensorEnd(sensor: string, sensorType: string | undefined, durationMs: number, exitCode: number): void {
  const typeTag = sensorType ? ` ${c.dim}(${sensorType})${c.reset}` : "";
  const ok = exitCode === 0;
  const sym = ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
  const exitTxt = ok ? "" : ` ${c.red}exit=${exitCode}${c.reset}`;
  emitLine(`    ${sym} sensor ${c.bold}${sensor}${c.reset}${typeTag} ${c.dim}(${fmtDuration(durationMs)})${c.reset}${exitTxt}`);
}

function tBudgetExceeded(storyId: string, spent: number, budget: number): void {
  emitLine(`  ${c.red}✗ budget${c.reset} ${c.dim}${storyId} spent=$${spent.toFixed(4)} / $${budget.toFixed(2)} — stopping fix loop${c.reset}`);
}

function tError(context: string, err: unknown, category: string): void {
  const msg = err instanceof Error ? err.message : err ? String(err) : "";
  const tail = msg ? `: ${msg}` : "";
  emitLine(`  ${c.red}✗ ${category}${c.reset} ${context}${tail}`);
}

function tSessionReport(stats: SessionStats): void {
  // End of a phase. Stop the active spinner and append a permanent line.
  clearSpinner();
  runCostUsd += stats.costUsd;
  const attempt = stats.attempt != null ? ` ${c.dim}#${stats.attempt}${c.reset}` : "";
  if (stats.outcome === "aborted") {
    process.stdout.write(`  ${c.yellow}⊘${c.reset} ${stats.phase}${attempt} ${c.dim}aborted${c.reset}\n`);
    return;
  }
  const ok = stats.outcome === "success";
  const sym = ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
  const dur = fmtDuration(stats.durationMs);
  const cost = fmtCost(stats.costUsd);
  const outcome = ok ? "" : ` ${c.red}${stats.outcome}${c.reset}`;
  process.stdout.write(`  ${sym} ${stats.phase}${attempt} ${c.dim}(${dur}, ${cost})${c.reset}${outcome}\n`);
}

function tFinalReport(runStats: RunStats): void {
  clearSpinner();
  const elapsed = Date.now() - runStats.startedAt.getTime();
  const totalCost = runStats.sessions.reduce((sum, s) => sum + s.costUsd, 0);
  const passed = runStats.storiesPassed;
  const failed = runStats.storiesFailed;
  emitLine("");
  emitLine(`${c.dim}───────────────────────────────${c.reset}`);
  emitLine(`  ${c.green}${passed} passed${c.reset}${failed > 0 ? `, ${c.red}${failed} failed${c.reset}` : ""}  ${c.dim}· ${fmtCost(totalCost)} · ${fmtDuration(elapsed)} · ${runStats.sessions.length} sessions${c.reset}`);
  if (runStats.storyOutcomes.length > 0) {
    for (const o of runStats.storyOutcomes) {
      const sym = o.passed ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
      const reason = !o.passed && o.reason ? ` ${c.dim}(${o.reason})${c.reset}` : "";
      emitLine(`    ${sym} ${o.storyId.padEnd(12)} ${c.dim}${fmtCost(o.costUsd)}${c.reset}${reason}`);
    }
  }
  emitLine(`${c.dim}───────────────────────────────${c.reset}`);
}

function tInfo(msg: string): void {
  const trimmed = msg.replace(/\s+$/, "");
  if (!trimmed.trim()) return;
  // Drop legacy banner shapes if any caller still emits them.
  const t = trimmed.trim();
  if (/^={3,}$/.test(t) || /^-{3,}$/.test(t)) return;
  emitLine(`  ${c.dim}${trimmed.replace(/^\s+/, "")}${c.reset}`);
}

export const terseReporter: Reporter = {
  start: tStart,
  iterationStart: tIterationStart,
  iterationEnd: tIterationEnd,
  phaseStart: tPhaseStart,
  complete: tComplete,
  maxReached: tMaxReached,
  aborted: tAborted,
  branchSetup: tBranchSetup,
  gitCommit: tGitCommit,
  feedbackDetected: tFeedbackDetected,
  feedbackForceCleared: tFeedbackForceCleared,
  sensorStart: tSensorStart,
  sensorEnd: tSensorEnd,
  budgetExceeded: tBudgetExceeded,
  error: tError,
  message: () => {},
  sessionReport: tSessionReport,
  finalReport: tFinalReport,
  info: tInfo,
  stderr: () => {},
};

export function pickReporter(verbose: boolean): Reporter {
  return verbose ? verboseReporter : terseReporter;
}
