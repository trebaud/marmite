# Marmite Harness

This is the harness root — it orchestrates autonomous agents that build an application inside `app/`.

## Hard Rules

- **Do not install or update dependencies here.** All dependency changes belong inside `app/` (or its workspaces). Never run `npm install`, `bun add`, `yarn add`, or similar in this directory.
- **Do not modify harness internals** (`.harness/`, `index.ts`, `harness.config.json`, `sensors/`) unless explicitly asked.
- **Application code lives in `app/`.** All implementation work targets that directory.
- **Sensor tooling must be installed where the sensor runs.** Configs and dev dependencies for lint / drift / other sensors belong inside each sub-project whose source the sensor inspects — not only at the app root. A root-level aggregator that fans out to sub-projects is fine, but a root-only install that leaves child sub-projects uninstrumented is a setup bug. Silently noting "no script found" and skipping the sensor is never a valid outcome; the orchestrator must either wire the sensor in the missing sub-project or pass explicit wiring instructions to the builder via `guidance`.

## Relevant Skills for This Project

When working on stories in this project, prefer these skills where they apply:

- **`design-qa-checker`** — run before committing any story that touches UI (HTML, JSX/TSX, CSS, Tailwind classes, component styling, layout). Verifies the built UI against the Bitrefill design system. Do not skip on UI-touching stories.
- **`architect`** — run to resolve violations flagged drift sensors
- **`clean-code`** / **`refactor`** — run to resolve violations flagged by the debt sensor.
- **`debug`** — test-first debugging when a `pulse` sensor reports test regressions.
- **`security-analysis`** / **`security-review`** — when a `safe` sensor reports vulnerabilities.
