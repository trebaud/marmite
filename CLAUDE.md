# Marmite Harness

This is the marmite package itself — a CLI/harness that drives autonomous agents (orchestrator → builder → verifier) to implement features described in a PRD inside a *user's* project. There is no application code in this repo; marmite's job is to drive code generation in someone else's working directory.

## Layout

- `index.ts` — CLI entry point (`marmite`, `marmite cook`, `marmite init`).
- `src/core/` — orchestrator, session runner, state, paths, config schema.
- `src/prompts/` — default agent prompts (builder, verifier, orchestrator). Users can override these by dropping same-named files into `.marmite/prompts/` in their own project.
- `.claude/skills/` — skills shipped with the package (`marmite-init`, `to-prd`, etc.).
- `package.json` `files` field — lists what gets published to npm. Anything outside that array is local-only.

## Hard Rules

- **The user's application path is configured in their `marmite.json`** under the `app` field. Never hardcode `./app/` in prompts, skills, or docs — always reference the configured `app` path.
- **Do not modify harness internals** (`src/`, `index.ts`) without an explicit ask. Changes to the agent protocol, schemas, or state shape are breaking changes for every downstream user.
- **Sensor tooling must be installed where the sensor runs.** Configs and dev dependencies for lint / drift / other sensors belong inside each sub-project whose source the sensor inspects — not only at the configured `app` root. A root-level aggregator that fans out to sub-projects is fine, but a root-only install that leaves child sub-projects uninstrumented is a setup bug. Silently noting "no script found" and skipping the sensor is never a valid outcome; the orchestrator must either wire the sensor in the missing sub-project or pass explicit wiring instructions to the builder via `guidance`.
- **Runtime artifacts are not source.** `.marmite/`, `current-task.json`, `progress.txt`, `archive/`, `.last-branch` are gitignored — never check them in.
