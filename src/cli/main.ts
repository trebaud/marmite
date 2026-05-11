import { resolve, dirname } from "path";
import { mkdirSync, existsSync } from "fs";
import { run } from "../core/orchestrator.ts";
import { setUserRoot } from "../core/paths.ts";
import { parseArgs, printVersion, usage } from "./args.ts";
import { loadConfigFile, composeConfig } from "./config.ts";
import { runInit } from "./commands/init.ts";
import { runToPrd } from "./commands/to-prd.ts";
import { runEmitEvent } from "./commands/emit-event.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runStats } from "./commands/stats.ts";
import { pickReporter } from "./logger.ts";

// ── Subcommand dispatch ──
const subcommand = process.argv[2];
if (subcommand === "-V" || subcommand === "--version") printVersion();
if (subcommand === "init") {
  await runInit();
  process.exit(0);
}
if (subcommand === "to-prd") {
  await runToPrd(process.argv);
  process.exit(0);
}
if (subcommand === "emit-event") {
  // Anchor PATHS.events to the cwd's .marmite/ — the agent invokes us from
  // inside the user's project root, so cwd is the right anchor here.
  setUserRoot(process.cwd());
  await runEmitEvent(process.argv);
  process.exit(0);
}
if (subcommand === "doctor") {
  await runDoctor(process.argv);
  // runDoctor calls process.exit itself with the right code.
}
if (subcommand === "stats") {
  await runStats(process.argv);
  process.exit(0);
}
if (subcommand === "-h" || subcommand === "--help") usage();

const { cli, configPath } = parseArgs(process.argv);

const resolvedConfigPath = resolve(
  configPath ?? resolve(process.cwd(), "marmite.json"),
);
const configDir = existsSync(resolvedConfigPath) ? dirname(resolvedConfigPath) : process.cwd();
const fileCfg = loadConfigFile(resolvedConfigPath);

// Anchor all user paths (state, events, progress, current-task, prompt overrides)
// to the directory containing marmite.json. Must happen before orchestrator.run.
setUserRoot(configDir);
mkdirSync(resolve(configDir, ".marmite"), { recursive: true });

const config = composeConfig(cli, fileCfg, configDir);

await run(config, pickReporter(cli.verbose === true));
