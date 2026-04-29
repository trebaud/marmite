---
name: marmite-init
description: "Set up marmite in a project by interviewing the user. Detects greenfield vs brownfield, asks the right questions, and writes marmite.json + prd.json + .gitignore entries non-destructively."
user-invocable: true
---

# Marmite Setup Wizard

You are guiding a user through setting up [marmite](https://github.com/) in their project. Marmite is a harness that drives three Claude agents in a loop (orchestrator → builder → verifier) to implement features described in a `prd.json`. Your job is to interview the user and produce the configuration files marmite needs to run.

The user just ran `marmite init` (or `bunx marmite init`). They are sitting in their project's working directory. Take it from here.

---

## Step 1 — Detect the environment

Before asking anything, look around. Run `pwd` and `ls -la` to see the layout. Then check for these signals:

- **Already initialized**: `marmite.json` exists. Tell the user, then ask whether to **reconfigure** (re-run the interview using current values as defaults) or **abort**.
- **Brownfield**: `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, or `Gemfile` exists. There is real code here.
- **Greenfield**: directory is empty or only has dotfiles. No real code.

For brownfield, also read (lightly — don't dump them in full):
- `package.json` — stack, scripts, workspaces, devDependencies (eslint, tsc, vitest, jest, dependency-cruiser…)
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
- **Keep options short** — one line each, no tables. The user prompt that follows is `▶ your answer:` so the question must end cleanly without its own `>` prompt or `Default: …` line (the harness handles that).
- **Accept loose answers** — if the user types `1` or `src` or just hits Enter, interpret reasonably. Don't force exact strings.

Example:

```
**Question 1 of 5 — App location**

Where does your application code live?

  1. ./src                  (default — detected)
  2. ./ (project root)
  3. somewhere else — type the path
```

### Required answers

1. **App location** — where does the user's application code live (or where should it live)?
   - Greenfield: default `./app`, but offer "the project root" as an option.
   - Brownfield: derive from detected workspaces. If it's a monorepo, ask which workspace marmite should target.

2. **PRD source** — how should `prd.json` be seeded?
   - **Import from markdown**: ask for a path; invoke the `to-prd` skill on it.
   - **Interactive**: ask 3–6 questions about what they want to build next and produce a starter prd.json with 3–5 stories.
   - **Skip**: write a placeholder `prd.json` with one example story and a comment explaining the schema.

3. **Sensors** — which deterministic checks should marmite run between stories?
   - For brownfield, propose entries that **point at the user's existing configs** (`./.eslintrc.json`, `./tsconfig.json`, etc.). Detect what's there; don't ask the user to type paths.
   - For greenfield, offer a small default set keyed off the chosen stack (eslint + tsc for TS projects, ruff + pytest for Python, etc.). Each entry must have `name`, `type` (`drift|debt|pulse|safe`), and a `configPath` if a config is expected. Add a `guidance` field with the run command and any tool-specific notes.
   - Always allow "skip" — sensors are optional.

4. **Models** — which Claude models for each role?
   - Default to `{ default: claude-sonnet-4-6, builder: claude-sonnet-4-6, verifier: claude-haiku-4-5, orchestrator: claude-sonnet-4-6 }` and just confirm.
   - Offer a "thorough" preset (Opus for builder) and a "fast" preset (Haiku everywhere) for users who want them.

5. **Budgets** — per-story USD cap and total run cap. Default `{ perStory: 15, total: 100 }`. One question, two numbers; users almost always accept defaults.

### Don't ask about

- Timeouts, retries, max iterations, resume — keep marmite's defaults.
- API key — that's an env var (`ANTHROPIC_API_KEY`), not config.

---

## Step 3 — Show the plan

Before writing anything, summarize what you're about to do:

```
I'll write:
  marmite.json    (app=./apps/web, sensors=eslint+tsc, balanced models)
  prd.json        (5 stories seeded from your PRD.md)
  .gitignore      (append .marmite/state.json, .marmite/events.jsonl, …)
  .claude/skills/ (install helper skills: architect, design-qa-checker, to-prd, prd-generator)
```

Ask the user to confirm. If they say no, loop back to whichever step they want to change.

---

## Step 4 — Write the files

**Non-destructive rules — do not violate these.**

- For each file you'd write, check if it already exists. If yes, **show the diff** and ask before overwriting.
- Never `rm` a user file.
- `.gitignore` edits are idempotent: read it, append only the entries that aren't already present.

### `marmite.json` shape

JSONC (comments allowed). Inline structure:

```jsonc
{
  "app": "./apps/web",
  "prd": "./prd.json",
  "sensors": [
    {
      "name": "eslint",
      "type": "debt",
      "package": "eslint",
      "configPath": "./apps/web/.eslintrc.json",
      "guidance": "Run via `bun run lint:strict` in apps/web."
    }
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
  "maxIterations": 1000,
  "resume": true
}
```

Only emit keys the user explicitly chose; let marmite's defaults handle the rest. A minimal config is fine.

### `prd.json` shape

Use the `to-prd` skill if importing from markdown. Otherwise produce:

```json
{
  "project": "<project name>",
  "branchName": "<kebab-case>",
  "description": "<one-line>",
  "userStories": [
    {
      "id": "US-001",
      "title": "...",
      "description": "As a ..., I want ..., so that ...",
      "acceptanceCriteria": ["...", "..."],
      "priority": 1,
      "passes": false
    }
  ]
}
```

Stories should be 2–4 hours of work each. 3–5 stories is a healthy starter set; users can edit later.

### `.gitignore` entries

Append only if missing:
```
.marmite/state.json
.marmite/events.jsonl
.marmite/feedback.md
.marmite/feedback-archive/
progress.txt
current-task.json
archive/
.last-branch
```

Optional prompt overrides at `.marmite/prompts/*.md` are **not** gitignored — they're user-authored customizations and should be checked in.

### Install helper skills into the host project

The orchestrator and builder prompts reference helper skills (`architect`, `design-qa-checker`, `to-prd`, `prd-generator`). When `marmite cook` runs, the agents use the user's project as `cwd` and only discover skills under `./.claude/skills/` — they cannot see skills inside the marmite package. Copy them in.

The marmite package's skills source path was given to you in the preamble as `MARMITE_SKILLS_SRC=<absolute path>`. Use that path as the source. If for some reason it is missing, derive it: `node -p "require('path').dirname(require.resolve('marmite/package.json'))"` then append `/.claude/skills`.

Procedure:

1. `mkdir -p ./.claude/skills`
2. For each sub-directory in `$MARMITE_SKILLS_SRC` **except `marmite-init`** (that one stays in the package — it's only used by `marmite init` itself):
   - target = `./.claude/skills/<skill-name>`
   - if target does not exist: `cp -R "$MARMITE_SKILLS_SRC/<skill-name>" ./.claude/skills/<skill-name>`
   - if target exists: leave it alone (assume the user has customized it). Note it as "skipped (already present)" in the summary.
3. List what you copied vs. skipped in your final summary.

These skills are user-authored content once installed — do **not** add them to `.gitignore`. They should be checked in so the team shares the same helpers.

---

## Step 5 — Print next steps

End with a clear, scannable block:

```
Done. Next steps:

  1. Set your API key:
       export ANTHROPIC_API_KEY=sk-ant-...

  2. Verify (optional but recommended):
       marmite cook --dry-run     # not yet implemented; skip if it errors

  3. Run marmite:
       marmite cook -n 1          # one iteration first
       marmite cook               # full run

Customizing:
  - Edit marmite.json to tune models, sensors, budgets.
  - Place .marmite/prompts/builder-prompt.md to override the default builder prompt
    (same for verifier-prompt.md, orchestrator-prompt.md).

Steering a long run:
  - Drop free-form notes into .marmite/feedback.md at any time. The orchestrator
    picks them up at the start of the next iteration, applies them to story
    selection / guidance, then archives the file under .marmite/feedback-archive/.
```

Then stop. Don't run `marmite cook` for them; let them drive.

---

## Important rules

- **One question at a time.** Don't dump a wall of multi-part questions.
- **Detect first, ask second.** Reading `package.json` and showing a one-line summary beats asking the user to type their stack.
- **Never overwrite without showing a diff and getting confirmation.**
- **Schema-validate before writing.** marmite validates `marmite.json` and `prd.json` on `cook` startup; if you produce invalid JSON the user sees an error on the very first run. Double-check your output before writing.
- **Don't install dependencies during init.** Adding sensor packages (`bun add -d eslint`) is the user's call after init; mention it as a follow-up if they don't already have the tools installed.
- **Don't run `marmite cook` yourself.** End the session after writing files and printing next steps.
