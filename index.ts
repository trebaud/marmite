import { resolve, dirname } from "path";
import { mkdirSync, existsSync, readFileSync } from "fs";
import type { HarnessConfig, ModelPricing } from "./.harness/core/types.ts";
import { run } from "./.harness/core/orchestrator.ts";

const DEFAULT_MAX_ITERATIONS = 1000;
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_BUILD_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_FIX_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_ORCHESTRATE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_COST_BUDGET = 15;
const DEFAULT_COST_BUDGET_TOTAL = 0;
const DEFAULT_MAX_FIX_ATTEMPTS = 3;
const DEFAULT_MAX_TRANSIENT_RETRIES = 2;

const scriptDir = dirname(new URL(import.meta.url).pathname);

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-7":   { inputPerMTok: 15,  outputPerMTok: 75,  cacheReadPerMTok: 1.5 },
  "claude-opus-4-6":   { inputPerMTok: 5,   outputPerMTok: 25,  cacheReadPerMTok: 0.5 },
  "claude-sonnet-4-6": { inputPerMTok: 3,   outputPerMTok: 15,  cacheReadPerMTok: 0.3 },
  "claude-haiku-4-5":  { inputPerMTok: 1,   outputPerMTok: 5,   cacheReadPerMTok: 0.1 },
};

interface FileConfig {
  maxIterations?: number;
  prdPath?: string;
  sensorsConfigPath?: string;
  model?: string;
  builderModel?: string;
  verifierModel?: string;
  orchestratorModel?: string;
  pricing?: Record<string, ModelPricing>;
  buildTimeoutMs?: number;
  verifyTimeoutMs?: number;
  fixTimeoutMs?: number;
  orchestrateTimeoutMs?: number;
  costBudgetUsdPerStory?: number;
  costBudgetUsdTotal?: number;
  maxFixAttempts?: number;
  maxTransientRetries?: number;
  resumeIfAvailable?: boolean;
}

function usage(): never {
  console.log(`Usage: bun run index.ts [options]

Orchestrates an autonomous coding agent that builds a project from a PRD.
The agent runs from this directory and writes application code inside app/.

Options:
  -c, --config <path>         Path to JSON config file (default: ./harness.config.json)
  -n, --max-iterations <n>    Maximum iterations
  -p, --prd <path>            Path to prd.json
      --model <id>            Default model ID (fallback for builder/verifier)
      --builder-model <id>    Override model for builder/fix phases
      --verifier-model <id>   Override model for verify phase
      --build-timeout <ms>    Build phase timeout
      --verify-timeout <ms>   Verify phase timeout
      --fix-timeout <ms>      Fix phase timeout
      --cost-budget <usd>     Per-story cost budget, 0 disables
      --cost-budget-total <usd>  Total run cost budget, 0 disables; halts run when exceeded
      --max-fix-attempts <n>  Fix attempts per story
      --retries <n>           Transient retries per session
      --resume / --no-resume  Resume from .harness/state.json if available
  -h, --help                  Show this help

Layer order (low → high precedence):
  built-in defaults < config file < CLI flags
`);
  process.exit(0);
}

function parseIntOrExit(name: string, value: string | undefined, min = 1): number {
  const n = parseInt(value ?? "", 10);
  if (!value || isNaN(n) || n < min) {
    console.error(`Error: ${name} requires an integer >= ${min}, got '${value ?? ""}'`);
    process.exit(1);
  }
  return n;
}

function parseFloatOrExit(name: string, value: string | undefined, min = 0): number {
  const n = parseFloat(value ?? "");
  if (!value || isNaN(n) || n < min) {
    console.error(`Error: ${name} requires a number >= ${min}, got '${value ?? ""}'`);
    process.exit(1);
  }
  return n;
}

function loadConfigFile(path: string): FileConfig {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error(`Error: config file ${path} must contain a JSON object`);
      process.exit(2);
    }
    return parsed as FileConfig;
  } catch (err) {
    console.error(`Error: failed to read config file ${path}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const cli: FileConfig = {};
  let configPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        usage();
        break;
      case "-c":
      case "--config":
        configPath = args[++i];
        if (!configPath) { console.error("Error: --config requires a path"); process.exit(1); }
        break;
      case "-n":
      case "--max-iterations":
        cli.maxIterations = parseIntOrExit("--max-iterations", args[++i]);
        break;
      case "-p":
      case "--prd": {
        const val = args[++i];
        if (!val) { console.error("Error: --prd requires a file path"); process.exit(1); }
        cli.prdPath = resolve(val);
        break;
      }
      case "--model":
        cli.model = args[++i];
        break;
      case "--builder-model":
        cli.builderModel = args[++i];
        break;
      case "--verifier-model":
        cli.verifierModel = args[++i];
        break;
      case "--build-timeout":
        cli.buildTimeoutMs = parseIntOrExit("--build-timeout", args[++i], 1000);
        break;
      case "--verify-timeout":
        cli.verifyTimeoutMs = parseIntOrExit("--verify-timeout", args[++i], 1000);
        break;
      case "--fix-timeout":
        cli.fixTimeoutMs = parseIntOrExit("--fix-timeout", args[++i], 1000);
        break;
      case "--cost-budget":
        cli.costBudgetUsdPerStory = parseFloatOrExit("--cost-budget", args[++i]);
        break;
      case "--cost-budget-total":
        cli.costBudgetUsdTotal = parseFloatOrExit("--cost-budget-total", args[++i]);
        break;
      case "--max-fix-attempts":
        cli.maxFixAttempts = parseIntOrExit("--max-fix-attempts", args[++i], 0);
        break;
      case "--retries":
        cli.maxTransientRetries = parseIntOrExit("--retries", args[++i], 0);
        break;
      case "--resume":
        cli.resumeIfAvailable = true;
        break;
      case "--no-resume":
        cli.resumeIfAvailable = false;
        break;
      default: {
        const n = parseInt(arg, 10);
        if (!isNaN(n) && n > 0) cli.maxIterations = n;
        else { console.error(`Unknown option: ${arg}\nRun with --help for usage.`); process.exit(1); }
      }
    }
  }

  return { cli, configPath };
}

const { cli, configPath } = parseArgs(process.argv);

const resolvedConfigPath = resolve(
  configPath ?? process.env.HARNESS_CONFIG ?? resolve(scriptDir, "harness.config.json"),
);
const fileCfg = loadConfigFile(resolvedConfigPath);

function pick<K extends keyof FileConfig>(key: K, fallback: NonNullable<FileConfig[K]>): NonNullable<FileConfig[K]> {
  return (cli[key] ?? fileCfg[key] ?? fallback) as NonNullable<FileConfig[K]>;
}

const harnessDir = resolve(scriptDir, ".harness");
mkdirSync(harnessDir, { recursive: true });

const model = pick("model", DEFAULT_MODEL);
const pricing = { ...DEFAULT_PRICING, ...(fileCfg.pricing ?? {}) };

const config: HarnessConfig = {
  maxIterations: pick("maxIterations", DEFAULT_MAX_ITERATIONS),
  projectRoot: scriptDir,
  builderMdPath: resolve(scriptDir, ".harness/prompts/builder-prompt.md"),
  verifierMdPath: resolve(scriptDir, ".harness/prompts/verifier-prompt.md"),
  orchestratorMdPath: resolve(scriptDir, ".harness/prompts/orchestrator-prompt.md"),
  prdPath: cli.prdPath ?? (fileCfg.prdPath ? resolve(fileCfg.prdPath) : resolve(scriptDir, "prd.json")),
  sensorsConfigPath: fileCfg.sensorsConfigPath
    ? resolve(fileCfg.sensorsConfigPath)
    : resolve(scriptDir, "sensors/sensors.json"),
  progressPath: resolve(scriptDir, "progress.txt"),
  archiveDir: resolve(scriptDir, "archive"),
  lastBranchPath: resolve(scriptDir, ".last-branch"),
  statePath: resolve(harnessDir, "state.json"),
  eventsPath: resolve(harnessDir, "events.jsonl"),
  currentTaskPath: resolve(scriptDir, "current-task.json"),
  model,
  builderModel: pick("builderModel", model),
  verifierModel: pick("verifierModel", model),
  orchestratorModel: pick("orchestratorModel", model),
  pricing,
  buildTimeoutMs: pick("buildTimeoutMs", DEFAULT_BUILD_TIMEOUT_MS),
  verifyTimeoutMs: pick("verifyTimeoutMs", DEFAULT_VERIFY_TIMEOUT_MS),
  fixTimeoutMs: pick("fixTimeoutMs", DEFAULT_FIX_TIMEOUT_MS),
  orchestrateTimeoutMs: pick("orchestrateTimeoutMs", DEFAULT_ORCHESTRATE_TIMEOUT_MS),
  maxTransientRetries: pick("maxTransientRetries", DEFAULT_MAX_TRANSIENT_RETRIES),
  costBudgetUsdPerStory: pick("costBudgetUsdPerStory", DEFAULT_COST_BUDGET),
  costBudgetUsdTotal: pick("costBudgetUsdTotal", DEFAULT_COST_BUDGET_TOTAL),
  maxFixAttempts: pick("maxFixAttempts", DEFAULT_MAX_FIX_ATTEMPTS),
  resumeIfAvailable: pick("resumeIfAvailable", true),
};

await run(config);
