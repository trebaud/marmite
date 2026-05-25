# Marmite

A low footprint harness CLI that runs a small cast of agents in a loop to implement a project from a PRD: an orchestrator picks the next story, a builder writes the code (or a maintainer runs a sensor-driven refactor pass when the orchestrator picks one), and a verifier reviews the result. Every handoff goes through a zod-validated JSON file you can read, diff, and replay.

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
| `JANITOR (optional)` | Maintainer | Maintenance pass that pays down debt and reverses architecture drift when sensor counts cross the configured threshold |

`current-task.json` is the single handoff. If a run crashes, run `marmite cook` again: the orchestrator picks the next non-passing story, and any in-flight story without a `verify:` commit gets re-attempted.

## Async feedback

You can steer a running loop without stopping it. Drop a note any time:

```bash
echo "login UI feels cramped, add vertical spacing on the next pass" > .marmite/feedback.md
```

The next iteration folds the note into story selection and `guidance`, then deletes the file. The PRD stays untouched, so feedback shapes the upcoming pass only. The harness clears the file as a fallback if the orchestrator forgets.

## Configuration

`marmite.json` lives at the project root. JSONC syntax (line/block comments and trailing commas allowed). Every field is optional — anything you omit falls back to the harness defaults below, and most fields can be overridden per-run via `marmite cook` flags (`marmite cook --help`).

A representative config:

```jsonc
{
  "app": "./app",
  "prd": "./.marmite/prd.json",
  "workflow": "one-shot",

  "sensors":    [ /* see Sensors */ ],
  "janitor":    { /* see Sensors */ },
  "mcpServers": { /* see MCP servers */ },

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

### Fields

| Field | Default | What it does |
|---|---|---|
| `app` | `./app` | Project subdir the agents `cd` into. Relative to `marmite.json`. |
| `prd` | `./.marmite/prd.json` | Path to the validated PRD that drives the loop. |
| `baseBranch` | _(unset)_ | Base branch sensors diff against and PR-gated workflows target. |
| `workflow` | `one-shot` | Which prompt bundle to load. See [Workflows](#workflows). |
| `workflowConfig` | `{}` | Workflow-specific knobs (e.g. `pr-on-checkpoint` checkpoint kind). |
| `sensors` | `[]` | Deterministic checks run between stories. See [Sensors](#sensors). |
| `janitor` | _(unset)_ | Sensor-finding thresholds that trigger a maintenance pass. See [Sensors](#sensors). |
| `mcpServers` | `{}` | Optional MCP servers exposed to every agent — stdio/http/sse entries following the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/mcp) shape. The harness keeps `strictMcpConfig` on, so user/global MCP config is ignored. |
| `models.default` | `claude-sonnet-4-6` | Fallback model used by any role left unset. |
| `models.builder` / `verifier` / `orchestrator` | inherit `default` | Per-role override. |
| `timeouts.{build,verify,fix,orchestrate}` | `20m` / `10m` / `15m` / `10m` | Per-phase wall-clock cap. Accepts `20m`, `600s`, `1h`, or raw ms. |
| `budget.perStory` | `15` (USD) | Hard cap per story; `0` disables. |
| `budget.total` | `0` (disabled) | Whole-run cap that halts the loop between iterations. `marmite init` writes `100`. |
| `retries.fix` | `3` | Fix attempts per failing story before giving up. |
| `retries.transient` | `2` | Per-session retries on transient SDK errors. |
| `maxIterations` | `1000` | Loop cap — `marmite cook` exits once reached. |

### Workflows

A workflow is a bundle of agent prompts (orchestrator, builder, maintainer, verifier) that determines how the loop behaves. `marmite init` asks you to pick one and copies the matching prompts into `.marmite/prompts/`. The selection is recorded in `marmite.json` as `"workflow": "<name>"`.

| Workflow | What it does |
|---|---|
| `one-shot` (default) | Implements every story end-to-end without external gates. |
| `pr-on-checkpoint` | Opens a GitHub PR and halts when a configured checkpoint fires. `workflowConfig.kind` selects the trigger: `every` (after N passing stories — N=1 is one PR per story) or `epic` (after the last story of a PRD epic passes). Requires `gh` (authenticated). |
| `tdd` | Builder writes failing tests for each acceptance criterion before the implementation commit. Verifier confirms `test:` predates `feat:`. |

The PR-gated workflow uses a small `halt` field in `.marmite/current-task.json` — when present, the harness emits a `run_halt` event and exits 0 cleanly. The next `marmite cook` invocation re-enters the orchestrator, which checks `gh pr view` and either resumes (on merge) or rewrites the same halt and exits again.

To override a workflow's defaults, drop `orchestrator-prompt.md`, `builder-prompt.md`, `maintainer-prompt.md`, or `verifier-prompt.md` into `.marmite/prompts/` — they're checked in alongside the rest of the workflow.

### Sensors

Sensors are deterministic checks the orchestrator runs before handing off to the builder — they surface debt and drift in the diff so the brief can ask for the right fix. Each sensor entry in `marmite.json` declares a `name`, a `type` (`debt` or `drift`), and a `guidance` shell snippet the orchestrator executes. Sensors are **scoped to files modified by the current run** (`git diff --name-only $baseBranch...HEAD`), so they never report on untouched code in a brownfield repo.

The set of sensors that get installed — and the rules they encode — is determined by the workflow you pick at `marmite init`. Configs land under `./.marmite/sensors/` and are tracked in git; edit them to tune what counts as a violation, or remove a sensor's entry from `marmite.json` to disable it.

When sensor findings accumulate past the thresholds in `marmite.json`'s `janitor` block, the orchestrator schedules a `JANITOR` phase instead of the next story — a maintenance run that focuses solely on paying down debt and reversing architecture drift before regular story work resumes:

```jsonc
"janitor": {
  "thresholds":        { "debt": 20, "drift": 5 },  // either trips a run
  "maxFindingsPerRun": 5,                            // small batches per pass
  "budgetUsd":         3
}
```

## Commands

| Command | Purpose |
|---|---|
| `marmite` / `marmite cook` | Run the agent loop in the current project |
| `marmite <n>` | Shorthand for `marmite cook -n <n>` (cap iterations) |
| `marmite refactor` | One-shot maintenance pass — runs sensors, materializes a janitor entry, applies fixes, verifies. Single orchestrate→build→verify cycle, no fix loop, ignores thresholds |
| `marmite init` | Interactive wizard — scaffolds `marmite.json`, `.marmite/`, prompts, sensors |
| `marmite to-prd <PRD.md>` | Convert a markdown PRD into `.marmite/prd.json` and validate it |
| `marmite doctor` | Preflight check — config, prompts, contract fences, sensors, gitignore |
| `marmite stats [path]` | Post-run summary of `.marmite/events.jsonl` (cost, durations, retries, cache hits) |
| `marmite dashboard [path]` | Serve a live HTML dashboard backed by `events.jsonl` + `prd.json` + `progress.json` |

### `cook`

```
-c, --config <path>           Config file path (default: ./marmite.json)
-n, --max-iterations <n>      Cap the loop
-p, --prd <path>              Override prd.json location
    --model <id>              Default model (fallback for all roles)
    --builder-model <id>      Override builder/fix model
    --verifier-model <id>     Override verify model
    --build-timeout <dur>     e.g. 20m, 600s, 1h
    --verify-timeout <dur>
    --fix-timeout <dur>
    --cost-budget <usd>       Per-story budget (0 disables)
    --cost-budget-total <usd> Whole-run budget
    --max-fix-attempts <n>    Fix attempts per story
    --retries <n>             Transient retries per session
-v, --verbose                 Raw SDK messages and stats
```

### `refactor`

`marmite refactor` runs a single isolated maintenance cycle. Unlike `cook`, it:

- Skips the orchestrate phase entirely — the harness picks a janitor ID, writes `current-task.json`, and dispatches maintainer → verifier. `progress.json` stays untouched by the harness; the maintainer appends the JanitorEntry itself after running sensors.
- Runs every configured sensor regardless of `janitor.thresholds`. Findings are scoped to lines this branch added or modified vs `baseBranch`, so a refactor pass focuses on debt introduced by recent work rather than the whole repo.
- The maintainer consults the `janitor` skill for triage and applies the top-N picks (default 5) in a single build pass, one fix per commit, tests between each.
- Skips the fix loop — if verify fails, the run exits non-zero so you can inspect, tweak, and re-invoke.
- Accepts the same flags as `cook` (model, timeouts, budgets) and uses the same `marmite.json` config.

```
marmite refactor                # one-shot maintenance pass
marmite refactor --verbose      # full SDK message firehose
marmite refactor --builder-model claude-opus-4-7
```

The dashboard tags the run with a 🧹 **Maintenance** badge in the header.

### `stats`

```
--run <id>   Restrict to a specific runId
--all        Fold all runs in the file together (default: latest)
--json       Machine-readable output
```

### `dashboard`

```
--port <n>   Port to listen on (default: 4321)
--host <h>   Host to bind (default: 127.0.0.1)
--no-open    Don't open the browser
```
