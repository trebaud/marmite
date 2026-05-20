import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Framework paths resolve from the package install location (e.g. node_modules/marmite/...).
//
//   src/skills/   — marmite-internal skills loaded directly by the CLI (init, to-prd).
//   templates/    — assets copied into the user's project at `marmite init`:
//                     templates/prompts/  → <user>/.marmite/prompts/
//                     templates/skills/   → <user>/.claude/skills/
const here = dirname(fileURLToPath(import.meta.url)); // src/core
const packageRoot = resolve(here, "../..");

export const FRAMEWORK_PATHS = {
  packageRoot,
  internalSkills:   resolve(packageRoot, "src/skills"),
  templates:        resolve(packageRoot, "templates"),
  templatesPrompts: resolve(packageRoot, "templates/prompts"),
  templatesSkills:  resolve(packageRoot, "templates/skills"),
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
  get projectRoot() { return userRoot; },
  get progress()    { return userPath(".marmite/progress.json"); },
  get events()      { return userPath(".marmite/events.jsonl"); },
  get currentTask() { return userPath(".marmite/current-task.json"); },
  get prompts()     { return userPath(".marmite/prompts"); },
  get prd()         { return userPath(".marmite/prd.json"); },
  get feedback()    { return userPath(".marmite/feedback.md"); },
};

export type PromptName = "builder" | "verifier" | "orchestrator";

// Agent prompts always live at `.marmite/prompts/<name>-prompt.md` in the user's project.
// `marmite init` copies the packaged templates there; callers must handle missing files
// (the orchestrator validates this up front and points the user at `marmite init`).
export function resolvePrompt(name: PromptName): string {
  return resolve(PATHS.prompts, `${name}-prompt.md`);
}
