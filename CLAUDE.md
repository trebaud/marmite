# Marmite Harness

The marmite package itself — a CLI that drives autonomous agents (orchestrator → builder → verifier) inside a *user's* project. There is no application code in this repo; marmite drives code generation in someone else's working directory.

## Hard Rules

- **The user's app path comes from their `marmite.json`** (`app` field). Never hardcode an app path in prompts, skills, or docs — read the configured value.
- **Do not modify harness internals** (`src/`, `index.ts`) without an explicit ask. The agent protocol, schemas, and state shape are breaking changes for every downstream user.
- **Sensor tooling installs where the sensor runs.** Lint / drift / other sensor configs and dev deps go inside each sub-project the sensor inspects — not just at the `app` root. A root aggregator that fans out is fine; a root-only install that leaves children uninstrumented is a setup bug. Silently skipping with "no script found" is never valid — wire it, or pass explicit wiring instructions to the builder via `guidance`.
- **All runtime artifacts live under `.marmite/`.** `prd.json`, `progress.txt`, and `current-task.json` are tracked in git (team shares project history); `events.jsonl` and `feedback.md` are gitignored. Never write marmite files to the project root.
