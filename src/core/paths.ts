import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

// Framework paths resolve from the package install location (e.g. node_modules/marmite/...).
//
//   src/skills/    — marmite-internal skills loaded directly by the CLI (init, to-prd).
//   src/workflows/ — the shipped workflows. Each holds a workflow.json plus the
//                    three agent prompts under prompts/. The harness reads these
//                    prompts directly from the package at run time; the user's
//                    .marmite/prompts/ only holds optional overrides.
//   templates/     — assets copied into the user's project at `marmite init`:
//                      templates/skills/ → <user>/.claude/skills/
const here = dirname(fileURLToPath(import.meta.url)); // src/core
const packageRoot = resolve(here, "../..");

export const FRAMEWORK_PATHS = {
  packageRoot,
  internalSkills:  resolve(packageRoot, "src/skills"),
  workflows:       resolve(packageRoot, "src/workflows"),
  templates:       resolve(packageRoot, "templates"),
  templatesSkills: resolve(packageRoot, "templates/skills"),
} as const;

// Workflow used when marmite.json omits the `workflow` field.
export const DEFAULT_WORKFLOW = "one-shot";

// User paths live in the user's project (where they ran `marmite cook`).
// `userRoot` defaults to process.cwd(); index.ts overrides it to the dir
// containing marmite.json once the config has been resolved.
let userRoot: string = process.cwd();

export function setUserRoot(path: string): void {
  userRoot = path;
}

function userPath(p: string): string {
  return resolve(userRoot, p);
}

export const PATHS = {
  get projectRoot() { return userRoot; },
  get progress()    { return userPath(".marmite/progress.json"); },
  get events()      { return userPath(".marmite/events.jsonl"); },
  get currentTask() { return userPath(".marmite/current-task.json"); },
  get prompts()     { return userPath(".marmite/prompts"); },
  get prd()         { return userPath(".marmite/prd.json"); },
  get feedback()    { return userPath(".marmite/feedback.md"); },
};

export type PromptName = "builder" | "verifier" | "orchestrator";

// The packaged prompt shipped with a workflow: src/workflows/<workflow>/prompts/<name>-prompt.md.
export function packagedPrompt(workflow: string, name: PromptName): string {
  return resolve(FRAMEWORK_PATHS.workflows, workflow, "prompts", `${name}-prompt.md`);
}

// The optional per-project override at .marmite/prompts/<name>-prompt.md.
export function promptOverridePath(name: PromptName): string {
  return resolve(PATHS.prompts, `${name}-prompt.md`);
}

// Resolve which prompt file to actually load. A user override in
// `.marmite/prompts/` wins; otherwise the packaged prompt for the configured
// workflow is used directly from the marmite package. Workflow defaults to
// `one-shot` when marmite.json omits it.
export function resolvePrompt(name: PromptName, workflow: string = DEFAULT_WORKFLOW): string {
  const override = promptOverridePath(name);
  return existsSync(override) ? override : packagedPrompt(workflow, name);
}
