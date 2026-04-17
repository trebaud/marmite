# Marmite Harness

This is the harness root — it orchestrates autonomous agents that build an application inside `app/`.

## Hard Rules

- **Do not install or update dependencies here.** All dependency changes belong inside `app/` (or its workspaces). Never run `npm install`, `bun add`, `yarn add`, or similar in this directory.
- **Do not modify harness internals** (`.harness/`, `index.ts`, `harness.config.json`, `sensors/`) unless explicitly asked.
- **Application code lives in `app/`.** All implementation work targets that directory.
