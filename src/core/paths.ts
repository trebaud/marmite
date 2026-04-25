import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

// Framework paths resolve from the package install location (e.g. node_modules/marmite/...).
// They reference files that ship with marmite — prompt defaults and the init skill.
const here = dirname(fileURLToPath(import.meta.url)); // src/core
const packageRoot = resolve(here, "../..");

export const FRAMEWORK_PATHS = {
  packageRoot,
  builderMd:        resolve(packageRoot, "src/prompts/builder-prompt.md"),
  verifierMd:       resolve(packageRoot, "src/prompts/verifier-prompt.md"),
  orchestratorMd:   resolve(packageRoot, "src/prompts/orchestrator-prompt.md"),
  marmiteInitSkill: resolve(packageRoot, ".claude/skills/marmite-init"),
} as const;

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
  get projectRoot()     { return userRoot; },
  get progress()        { return userPath("progress.txt"); },
  get archiveDir()      { return userPath("archive"); },
  get lastBranch()      { return userPath(".last-branch"); },
  get state()           { return userPath(".marmite/state.json"); },
  get events()          { return userPath(".marmite/events.jsonl"); },
  get currentTask()     { return userPath("current-task.json"); },
  get promptOverrides() { return userPath(".marmite/prompts"); },
};

export type PromptName = "builder" | "verifier" | "orchestrator";

// Returns the path to a prompt file. Checks `.marmite/prompts/<name>-prompt.md`
// in the user's project first; falls back to the package default.
export function resolvePrompt(name: PromptName): string {
  const override = resolve(PATHS.promptOverrides, `${name}-prompt.md`);
  if (existsSync(override)) return override;
  switch (name) {
    case "builder": return FRAMEWORK_PATHS.builderMd;
    case "verifier": return FRAMEWORK_PATHS.verifierMd;
    case "orchestrator": return FRAMEWORK_PATHS.orchestratorMd;
  }
}
