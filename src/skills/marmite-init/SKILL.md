---
name: marmite-init
description: "Set up marmite in a project by interviewing the user. Detects greenfield vs brownfield, asks the right questions, and writes marmite.json + installs templates non-destructively. PRD generation is a separate step (`marmite to-prd`)."
user-invocable: true
---

# Marmite Setup Wizard

You are guiding a user through setting up [marmite](https://github.com/) in their project. Marmite is a harness that drives three Claude agents in a loop (orchestrator → builder → verifier) to implement features described in a `.marmite/prd.json`. Your job is to interview the user and produce the configuration files marmite needs to run.

The user just ran `marmite init` (or `bunx marmite init`). They are sitting in their project's working directory. Take it from here.

**Scope.** Init only sets up the harness — `marmite.json`, agent prompts, helper skills. Generating `.marmite/prd.json` is a separate command (`marmite to-prd <PRD.md>`); do not produce a PRD here. Mention it in the next-steps block at the end.

---

## Step 1 — Detect the environment

Before asking anything, look around. Run `pwd` and `ls -la` to see the layout. Then check for these signals:

- **Already initialized**: `marmite.json` exists. Tell the user, then ask whether to **reconfigure** (re-run the interview using current values as defaults) or **abort**.
- **Brownfield**: `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, or `Gemfile` exists. There is real code here.
- **Greenfield**: directory is empty or only has dotfiles. No real code.

For brownfield, also read (lightly — don't dump them in full):
- The project's manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, …) — stack, scripts, workspaces, dev dependencies
- `README.md` and `CONTRIBUTING.md` if present — house style, conventions, run commands
- A small sample of source files, just enough to understand the layout
- Recent `git log --oneline -20` — what's been happening lately

State what you found in 3–5 lines before moving on. Don't dump full file contents at the user.

---

## Step 2 — Interview

Ask **one question at a time**. Adapt based on previous answers. Always offer sensible defaults derived from what you detected.

### Question formatting rules

- **Always number multi-choice options** as `1.`, `2.`, `3.` so the user can answer with a single digit. Mark the default with `(default)`.
- **For free-text answers** (paths, names), state the default inline like `default: ./src` and tell the user they can press Enter to accept.
- **Keep options short** — one line each, no tables. The harness draws a divider line and a `▶` prompt on its own line after your message, so end the question cleanly without your own `>` prompt or `Default: …` line.
- **Accept loose answers** — if the user types `1` or `src` or just hits Enter, interpret reasonably. Don't force exact strings.

### Required answers

1. **App location** — where does the user's application code live (or where should it live)?
   - Always include "the project root (`.`)" as one of the options, regardless of greenfield/brownfield.
   - Greenfield: default `./app`, with the project root offered as an alternative.
   - Brownfield: derive other choices from detected workspaces. If it's a monorepo, list the workspaces alongside the project root so the user can target the whole repo or a specific workspace.

2. **Workflow** — which workflow should marmite use? Each workflow ships its own three agent prompts; the choice determines what gets installed under `.marmite/prompts/` and how the orchestrator behaves.

   List the choices by reading `$MARMITE_TEMPLATES/workflows/*/workflow.json`:

   ```bash
   for f in $MARMITE_TEMPLATES/workflows/*/workflow.json; do cat "$f"; echo; done
   ```

   Each `workflow.json` has `name`, `label`, `description`, and an optional `default: true`. Show the user a numbered list with the labels and one-line descriptions, default-marked. The default choice has `default: true` (currently `one-shot`); if multiple or none are flagged, fall back to `one-shot`.

   Save the chosen workflow's `name` value (e.g. `"one-shot"`, `"pr-on-checkpoint"`, `"tdd"`) for later — both the install step (step 4) and `marmite.json` (the `workflow` key) need it.

   Each `workflow.json` may carry additional fields the wizard asks follow-ups for:

   - **pr-on-checkpoint trigger** (only if `workflow.name === "pr-on-checkpoint"`): ask **checkpoint trigger**. Two options:
     - `every` (default) — open a PR after every N passing stories. Ask for N (default `1`, which is one PR per story). Save as `workflowConfig: { "kind": "every", "stories": N }`.
     - `epic` — open a PR after the last story of each PRD epic passes. Save as `workflowConfig: { "kind": "epic" }`. Stories in `.marmite/prd.json` always carry an `epic` field (`marmite to-prd` enforces it); for this trigger to be useful the user should split work into distinct epics rather than the default single-epic PRD.
     - Also run `gh auth status` to verify the GitHub CLI is installed and authenticated. If it isn't, mention it as a follow-up step the user must complete before `marmite cook` will work — but don't block init on it.

   - **Sensors** (only if `workflow.json.sensors[]` is present and non-empty): the workflow ships one or more deterministic checks the orchestrator runs between stories. Each entry has a `type` (currently `debt` or `drift`); the concrete config files live under `$MARMITE_TEMPLATES/sensors/` and are copied into `./.marmite/sensors/` at install time. Sensors are always **scoped to files modified by the marmite run** (`git diff --name-only $baseBranch...HEAD`), never to the brownfield project's existing files.

     Before asking, briefly explain the goal in 3–5 lines so the user can make an informed call. Cover:

     - Sensors keep accumulated **debt** (code-quality issues — complexity, dead code, escape hatches) and architectural **drift** (cycles, layer violations, orphan modules) in check as the agent loop adds code over many iterations.
     - The orchestrator runs them between stories. When findings cross configurable `janitor.thresholds` in `marmite.json`, the next iteration is automatically routed to a **maintenance/refactor pass** (the `janitor` skill) instead of a new story — so quality issues get worked down rather than piling up.
     - Scope is always the diff against `baseBranch`, so existing brownfield code is left alone.
     - The concrete tools live in templates installed under `.marmite/sensors/`; users can swap them later without re-running the wizard.

     Read the sensor entries from the workflow you just picked — do not hardcode names:

     ```bash
     jq '.sensors' "$MARMITE_TEMPLATES/workflows/$WF/workflow.json"
     ```

     Show the user the `name` + `type` of each entry. Then ask **one** question — sensors are **optional but recommended**:

     > Enable this workflow's sensors? Optional, but recommended for runs longer than a handful of stories.
     > 1. yes — install all (default, recommended)
     > 2. pick a subset
     > 3. skip — no sensors, no janitor maintenance passes

     If the user picks "subset", show one sub-question per entry in `workflow.json.sensors[]` (yes/no), using the `name` and `type` fields.

     Do **not** ask the user to type config paths and do **not** detect/rewire the project's own tool configs — sensor templates are self-contained, and any extension or customization is something the user does by editing files under `.marmite/sensors/` after init. Mention that as a follow-up in the final summary if relevant.

3. **Models** — which Claude models for each role?
   - Default to `{ default: claude-sonnet-4-6, builder: claude-sonnet-4-6, verifier: claude-haiku-4-5, orchestrator: claude-sonnet-4-6 }` and just confirm.
   - Offer a "thorough" preset (Opus for builder) and a "fast" preset (Haiku everywhere) for users who want them.

4. **Budgets** — per-story USD cap and total run cap. Default `{ perStory: 15, total: 100 }`. One question, two numbers; users almost always accept defaults.

### Don't ask about

- The PRD — that's `marmite to-prd`'s job. Mention it in the next-steps block.
- Timeouts, retries, max iterations, resume — keep marmite's defaults.
- API key — that's an env var (`ANTHROPIC_API_KEY`), not config.

---

## Step 3 — Show the plan

Before writing anything, summarize what you're about to do:

```
I'll write:
  marmite.json         (app=<chosen path>, workflow=<chosen>, sensors=<list of enabled sensor names, or "none">, balanced models)
  .marmite/prompts/    (install agent prompts from workflows/<chosen>/: builder, verifier, orchestrator)
  .marmite/sensors/    (only if sensors enabled — list the files from $MARMITE_TEMPLATES/sensors/ being copied)
  .claude/skills/      (install helper skills: list whatever folders are under $MARMITE_TEMPLATES/skills/)
```

Ask the user to confirm. If they say no, loop back to whichever step they want to change.

---

## Step 4 — Write the files

**Non-destructive rules — do not violate these.**

- For each file you'd write, check if it already exists. If yes, **show the diff** and ask before overwriting.
- Never `rm` a user file.
- `.gitignore` may be **appended to** only to add the two per-developer marmite files
  (`.marmite/events.jsonl` and `.marmite/feedback.md`) if they aren't already present.
  Do not touch any other ignore rules. If `.gitignore` doesn't exist, create one with
  just those two lines plus a leading `# marmite` comment.

### `marmite.json` shape

JSONC (comments allowed). Inline structure:

```jsonc
{
  "app": "./apps/web",
  "prd": "./.marmite/prd.json",
  "workflow": "one-shot",
  // Only emit `workflowConfig` when the chosen workflow uses it (today: pr-on-checkpoint).
  // "workflowConfig": { "kind": "every", "stories": 3 },
  // "workflowConfig": { "kind": "epic" },
  // `sensors` is optional. Omit the key entirely if the user picked "skip"
  // in the sensors follow-up under step 2 — the harness then runs with no
  // deterministic checks between stories. Otherwise include one entry per
  // sensor the user enabled. Each
  // entry's `name`, `type`, `package`, and `guidance` are copied verbatim from
  // the chosen workflow's `workflow.json.sensors[]`; `configPath` always
  // points inside `./.marmite/sensors/`.
  "sensors": [
    // Example shape — leave names/types/commands to whatever the templates
    // dir actually ships; do not hardcode tool names here.
    // {
    //   "name": "<sensor-name>",
    //   "type": "debt" /* or "drift" */,
    //   "package": "<underlying-tool>",
    //   "configPath": "./.marmite/sensors/<config-file>",
    //   "guidance": "<exact shell invocation, scoped to $CHANGED files>"
    // }
  ],
  "models": {
    "default": "claude-sonnet-4-6",
    "builder": "claude-sonnet-4-6",
    "verifier": "claude-haiku-4-5",
    "orchestrator": "claude-sonnet-4-6"
  },
  "timeouts": { "build": "20m", "verify": "10m", "fix": "15m", "orchestrate": "10m" },
  "budget": { "perStory": 15, "total": 100 },
  "retries": { "fix": 3, "transient": 2 },
  "maxIterations": 1000
}
```

Only emit keys the user explicitly chose; let marmite's defaults handle the rest. A minimal config is fine.

### Install templates from `$MARMITE_TEMPLATES`

The marmite package's templates tree was given to you in the preamble as `MARMITE_TEMPLATES=<absolute path>`. The tree mirrors what gets installed:

```
$MARMITE_TEMPLATES/
├── workflows/                                          (one subdir per workflow)
│   ├── one-shot/
│   │   ├── workflow.json
│   │   └── prompts/        → ./.marmite/prompts/       (only the chosen workflow)
│   │       ├── builder-prompt.md
│   │       ├── verifier-prompt.md
│   │       └── orchestrator-prompt.md
│   ├── pr-on-checkpoint/{ workflow.json, prompts/ }
│   └── tdd/{ workflow.json, prompts/ }
├── sensors/                 → ./.marmite/sensors/       (only the ones the workflow declares + user enabled in step 2's sensors follow-up)
│   └── <config files referenced by the chosen workflow's workflow.json `sensors[].file`>
└── skills/                  → ./.claude/skills/         (always installed)
    ├── architect/
    ├── design-qa-checker/
    └── prd-generator/
    (… any other skill folders present)
```

Procedure (let `WF` be the workflow name selected in step 2):

1. `mkdir -p ./.marmite/prompts ./.claude/skills`
2. For each file under `$MARMITE_TEMPLATES/workflows/$WF/prompts/`:
   - target = `./.marmite/prompts/<filename>`
   - if target does not exist: `cp "$MARMITE_TEMPLATES/workflows/$WF/prompts/<filename>" "$target"`
   - if target exists: leave it alone (user has customized it). Note "skipped (already present)" in the summary.
3. **Sensors are optional.** If the user picked "skip" in step 2's sensors follow-up (or the workflow declares no sensors), do nothing here — do not create `./.marmite/sensors/` and do not emit a `sensors` key in `marmite.json`. Otherwise: `mkdir -p ./.marmite/sensors` and for each `workflow.json.sensors[]` entry the user enabled, `cp -n "$MARMITE_TEMPLATES/sensors/<entry.file>" "./.marmite/sensors/<entry.file>"`. Do not edit the freshly-copied files — they are self-contained; any extension/customization is something the user does themselves after init. For each enabled entry, emit one object into `marmite.json.sensors[]` containing the workflow entry's `name`, `type`, `package`, `guidance` (verbatim) and `configPath: "./.marmite/sensors/<entry.file>"`.
4. For each sub-directory under `$MARMITE_TEMPLATES/skills/`:
   - target = `./.claude/skills/<skill-name>`
   - if target does not exist: `cp -R "$MARMITE_TEMPLATES/skills/<skill-name>" "$target"`
   - if target exists: leave it alone. Note "skipped (already present)" in the summary.
5. List what you copied vs. skipped in your final summary, and call out which workflow's prompts were installed and which sensors were wired up.

Both prompts and helper skills are user-authored content once installed — they should be checked in so the team shares the same agent behavior.

---

## Step 5 — Print next steps

End with a clear, scannable block:

```
Done. Next steps:

  1. Set your API key:
       export ANTHROPIC_API_KEY=sk-ant-...

  2. Generate your PRD:
       marmite to-prd ./PRD.md    # converts a markdown PRD into .marmite/prd.json

  3. Run marmite:
       marmite cook -n 1          # one iteration first
       marmite cook               # full run

Customizing:
  - Edit marmite.json to tune models, sensors, budgets.
  - Edit .marmite/prompts/{builder,verifier,orchestrator}-prompt.md to
    customize agent behavior.

Steering a long run:
  - Drop free-form notes into .marmite/feedback.md at any time. The orchestrator
    picks them up at the start of the next iteration, applies them to story
    selection / guidance, then deletes the file.

Happy building! You can now quit the wizard.
```

Then stop. Don't run `marmite to-prd` or `marmite cook` for them; let them drive.

---

## Important rules

- **One question at a time.** Don't dump a wall of multi-part questions.
- **Detect first, ask second.** Reading `package.json` and showing a one-line summary beats asking the user to type their stack.
- **Never overwrite without showing a diff and getting confirmation.**
- **Schema-validate before writing.** marmite validates `marmite.json` on `cook` startup; if you produce invalid JSON the user sees an error on the very first run. Double-check your output before writing.
- **Don't generate `.marmite/prd.json` here.** That's `marmite to-prd`'s job — keep init focused on harness setup.
- **Don't install dependencies during init.** Adding sensor packages (whichever ones the enabled sensors invoke via `npx`) is the user's call after init; mention it as a follow-up if you can tell from inspecting the installed configs that the tools aren't already available.
- **Don't run `marmite cook` or `marmite to-prd` yourself.** End the session after writing files and printing next steps.
