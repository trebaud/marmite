import { resolve, dirname } from "path";
import { mkdirSync } from "fs";
import type { HarnessConfig, ModelPricing } from "./.harness/core/types.ts";
import { run } from "./.harness/core/orchestrator.ts";

const DEFAULT_MAX_ITERATIONS = 1000;
const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_BUILD_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_FIX_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_COST_BUDGET = 15;
const DEFAULT_MAX_FIX_ATTEMPTS = 3;
const DEFAULT_MAX_TRANSIENT_RETRIES = 2;

const scriptDir = dirname(new URL(import.meta.url).pathname);

// Pricing table in $/Mtok. Values approximate public list prices; override via --pricing or env.
const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-7":   { inputPerMTok: 15,  outputPerMTok: 75,  cacheReadPerMTok: 1.5 },
  "claude-opus-4-6":   { inputPerMTok: 5,   outputPerMTok: 25,  cacheReadPerMTok: 0.5 },
  "claude-sonnet-4-6": { inputPerMTok: 3,   outputPerMTok: 15,  cacheReadPerMTok: 0.3 },
  "claude-haiku-4-5":  { inputPerMTok: 1,   outputPerMTok: 5,   cacheReadPerMTok: 0.1 },
};

function pricingFor(model: string): ModelPricing {
  return PRICING[model] ?? PRICING["claude-opus-4-7"]!;
}

function usage(): never {
  console.log(`Usage: bun run index.ts [options]

Orchestrates an autonomous coding agent that builds a project from a PRD.
The agent runs from this directory and writes application code inside app/.

Options:
  -n, --max-iterations <n>    Maximum iterations (default: ${DEFAULT_MAX_ITERATIONS})
  -p, --prd <path>            Path to prd.json (default: ./prd.json)
      --model <id>            Model ID (default: ${DEFAULT_MODEL})
      --build-timeout <ms>    Build phase timeout (default: ${DEFAULT_BUILD_TIMEOUT_MS})
      --verify-timeout <ms>   Verify phase timeout (default: ${DEFAULT_VERIFY_TIMEOUT_MS})
      --fix-timeout <ms>      Fix phase timeout (default: ${DEFAULT_FIX_TIMEOUT_MS})
      --cost-budget <usd>     Per-story cost budget, 0 disables (default: ${DEFAULT_COST_BUDGET})
      --max-fix-attempts <n>  Fix attempts per story (default: ${DEFAULT_MAX_FIX_ATTEMPTS})
      --retries <n>           Transient retries per session (default: ${DEFAULT_MAX_TRANSIENT_RETRIES})
      --resume                Resume from .harness/state.json if available
      --no-resume             Ignore existing state file
  -h, --help                  Show this help

Environment:
  HARNESS_MODEL               Equivalent to --model
  HARNESS_COST_BUDGET         Equivalent to --cost-budget
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

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let prdPath: string | undefined;
  let model = process.env.HARNESS_MODEL ?? DEFAULT_MODEL;
  let buildTimeoutMs = DEFAULT_BUILD_TIMEOUT_MS;
  let verifyTimeoutMs = DEFAULT_VERIFY_TIMEOUT_MS;
  let fixTimeoutMs = DEFAULT_FIX_TIMEOUT_MS;
  let costBudget = process.env.HARNESS_COST_BUDGET ? parseFloat(process.env.HARNESS_COST_BUDGET) : DEFAULT_COST_BUDGET;
  let maxFixAttempts = DEFAULT_MAX_FIX_ATTEMPTS;
  let retries = DEFAULT_MAX_TRANSIENT_RETRIES;
  let resumeIfAvailable = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        usage();
        break;
      case "-n":
      case "--max-iterations":
        maxIterations = parseIntOrExit("--max-iterations", args[++i]);
        break;
      case "-p":
      case "--prd": {
        const val = args[++i];
        if (!val) {
          console.error("Error: --prd requires a file path");
          process.exit(1);
        }
        prdPath = resolve(val);
        break;
      }
      case "--model":
        model = args[++i] ?? model;
        break;
      case "--build-timeout":
        buildTimeoutMs = parseIntOrExit("--build-timeout", args[++i], 1000);
        break;
      case "--verify-timeout":
        verifyTimeoutMs = parseIntOrExit("--verify-timeout", args[++i], 1000);
        break;
      case "--fix-timeout":
        fixTimeoutMs = parseIntOrExit("--fix-timeout", args[++i], 1000);
        break;
      case "--cost-budget":
        costBudget = parseFloatOrExit("--cost-budget", args[++i]);
        break;
      case "--max-fix-attempts":
        maxFixAttempts = parseIntOrExit("--max-fix-attempts", args[++i], 0);
        break;
      case "--retries":
        retries = parseIntOrExit("--retries", args[++i], 0);
        break;
      case "--resume":
        resumeIfAvailable = true;
        break;
      case "--no-resume":
        resumeIfAvailable = false;
        break;
      default: {
        const n = parseInt(arg, 10);
        if (!isNaN(n) && n > 0) {
          maxIterations = n;
        } else {
          console.error(`Unknown option: ${arg}\nRun with --help for usage.`);
          process.exit(1);
        }
      }
    }
  }

  return {
    maxIterations,
    prdPath,
    model,
    buildTimeoutMs,
    verifyTimeoutMs,
    fixTimeoutMs,
    costBudget,
    maxFixAttempts,
    retries,
    resumeIfAvailable,
  };
}

const parsed = parseArgs(process.argv);

const harnessDir = resolve(scriptDir, ".harness");
mkdirSync(harnessDir, { recursive: true });

const config: HarnessConfig = {
  maxIterations: parsed.maxIterations,
  projectRoot: scriptDir,
  builderMdPath: resolve(scriptDir, ".harness/prompts/builder-prompt.md"),
  verifierMdPath: resolve(scriptDir, ".harness/prompts/verifier-prompt.md"),
  prdPath: parsed.prdPath ?? resolve(scriptDir, "prd.json"),
  progressPath: resolve(scriptDir, "progress.txt"),
  archiveDir: resolve(scriptDir, "archive"),
  lastBranchPath: resolve(scriptDir, ".last-branch"),
  statePath: resolve(harnessDir, "state.json"),
  eventsPath: resolve(harnessDir, "events.jsonl"),
  verificationResultsPath: resolve(scriptDir, "verification-results.json"),
  lastStoryPath: resolve(scriptDir, "last-story.txt"),
  buildStatusPath: resolve(scriptDir, "build-status.json"),
  model: parsed.model,
  pricing: pricingFor(parsed.model),
  buildTimeoutMs: parsed.buildTimeoutMs,
  verifyTimeoutMs: parsed.verifyTimeoutMs,
  fixTimeoutMs: parsed.fixTimeoutMs,
  maxTransientRetries: parsed.retries,
  costBudgetUsdPerStory: parsed.costBudget,
  maxFixAttempts: parsed.maxFixAttempts,
  resumeIfAvailable: parsed.resumeIfAvailable,
};

await run(config);
