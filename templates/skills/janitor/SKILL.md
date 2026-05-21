---
name: janitor
description: "Sensor-driven refactor pass. Use when `.marmite/current-task.json.kind === \"janitor\"` — re-run the triggering sensors, pick the top-N highest-impact findings, and apply each fix incrementally with test gates between steps."
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, Agent
---

# Janitor

You run when marmite has materialized a janitor task — a sensor-debt-driven refactor pass. The orchestrator has already detected that one or more sensors crossed their threshold and recorded a `JanitorEntry` in `.marmite/progress.json.timeline`. Your job is to reduce that debt **safely** and in small batches. The verifier passes the entry only if a triggering sensor shows strictly fewer findings AND the test suite is still green.

## Inputs (read these first)

1. `.marmite/current-task.json` — the current task. Specifically:
   - `storyId` — the JanitorEntry id (e.g. `JANITOR-2026-05-19-0001`).
   - `kind` — must be `"janitor"`. If it isn't, you're being invoked in the wrong context — stop.
   - `guidance` — the orchestrator's instructions, including the cap on fixes per run.
   - `sensorSummary` / `ranSensors` — what already ran in the orchestrate phase.
2. `.marmite/progress.json` — find the `JanitorEntry` with `id === current-task.json.storyId`. Read `triggeredBy[]` — that's your baseline (each `findingCount` is what the verifier compares against).
3. `marmite.json` — read `janitor.maxFindingsPerRun` (default 5 if unset), `janitor.sensors` (optional allowlist), and the sensor definitions themselves (`name`, `package`, `configPath`, `guidance`).

## Workflow

### 1. Audit — enumerate fresh findings

For each sensor in `triggeredBy` (or `janitor.sensors` if specified):

- Use the sensor's `guidance` from `marmite.json` to determine the run command — same one the orchestrator used. Prefer a structured output flag where the tool offers one (`eslint --format=json`, `tsc --noEmit | tee`, `dependency-cruiser --output-type json`). Structured output makes finding extraction reliable; raw text is fine when no structured option exists.
- Parse the output into a flat list of `{ file, line?, severity, kind, message }` findings. Filter to `severity ∈ {error, warning}` — info-level noise is not your target.
- Drop any finding whose source line contains `// JANITOR-DEFER:` — those have already been triaged and rejected by a previous run.

### 2. Triage — rank by impact

Cluster findings by file and module. Rank highest-impact first:

- Errors before warnings.
- Findings in heavily-imported modules before leaf files (use `grep -l` to estimate fan-in if it's not obvious).
- Findings that cluster in the same file before scattered one-offs (one focused fix can clear multiple).

Pick the top **N** findings, where N = `janitor.maxFindingsPerRun` (default 5). **Small batches are the safety mechanism** — do not try to fix everything; the verifier only needs strictly-fewer to pass.

### 3. Execute — one fix at a time, tests between each

For each picked finding:

1. Apply the smallest change that resolves it. Match the sensor's guidance for that finding type:
   - `drift` (architectural) — move code to the correct layer, extract an interface, redirect an import.
   - `debt` (code quality) — decompose a long function, replace a custom routine with a library call, eliminate duplication, fix a type error.
2. Run the project's test suite (`bun test` / `npm test` as inferred from `package.json`). If tests pass:
   - Commit the change with message: `refactor(janitor): <JANITOR-ID> - <short description>` and `git add` only the files touched by this fix.
   - Record an `appliedFixes` entry: a short string like `"eslint no-unused-vars: dropped 3 unused imports in src/foo/bar.ts"`.
   - Emit `marmite emit-event janitor-fix-applied --janitor-id <ID> --finding "<kind>" --commit-sha <SHA>`.
3. If tests break:
   - Revert that change (`git restore --source=HEAD <paths>` or `git reset --hard HEAD`).
   - Tag the finding's source line with `// JANITOR-DEFER: <reason>` so future janitor runs skip it. Commit that as part of the next fix or as its own `refactor(janitor): defer ...` commit.
   - Record a `deferredFindings` entry: `"<kind> at <file>:<line> — broke <test name>; reverted and tagged JANITOR-DEFER"`.
   - Emit `marmite emit-event janitor-fix-deferred --janitor-id <ID> --finding "<kind>" --reason "<short>"`.

Stop early if: (a) you've applied or deferred all top-N findings, (b) the cost budget in `janitor.budgetUsd` is exhausted (you don't track this directly — the harness gates you), or (c) every remaining candidate has been deferred this run.

### 4. Record — mutate the JanitorEntry in place

Read `.marmite/progress.json`, find the matching `JanitorEntry`, **mutate it in place**:

```json
{
  "kind": "janitor",
  "id": "JANITOR-2026-05-19-0001",
  "passes": false,
  "title": "...",
  "triggeredBy": [...],
  "appliedFixes": [
    "eslint no-unused-vars: dropped 3 unused imports in src/foo/bar.ts",
    "tsc 2322: tightened return type on src/api/user.ts:42"
  ],
  "deferredFindings": [
    "drift cyclic-dep at src/services/auth.ts — moving extracted helper broke contract test; reverted and tagged JANITOR-DEFER"
  ],
  "commitShas": ["a1b2c3d", "e4f5g6h"]
}
```

Do **not** append a new timeline entry — mutate the one the orchestrator already added. Do **not** flip `passes` yourself — that's the harness's job after the verifier signs off.

Emit `marmite emit-event janitor-done --janitor-id <ID> --applied <N> --deferred <M>`.

## Hard rules

- **One finding per commit.** Easier to revert, easier for the verifier to read.
- **Tests must pass after every applied commit.** If they don't, you reverted incorrectly — go back and fix the revert before continuing.
- **Never delete or weaken existing tests** to silence a sensor. That's gaming the verifier.
- **Never bypass deferred findings.** A `// JANITOR-DEFER:` marker means it was tried and broke things. Respect it; only remove it if you have a concrete plan that addresses why it broke before.
- **Do not change public APIs** unless that's literally the only way to fix a drift violation. Public-API churn during a janitor run looks like scope creep to the next reviewer.
- **Do not invent new conventions.** Keep the project's existing folder names and module layout. Janitor is for fixing what's there, not redesigning it.
- **Stay within the batch cap** (`janitor.maxFindingsPerRun`). The cap exists because broad sweeps hide regressions; future runs will pick up the rest.

## When to bail early

Stop and end your response without recording fixes if any of these hold:

- `current-task.json.kind` is not `"janitor"` — you were invoked in the wrong context.
- The matching `JanitorEntry` is not present in `progress.json` — the orchestrator did not materialize it; surface that as a setup gap.
- The very first sensor re-run shows zero findings — the debt evaporated between orchestrate and now (someone else's commit, perhaps); record an empty `appliedFixes` and a note in `deferredFindings` so the verifier sees the state.
