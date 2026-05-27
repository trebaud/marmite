---
name: marmite-init
description: "Set up marmite in a project by interviewing the user. Detects greenfield vs brownfield, asks the right questions, and writes marmite.json + installs helper skills non-destructively. Agent prompts ship with the package and are not copied. PRD generation is a separate step (`marmite to-prd`)."
user-invocable: true
---

# Marmite Setup Wizard

You are guiding a user through setting up [marmite](https://github.com/) in their project. Marmite is a harness that drives Claude agents in a loop (orchestrator → builder → verifier) to implement the stories described in a `.marmite/prd.json`. Your job is to interview the user and produce the configuration files marmite needs to run.

The user just ran `marmite init` (or `bunx marmite init`). They are sitting in their project's working directory. Take it from here.

**Scope.** Init only sets up the harness — `marmite.json` and helper skills. Agent prompts are NOT installed: they ship with the marmite package and the harness loads them directly from the workflow recorded in `marmite.json`. A project only ever touches `.marmite/prompts/` to *override* a prompt. Generating `.marmite/prd.json` is a separate command (`marmite to-prd <PRD.md>`); do not produce a PRD here. Mention it in the next-steps block at the end.

---

## Step 1 — Detect the environment

Before asking anything, look around. Run `pwd` and `ls -la` to see the layout. Then check for these signals:

- **Already initialized**: `marmite.json` exists. Tell the user, then ask whether to **reconfigure** (re-run the interview using current values as defaults) or **abort**.
- **Brownfield**: `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, or `Gemfile` exists. There is real code here.
- **Greenfield**: directory is empty or only has dotfiles. No real code.

For brownfield, also read (lightly — don't dump them in full):
- The project's manifest — stack, scripts, workspaces, dev dependencies
- `README.md` and `CONTRIBUTING.md` if present — house style, conventions, run commands
- A small sample of source files, just enough to understand the layout
- Recent `git log --oneline -20` — what's been happening lately

State what you found in 3–5 lines before moving on.

---

## Step 2 — Interview

Ask **one question at a time**. Adapt based on previous answers. Always offer sensible defaults derived from what you detected.

### Question formatting rules

- **Always number multi-choice options** as `1.`, `2.`, `3.` so the user can answer with a single digit. Mark the default with `(default)`.
- **For free-text answers** (paths, names), state the default inline like `default: ./src` and tell the user they can press Enter to accept.
- **Keep options short** — one line each, no tables. End the question cleanly without your own `>` prompt or `Default: …` line.
- **Accept loose answers** — if the user types `1` or `src` or just hits Enter, interpret reasonably.

### Required answers

1. **App location** — where does the user's application code live (or where should it live)?
   - Always include "the project root (`.`)" as one of the options.
   - Greenfield: default `./app`, with the project root offered as an alternative.
   - Brownfield: derive other choices from detected workspaces. For a monorepo, list the workspaces alongside the project root.

2. **Workflow** — which workflow should marmite use? Each workflow ships its own three agent prompts inside the marmite package; the choice determines which prompts the harness loads and how the orchestrator behaves. The prompts are NOT copied into the project — only the `workflow` name is recorded in `marmite.json`.

   List the choices by reading `$MARMITE_WORKFLOWS/*/workflow.json`:

   ```bash
   for f in $MARMITE_WORKFLOWS/*/workflow.json; do cat "$f"; echo; done
   ```

   Each `workflow.json` has `name`, `label`, `description`, and an optional `default: true`. Show the user a numbered list with the labels and one-line descriptions, default-marked. The default choice has `default: true` (currently `one-shot`); if multiple or none are flagged, fall back to `one-shot`.

   Save the chosen workflow's `name` value (e.g. `"one-shot"`, `"epic-checkpoint"`) for later — `marmite.json` (the `workflow` key) needs it. Omitting the key entirely is also valid and defaults to `one-shot`.

   **Workflow-specific follow-ups (extended wizard).** Each workflow may ship a `wizard.md` next to its `workflow.json` that declares extra questions, detection commands, and `marmite.json` keys specific to that workflow (e.g. branch names, checkpoint triggers, auth checks). After the user picks a workflow, check for `$MARMITE_WORKFLOWS/$WF/wizard.md`. If it exists, read it inline and execute its steps in order — same conventions as this skill (one question at a time, sensible defaults, never overwrite). Anything it instructs you to add to `marmite.json` must carry through to step 3's plan summary and step 4's write. If no `wizard.md` exists, skip — the workflow has no extra setup.

   Treat `wizard.md` as workflow-owned content: do not duplicate its instructions here, and do not hardcode logic for any specific workflow name.

3. **Models** — which Claude models for each role?
   - Default to `{ default: claude-sonnet-4-6, builder: claude-sonnet-4-6, verifier: claude-haiku-4-5, orchestrator: claude-sonnet-4-6 }` and just confirm.
   - Offer a "thorough" preset (Opus for builder) and a "fast" preset (Haiku everywhere) for users who want them.

4. **MCP servers (optional)** — extra Model Context Protocol servers to expose to every agent (orchestrator, builder, verifier). Off by default; opt-in only.

   Briefly explain in 2–3 lines before asking:

   - MCP servers add tools the agents can call — e.g. **Playwright** (`@playwright/mcp`) lets the verifier drive a real browser when checking UI work.
   - The harness keeps `strictMcpConfig` on, so the user's global Claude Code MCP config is ignored — only servers listed in `marmite.json.mcpServers` load. This avoids tool-list bloat that balloons every agent spawn's cache cost.
   - More tools = bigger system prompt = higher per-call cost; only enable what the workflow needs.

   Ask **one** question:

   > Wire any MCP servers into the agent loop? Optional — skip unless you have a specific need.
   > 1. skip — no MCP servers (default)
   > 2. Playwright — `npx -y @playwright/mcp@latest` (lets agents drive a real browser)
   > 3. add your own — I'll prompt for name + command

   If the user picks Playwright, emit:

   ```jsonc
   "mcpServers": {
     "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
   }
   ```

   If they pick "add your own", ask for a short name (`[a-z0-9-]+`) and either a stdio command (e.g. `npx -y some-mcp@latest`) or a URL. Build the matching shape:
   - stdio: `{ "command": "<first token>", "args": ["<rest>"] }` (omit `type`)
   - http: `{ "type": "http", "url": "<url>" }`
   - sse: `{ "type": "sse", "url": "<url>" }`

   Multiple servers are fine — loop until done. **Skip** is the right answer for most projects.

5. **Budgets** — per-story USD cap and total run cap. Default `{ perStory: 15, total: 100 }`. One question, two numbers; users almost always accept defaults.

### Don't ask about

- The PRD — that's `marmite to-prd`'s job. Mention it in the next-steps block.
- Timeouts, retries, max iterations, resume — keep marmite's defaults.
- API key — that's an env var (`ANTHROPIC_API_KEY`), not config.

---

## Step 3 — Show the plan

Before writing anything, summarize what you're about to do:

```
I'll write:
  marmite.json         (app=<chosen path>, workflow=<chosen>, balanced models)
                       (plus any workflow-specific keys the extended wizard collected — list them by name)
  .claude/skills/      (install helper skills: list whatever folders are under $MARMITE_TEMPLATES/skills/)

Agent prompts for the "<chosen>" workflow ship with marmite and load automatically — nothing is copied. Override one later by dropping <role>-prompt.md into .marmite/prompts/.
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
  // A workflow may ship a `wizard.md` that instructs the wizard to add extra
  // keys here. When it does, carry them through; otherwise emit none. Do not
  // invent workflow-specific keys — the workflow owns its own setup.
  "models": {
    "default": "claude-sonnet-4-6",
    "builder": "claude-sonnet-4-6",
    "verifier": "claude-haiku-4-5",
    "orchestrator": "claude-sonnet-4-6"
  },
  // OPTIONAL. Only emit when the user opted into MCP servers in step 2.
  // Omit the key entirely otherwise.
  // "mcpServers": {
  //   "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
  // },
  "timeouts": { "build": "20m", "verify": "10m", "fix": "15m", "orchestrate": "10m" },
  "budget": { "perStory": 15, "total": 100 },
  "retries": { "fix": 3, "transient": 2 },
  "maxIterations": 1000
}
```

Only emit keys the user explicitly chose; let marmite's defaults handle the rest. A minimal config is fine.

### Install helper skills from `$MARMITE_TEMPLATES`

The marmite package's templates tree was given to you in the preamble as `MARMITE_TEMPLATES=<absolute path>`. Only helper skills are copied into the project — agent prompts live in `$MARMITE_WORKFLOWS/<workflow>/prompts/` and the harness loads them straight from the package (the wizard only reads `workflow.json`/`wizard.md` from there, never copies the prompts).

```
$MARMITE_WORKFLOWS/                                     (shipped workflows — read, never copied)
├── one-shot/
│   ├── workflow.json
│   ├── wizard.md           (OPTIONAL — extra wizard steps; read by init)
│   └── prompts/            (loaded by the harness directly from the package)
│       ├── orchestrator-prompt.md
│       ├── builder-prompt.md
│       └── verifier-prompt.md
└── epic-checkpoint/{ workflow.json, prompts/ }

$MARMITE_TEMPLATES/
└── skills/                  → ./.claude/skills/         (always installed)
    ├── architect/
    └── prd-generator/
    (… any other skill folders present)
```

Procedure:

1. `mkdir -p ./.claude/skills`
2. For each sub-directory under `$MARMITE_TEMPLATES/skills/`:
   - target = `./.claude/skills/<skill-name>`
   - if target does not exist: `cp -R "$MARMITE_TEMPLATES/skills/<skill-name>" "$target"`
   - if target exists: leave it alone. Note "skipped (already present)" in the summary.
3. List what you copied vs. skipped in your final summary.

Helper skills are user-authored content once installed — they should be checked in so the team shares the same setup. Agent prompts are not copied: the team shares the same behavior by sharing the `workflow` value in `marmite.json`. To customize a prompt, drop `<role>-prompt.md` into `.marmite/prompts/` — that override is checked in and takes precedence over the packaged prompt.

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
  - Edit marmite.json to tune models and budgets.
  - Agent prompts ship with marmite for your chosen workflow. To customize one,
    copy it from the package into .marmite/prompts/<role>-prompt.md and edit there
    — the override takes precedence. Run `marmite doctor` to check it for drift.

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
- **Schema-validate before writing.** marmite validates `marmite.json` on `cook` startup; if you produce invalid JSON the user sees an error on the very first run.
- **Don't generate `.marmite/prd.json` here.** That's `marmite to-prd`'s job.
- **Don't install dependencies during init.**
- **Don't run `marmite cook` or `marmite to-prd` yourself.** End the session after writing files and printing next steps.
