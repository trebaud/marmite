import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { MarmiteConfigSchema, formatConfigError, type MarmiteConfig } from "../core/config.ts";
import type { HarnessConfig, ModelPricing } from "../core/types.ts";
import type { CliOverrides } from "./args.ts";
import { die, parseDuration } from "./args.ts";

export const DEFAULTS = {
  maxIterations: 1000,
  model: "claude-sonnet-4-6",
  timeouts: { build: "20m", verify: "10m", fix: "15m", orchestrate: "10m" },
  budget: { perStory: 15, total: 0 },
  retries: { fix: 3, transient: 2 },
  app: "./app",
  prd: "./.marmite/prd.json",
};

export const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-7":   { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5 },
  "claude-opus-4-6":   { inputPerMTok: 5,  outputPerMTok: 25, cacheReadPerMTok: 0.5 },
  "claude-sonnet-4-6": { inputPerMTok: 3,  outputPerMTok: 15, cacheReadPerMTok: 0.3 },
  "claude-haiku-4-5":  { inputPerMTok: 1,  outputPerMTok: 5,  cacheReadPerMTok: 0.1 },
};

// Strip // line comments, /* */ block comments, and trailing commas — JSONC like tsconfig.
export function stripJsonc(src: string): string {
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

export function loadConfigFile(path: string): MarmiteConfig {
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

function fromConfig<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback;
}

export function composeConfig(
  cli: CliOverrides,
  fileCfg: MarmiteConfig,
  configDir: string,
): HarnessConfig {
  const resolveFromConfig = (p: string) => resolve(configDir, p);

  const model = cli.model ?? fileCfg.models?.default ?? DEFAULTS.model;
  const appPath = resolveFromConfig(fromConfig(fileCfg.app, DEFAULTS.app));
  const prdPath = cli.prd ?? (fileCfg.prd ? resolveFromConfig(fileCfg.prd) : resolveFromConfig(DEFAULTS.prd));

  return {
    maxIterations: cli.maxIterations ?? fromConfig(fileCfg.maxIterations, DEFAULTS.maxIterations),
    appPath,
    prdPath,
    baseBranch: fileCfg.baseBranch,
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
    mcpServers: fileCfg.mcpServers,
  };
}
