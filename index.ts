#!/usr/bin/env bun
import { resolve, dirname } from "path";
import { mkdirSync, existsSync, readFileSync } from "fs";
import type { HarnessConfig, ModelPricing } from "./.harness/core/types.ts";
import { run } from "./.harness/core/orchestrator.ts";
import { setUserRoot } from "./.harness/core/paths.ts";
import { MarmiteConfigSchema, formatConfigError, type MarmiteConfig } from "./.harness/core/config.ts";
import { runInit } from "./.harness/core/init.ts";

const DEFAULTS = {
  maxIterations: 1000,
  model: "claude-sonnet-4-6",
  timeouts: { build: "20m", verify: "10m", fix: "15m", orchestrate: "10m" },
  budget: { perStory: 15, total: 0 },
  retries: { fix: 3, transient: 2 },
  resume: true,
  app: "./app",
  prd: "./prd.json",
};

const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-7":   { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5 },
  "claude-opus-4-6":   { inputPerMTok: 5,  outputPerMTok: 25, cacheReadPerMTok: 0.5 },
  "claude-sonnet-4-6": { inputPerMTok: 3,  outputPerMTok: 15, cacheReadPerMTok: 0.3 },
  "claude-haiku-4-5":  { inputPerMTok: 1,  outputPerMTok: 5,  cacheReadPerMTok: 0.1 },
};

interface CliOverrides {
  maxIterations?: number;
  prd?: string;
  model?: string;
  builderModel?: string;
  verifierModel?: string;
  buildTimeoutMs?: number;
  verifyTimeoutMs?: number;
  fixTimeoutMs?: number;
  perStoryBudget?: number;
  totalBudget?: number;
  maxFixAttempts?: number;
  transientRetries?: number;
  resume?: boolean;
}

function usage(): never {
  console.log(`Usage:
  marmite                            Run the agent loop in the current project (alias: marmite cook)
  marmite cook [options]             Run the agent loop
  marmite init                       Set up marmite in the current project (interactive wizard)

Options for cook:
  -c, --config <path>         Path to JSON config file (default: ./marmite.json)
  -n, --max-iterations <n>    Maximum iterations
  -p, --prd <path>            Path to prd.json
      --model <id>            Default model ID (fallback for builder/verifier)
      --builder-model <id>    Override model for builder/fix phases
      --verifier-model <id>   Override model for verify phase
      --build-timeout <dur>   Build phase timeout (e.g. 20m, 600s, 900000)
      --verify-timeout <dur>  Verify phase timeout
      --fix-timeout <dur>     Fix phase timeout
      --cost-budget <usd>     Per-story cost budget, 0 disables
      --cost-budget-total <usd>  Total run cost budget, 0 disables
      --max-fix-attempts <n>  Fix attempts per story
      --retries <n>           Transient retries per session
      --resume / --no-resume  Resume from .marmite/state.json if available
  -h, --help                  Show this help

Layer order (low → high precedence):
  built-in defaults < config file < CLI flags
`);
  process.exit(0);
}

function die(msg: string, code = 1): never {
  console.error(`Error: ${msg}`);
  process.exit(code);
}

function parseIntOrExit(name: string, value: string | undefined, min = 1): number {
  const n = parseInt(value ?? "", 10);
  if (!value || isNaN(n) || n < min) die(`${name} requires an integer >= ${min}, got '${value ?? ""}'`);
  return n;
}

function parseFloatOrExit(name: string, value: string | undefined, min = 0): number {
  const n = parseFloat(value ?? "");
  if (!value || isNaN(n) || n < min) die(`${name} requires a number >= ${min}, got '${value ?? ""}'`);
  return n;
}

// Accepts "20m", "90s", "500ms", "1h", or a raw number (treated as ms).
function parseDuration(name: string, v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return v;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(v.trim());
  if (!m) die(`${name}: invalid duration '${v}' (expected e.g. 20m, 90s, 500ms, 1h)`);
  const n = parseFloat(m[1]!);
  const unit = m[2]!;
  return unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
}

// Strip // line comments, /* */ block comments, and trailing commas — JSONC like tsconfig.
function stripJsonc(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (ch === '"') {
      const start = i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        i++;
      }
      out += src.slice(start, i);
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function loadConfigFile(path: string): MarmiteConfig {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(readFileSync(path, "utf-8")));
  } catch (err) {
    die(`failed to read config file ${path}: ${err instanceof Error ? err.message : String(err)}`, 2);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    die(`config file ${path} must contain a JSON object`, 2);
  }
  const result = MarmiteConfigSchema.safeParse(parsed);
  if (!result.success) {
    die(`config file ${path} failed schema validation: ${formatConfigError(result.error)}`, 2);
  }
  return result.data;
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  // Strip a leading `cook` subcommand if present — it's the default and harmless to omit.
  if (args[0] === "cook") args.shift();

  const cli: CliOverrides = {};
  let configPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = () => args[++i];
    switch (arg) {
      case "-h": case "--help": usage();
      case "-c": case "--config":
        configPath = next();
        if (!configPath) die("--config requires a path");
        break;
      case "-n": case "--max-iterations":
        cli.maxIterations = parseIntOrExit("--max-iterations", next()); break;
      case "-p": case "--prd": {
        const v = next(); if (!v) die("--prd requires a file path");
        cli.prd = resolve(v); break;
      }
      case "--model":          cli.model = next(); break;
      case "--builder-model":  cli.builderModel = next(); break;
      case "--verifier-model": cli.verifierModel = next(); break;
      case "--build-timeout":  cli.buildTimeoutMs = parseDuration("--build-timeout", next()); break;
      case "--verify-timeout": cli.verifyTimeoutMs = parseDuration("--verify-timeout", next()); break;
      case "--fix-timeout":    cli.fixTimeoutMs = parseDuration("--fix-timeout", next()); break;
      case "--cost-budget":       cli.perStoryBudget = parseFloatOrExit("--cost-budget", next()); break;
      case "--cost-budget-total": cli.totalBudget = parseFloatOrExit("--cost-budget-total", next()); break;
      case "--max-fix-attempts":  cli.maxFixAttempts = parseIntOrExit("--max-fix-attempts", next(), 0); break;
      case "--retries":           cli.transientRetries = parseIntOrExit("--retries", next(), 0); break;
      case "--resume":    cli.resume = true; break;
      case "--no-resume": cli.resume = false; break;
      default: {
        const n = parseInt(arg, 10);
        if (!isNaN(n) && n > 0) cli.maxIterations = n;
        else die(`Unknown option: ${arg}\nRun with --help for usage.`);
      }
    }
  }
  return { cli, configPath };
}

// ── Subcommand dispatch ──
const subcommand = process.argv[2];
if (subcommand === "init") {
  await runInit();
  process.exit(0);
}
if (subcommand === "-h" || subcommand === "--help") usage();

const { cli, configPath } = parseArgs(process.argv);

// Detect legacy filename in CWD and guide users to migrate.
if (!configPath && !process.env.HARNESS_CONFIG) {
  const legacy = resolve(process.cwd(), "harness.config.json");
  const current = resolve(process.cwd(), "marmite.json");
  if (existsSync(legacy) && !existsSync(current)) {
    die(`found legacy harness.config.json — rename it to marmite.json and restructure keys (see README).`, 2);
  }
}

const resolvedConfigPath = resolve(
  configPath ?? process.env.HARNESS_CONFIG ?? resolve(process.cwd(), "marmite.json"),
);
const configDir = existsSync(resolvedConfigPath) ? dirname(resolvedConfigPath) : process.cwd();
const fileCfg = loadConfigFile(resolvedConfigPath);

// Anchor all user paths (state, events, progress, current-task, prompt overrides)
// to the directory containing marmite.json. Must happen before orchestrator.run.
setUserRoot(configDir);

function fromConfig<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback;
}
function resolveFromConfig(p: string): string {
  return resolve(configDir, p);
}

mkdirSync(resolve(configDir, ".marmite"), { recursive: true });

const model = cli.model ?? fileCfg.models?.default ?? DEFAULTS.model;
const appPath = resolveFromConfig(fromConfig(fileCfg.app, DEFAULTS.app));
const prdPath = cli.prd ?? (fileCfg.prd ? resolveFromConfig(fileCfg.prd) : resolveFromConfig(DEFAULTS.prd));

const config: HarnessConfig = {
  maxIterations: cli.maxIterations ?? fromConfig(fileCfg.maxIterations, DEFAULTS.maxIterations),
  appPath,
  prdPath,
  model,
  builderModel: cli.builderModel ?? fileCfg.models?.builder ?? model,
  verifierModel: cli.verifierModel ?? fileCfg.models?.verifier ?? model,
  orchestratorModel: fileCfg.models?.orchestrator ?? model,
  pricing: PRICING,
  buildTimeoutMs: cli.buildTimeoutMs ?? parseDuration("timeouts.build", fileCfg.timeouts?.build) ?? parseDuration("", DEFAULTS.timeouts.build)!,
  verifyTimeoutMs: cli.verifyTimeoutMs ?? parseDuration("timeouts.verify", fileCfg.timeouts?.verify) ?? parseDuration("", DEFAULTS.timeouts.verify)!,
  fixTimeoutMs: cli.fixTimeoutMs ?? parseDuration("timeouts.fix", fileCfg.timeouts?.fix) ?? parseDuration("", DEFAULTS.timeouts.fix)!,
  orchestrateTimeoutMs: parseDuration("timeouts.orchestrate", fileCfg.timeouts?.orchestrate) ?? parseDuration("", DEFAULTS.timeouts.orchestrate)!,
  maxTransientRetries: cli.transientRetries ?? fromConfig(fileCfg.retries?.transient, DEFAULTS.retries.transient),
  costBudgetUsdPerStory: cli.perStoryBudget ?? fromConfig(fileCfg.budget?.perStory, DEFAULTS.budget.perStory),
  costBudgetUsdTotal: cli.totalBudget ?? fromConfig(fileCfg.budget?.total, DEFAULTS.budget.total),
  maxFixAttempts: cli.maxFixAttempts ?? fromConfig(fileCfg.retries?.fix, DEFAULTS.retries.fix),
  resumeIfAvailable: cli.resume ?? fromConfig(fileCfg.resume, DEFAULTS.resume),
};

await run(config);
