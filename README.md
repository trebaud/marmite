# Marmite

A low footprint harness CLI that runs three agents in a loop to implement a project from a PRD: an orchestrator picks the next story, a builder writes the code, and a verifier reviews it. Every handoff goes through a zod-validated JSON file you can read, diff, and replay.

Works on greenfield projects and existing codebases.

## Quickstart

Requires [Bun](https://bun.sh) and [Claude Code](https://docs.claude.com/en/docs/claude-code).

```bash
export ANTHROPIC_API_KEY=sk-ant-...
bunx marmite init                 # interview + scaffold
bunx marmite to-prd ./PRD.md      # creates and validates .marmite/prd.json
bunx marmite cook                 # start the loop
```

## Project shape

`marmite init` interviews you, detects whether the repo is greenfield or has existing code, and wires sensors to configs already in your repo. Nothing is overwritten without asking.

```
my-project/
├── marmite.json              # config: paths, sensors, models, budgets
├── .marmite/
│   ├── prd.json              # the PRD that drives the loop          (git)
│   ├── progress.json         # rolling story + janitor timeline     (git)
│   ├── current-task.json     # per-iteration agent handoff           (git)
│   ├── prompts/              # agent prompts                         (git)
│   ├── events.jsonl          # per-session event log              (ignored)
│   └── feedback.md           # async notes, dropped mid-run       (ignored)
└── app/                      # your code (path is configurable)
```

## The loop

```
   ┌───────────────────────────────────────────────────┐
   │                 current-task.json                 │ ◀── shared handoff
   └───────────────────────────────────────────────────┘    (fail loops here:
          ▲                 ▲              ▲                  Verifier writes
          │                 │              │                  verdict, Builder
          ▼                 ▼              ▼                  reads + retries)
   ┌──────────────┐    ┌─────────┐    ┌──────────┐   pass    ┌──────────┐
   │ Orchestrator │ ──▶│ Builder │ ──▶│ Verifier │ ────────▶ │ prd.json │
   └──────────────┘    └────┬────┘    └──────────┘           └────┬─────┘
          ▲                 │                                     │
          │                 │ commit                              │
          │                 ▼                                     │
          │          ┌──────────────┐                             │
          │          │ progress.json│                             │
          │          └──────────────┘                             │
          │                                                       │
          └───────────────────────────────────────────────────────┘
                                next story
```

| Phase | Agent | Output |
|---|---|---|
| `ORCHESTRATE` | Orchestrator | Picks story, runs sensors, writes the brief |
| `BUILD` | Builder | Implements, commits |
| `VERIFY` | Verifier | Approves or rejects |
| `FIX` | Builder | Resumes the same session to address feedback |

`current-task.json` is the single handoff. If a run crashes, run `marmite cook` again: the orchestrator picks the next non-passing story, and any in-flight story without a `verify:` commit gets re-attempted.

## Async feedback

You can steer a running loop without stopping it. Drop a note any time:

```bash
echo "login UI feels cramped, add vertical spacing on the next pass" > .marmite/feedback.md
```

The next iteration folds the note into story selection and `guidance`, then deletes the file. The PRD stays untouched, so feedback shapes the upcoming pass only. The harness clears the file as a fallback if the orchestrator forgets.

## Configuration

`marmite.json` (JSONC, all fields optional):

```jsonc
{
  "app": "./app",
  "prd": "./.marmite/prd.json",

  "sensors": [
    { "name": "eslint",             "type": "debt",  "package": "eslint",             "configPath": "./.marmite/sensors/eslint.config.js",       "guidance": "CHANGED=$(git diff --name-only \"$baseBranch\"...HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs'); [ -n \"$CHANGED\" ] && npx eslint --no-config-lookup -c .marmite/sensors/eslint.config.js $CHANGED" },
    { "name": "dependency-cruiser", "type": "drift", "package": "dependency-cruiser", "configPath": "./.marmite/sensors/.dependency-cruiser.cjs", "guidance": "CHANGED=$(git diff --name-only \"$baseBranch\"...HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs'); [ -n \"$CHANGED\" ] && npx depcruise --config .marmite/sensors/.dependency-cruiser.cjs $CHANGED" }
  ],

  "models": {
    "default":      "claude-sonnet-4-6",
    "builder":      "claude-sonnet-4-6",
    "verifier":     "claude-haiku-4-5",
    "orchestrator": "claude-sonnet-4-6"
  },

  "timeouts": { "build": "20m", "verify": "10m", "fix": "15m", "orchestrate": "10m" },
  "budget":   { "perStory": 15, "total": 100 },
  "retries":  { "fix": 3, "transient": 2 },
  "maxIterations": 1000
}
```

### Sensors

Marmite ships exactly two deterministic checks. Their configs are installed under `./.marmite/sensors/` at `marmite init` time and tracked in git — edit them to encode the rules you want on new code. Both sensors are **scoped to files modified by the current run** (`git diff --name-only $baseBranch...HEAD`), so they never lint or analyze the brownfield project's untouched files.

| Sensor | Type | Config | Catches | Skill on failure |
|--------|------|--------|---------|------------------|
| `eslint` | `debt` | `.marmite/sensors/eslint.config.js` | Style, complexity, unused code, escape hatches | `clean-code`, `refactor` |
| `dependency-cruiser` | `drift` | `.marmite/sensors/.dependency-cruiser.cjs` | Import violations, cycles, layer misuse, orphan modules | `architect` |

If the project already has its own eslint flat config, `marmite init` layers the marmite debt rules on top of it (see the `userConfig` import in `eslint.config.js`). Either sensor can be disabled at init time or by removing its entry from `marmite.json`.

### Workflows

A workflow is a bundle of three agent prompts (orchestrator, builder, verifier) that determines how the loop behaves. `marmite init` asks you to pick one and copies the matching prompts into `.marmite/prompts/`. The selection is recorded in `marmite.json` as `"workflow": "<name>"`.

| Workflow | What it does |
|---|---|
| `one-shot` (default) | Implements every story end-to-end without external gates. |
| `pr-on-checkpoint` | Opens a GitHub PR and halts when a configured checkpoint fires. `workflowConfig.kind` selects the trigger: `every` (after N passing stories — N=1 is one PR per story) or `epic` (after the last story of a PRD epic passes). Requires `gh` (authenticated). |
| `tdd` | Builder writes failing tests for each acceptance criterion before the implementation commit. Verifier confirms `test:` predates `feat:`. |

The PR-gated workflow uses a small `halt` field in `.marmite/current-task.json` — when present, the harness emits a `run_halt` event and exits 0 cleanly. The next `marmite cook` invocation re-enters the orchestrator, which checks `gh pr view` and either resumes (on merge) or rewrites the same halt and exits again.

### Custom prompts

Drop `builder-prompt.md`, `verifier-prompt.md`, or `orchestrator-prompt.md` into `.marmite/prompts/` to override the defaults installed by your chosen workflow. Overrides are checked in.
