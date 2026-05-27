# Marmite

A low footprint harness CLI that runs a small cast of agents in a loop to implement a project from a PRD: an orchestrator picks the next story, a builder writes the code, and a verifier reviews the result. Every handoff goes through a zod-validated JSON file you can read, diff, and replay.

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

`marmite init` interviews you, detects whether the repo is greenfield or has existing code, and scaffolds the config and prompts. Nothing is overwritten without asking.

```
my-project/
├── marmite.json              # config: paths, models, budgets
├── .marmite/
│   ├── prd.json              # the PRD that drives the loop        
│   ├── progress.json         # rolling story timeline + patterns (long-term memory)
│   ├── current-task.json     # per-iteration agent handoff (short-term memory)
│   ├── prompts/              # agent prompts overrides
│   ├── events.jsonl          # per-session event log
│   └── feedback.md           # async notes, dropped mid-run
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
| `ORCHESTRATE` | Orchestrator | Picks the next story, writes the brief |
| `BUILD` | Builder | Implements, commits |
| `VERIFY` | Verifier | Approves or rejects |
| `FIX` | Builder | Resumes the same session to address feedback |

Refactoring isn't a separate phase. `marmite to-prd` asks whether to include refactoring stories at the end of each epic — these run the sensors you define in `marmite.json`. If you accept, the loop runs those stories like any other.

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

  "sensors": [
    { "name": "lint",   "guidance": "Run `bun run lint` on the changed files and clear every finding." },
    { "name": "arch",   "guidance": "Run `bun run depcruise` and fix any layer violation or cycle." }
  ],

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
| `workflow` | `one-shot` | Which prompt bundle to load and whether to halt at epic boundaries. See [Workflows](#workflows). |
| `sensors` | `[]` | User-defined quality checks, each `{ "name", "guidance" }`. `marmite to-prd` folds them into the per-epic refactoring stories it can append, so the builder runs each sensor's `guidance` and the verifier confirms it. The harness never executes them itself. |
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

A workflow is a bundle of agent prompts (orchestrator, builder, verifier) that determines how the loop behaves. The prompts ship inside the marmite package under `src/workflows/<name>/`; the harness loads them directly at run time. `marmite init` asks you to pick one and records the choice in `marmite.json` as `"workflow": "<name>"` — nothing is copied into your project. Omitting the field defaults to `one-shot`.

| Workflow | What it does |
|---|---|
| `one-shot` (default) | Implements every story end-to-end without external gates. |
| `epic-checkpoint` | Builds straight through, then halts at the end of each PRD epic so a human can review the work. Resume the next epic with `marmite cook --approve`. No PRs, branches, or `gh` involved. |

The stop is decided from immutable state: when the orchestrator reaches the end of an epic whose stories all pass but that has no approval record yet, it writes a `{ "kind": "epic_checkpoint", "epic": "<slug>" }` halt to `.marmite/current-task.json` instead of picking a story, and the harness emits a `run_halt` and exits 0. Approving (`marmite cook --approve`) appends a `{ "kind": "approval", "epic": "<slug>" }` entry to the `timeline` in `.marmite/progress.json` and commits it — nothing is mutated. A plain `marmite cook` re-halts idempotently at the boundary; the `--approve` run clears exactly the one pending checkpoint, then halts again at the next epic.

To override a workflow's defaults, drop `orchestrator-prompt.md`, `builder-prompt.md`, or `verifier-prompt.md` into `.marmite/prompts/` — an override there takes precedence over the packaged prompt for that role, and is checked in so the team shares it. Without an override, the packaged prompt is used. `marmite doctor` flags an override whose contract fences have drifted from the shipped prompt.

## Commands

| Command | Purpose |
|---|---|
| `marmite` / `marmite cook` | Run the agent loop in the current project |
| `marmite <n>` | Shorthand for `marmite cook -n <n>` (cap iterations) |
| `marmite init` | Interactive wizard — scaffolds `marmite.json` and installs helper skills (agent prompts ship with the package) |
| `marmite to-prd <PRD.md>` | Convert a markdown PRD into `.marmite/prd.json` (optionally appends a refactoring story per epic) and validate it |
| `marmite doctor` | Preflight check — config, workflow, prompt overrides, contract fences, gitignore |
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
    --approve                 Approve the pending epic checkpoint and resume (epic-checkpoint workflow)
-v, --verbose                 Raw SDK messages and stats
```

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
