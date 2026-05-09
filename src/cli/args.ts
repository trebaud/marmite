import { resolve } from "path";

export interface CliOverrides {
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
  verbose?: boolean;
}

export function usage(): never {
  console.log(`Usage:
  marmite                            Run the agent loop in the current project (alias: marmite cook)
  marmite cook [options]             Run the agent loop
  marmite init                       Set up marmite in the current project (interactive wizard)
  marmite to-prd <PRD.md>            Convert a markdown PRD into .marmite/prd.json

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
  -v, --verbose               Verbose log output (raw SDK messages and stats)
  -h, --help                  Show this help

Layer order (low → high precedence):
  built-in defaults < config file < CLI flags
`);
  process.exit(0);
}

export function die(msg: string, code = 1): never {
  console.error(`Error: ${msg}`);
  process.exit(code);
}

export function parseIntOrExit(name: string, value: string | undefined, min = 1): number {
  const n = parseInt(value ?? "", 10);
  if (!value || isNaN(n) || n < min) die(`${name} requires an integer >= ${min}, got '${value ?? ""}'`);
  return n;
}

export function parseFloatOrExit(name: string, value: string | undefined, min = 0): number {
  const n = parseFloat(value ?? "");
  if (!value || isNaN(n) || n < min) die(`${name} requires a number >= ${min}, got '${value ?? ""}'`);
  return n;
}

// Accepts "20m", "90s", "500ms", "1h", or a raw number (treated as ms).
export function parseDuration(name: string, v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return v;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(v.trim());
  if (!m) die(`${name}: invalid duration '${v}' (expected e.g. 20m, 90s, 500ms, 1h)`);
  const n = parseFloat(m[1]!);
  const unit = m[2]!;
  return unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
}

export function parseArgs(argv: string[]): { cli: CliOverrides; configPath: string | undefined } {
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
      case "-v": case "--verbose": cli.verbose = true; break;
      default: {
        const n = parseInt(arg, 10);
        if (!isNaN(n) && n > 0) cli.maxIterations = n;
        else die(`Unknown option: ${arg}\nRun with --help for usage.`);
      }
    }
  }
  return { cli, configPath };
}
