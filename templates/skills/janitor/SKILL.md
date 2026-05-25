---
name: janitor
description: "Analysis reference for sensor-driven refactoring. Use when you have a list of sensor findings (eslint, tsc, depcruise, …) and need to decide which to fix, in what order, with what kind of change. Pure domain knowledge — no commits, no event emits, no file mutations. The calling agent owns the workflow."
allowed-tools: Read, Grep, Glob
---

# Janitor

This skill is a **reference document** for analyzing sensor findings. It does not run sensors, write to `.marmite/`, emit events, or make commits — the agent invoking it owns all of that. Your job here is purely to help the caller answer three questions:

1. Which of these findings are real and worth addressing?
2. Among the real ones, which N should be fixed in this batch?
3. For each picked finding, what kind of change is appropriate?

## 1. Parsing sensor output

Prefer structured output where the tool offers one — easier to parse, fewer surprises:

| Sensor | Structured invocation |
|---|---|
| `eslint` | `eslint --format=json` |
| `tsc` | `tsc --noEmit` (errors on stderr, file:line:col format) |
| `dependency-cruiser` | `dependency-cruiser --output-type json` |
| `madge` | `madge --json` |

Normalize every finding into:

```
{ file: string, line?: number, severity: "error" | "warning" | "info", kind: string, message: string }
```

Where the tool emits raw text and no structured form is offered, parse with a regex matched to the format the tool documents. Don't guess.

## 2. Filtering — what counts as a real finding

Drop findings that:

- Have `severity: "info"` — not your target. Address only `error` and `warning`.
- Have a source line containing the comment `// JANITOR-DEFER:` (any language's equivalent: `# JANITOR-DEFER:`, `/* JANITOR-DEFER: */`). These were tried in a previous run and broke tests; respect the marker.
- Refer to generated files, vendored code, or paths the project's lint config already excludes. If you're unsure, check whether the sensor's own config would have skipped the file (e.g. `.eslintignore`).

What's left is the **candidate pool**.

## 3. Ranking — which N to pick

Cap the batch at `janitor.maxFindingsPerRun` from `marmite.json` (default 5). **Small batches are the safety mechanism** — broad sweeps hide regressions. Future runs pick up the rest.

Within the candidate pool, rank highest-impact first using these tiebreakers, in order:

1. **Severity** — `error` before `warning`.
2. **Module fan-in** — findings in heavily-imported files before findings in leaves. Estimate fan-in with `grep -l "from ['\"].*<basename>['\"]" -r src/` or the equivalent for the project's import syntax. A finding in a file imported by 30 others is worth more than one in a dead-end utility.
3. **Clustering** — findings that share a file or module before scattered one-offs. One focused fix often clears multiple findings.
4. **Drift before debt** — when both types are present and the cap forces a choice, prefer `drift` findings (architectural) since they compound faster than `debt` findings (code quality).

Tie-break by `file` lexicographically so two runs with the same inputs produce the same picks.

## 4. Fix patterns

The right kind of change depends on the sensor type and the specific `kind` of finding.

### Drift findings (architectural)

| Finding kind | Typical fix |
|---|---|
| Cyclic dependency | Extract an interface or shared type into a new module both sides import; redirect the offending direction. |
| Wrong-layer import (e.g. domain → infrastructure) | Move the imported symbol to the correct layer, or invert the dependency via an interface. |
| Cross-feature import | Promote the shared code to a common module; do not couple sibling features. |
| God module / oversized file | Split by concern, not by line count. Look for natural seams (separate types, separate stateful vs pure functions). |

### Debt findings (code quality)

| Finding kind | Typical fix |
|---|---|
| `no-unused-vars`, dead code | Delete it. If it's a parameter required by an interface, prefix `_` only when the tool genuinely requires it. |
| `no-explicit-any`, weak typing | Tighten the type. If the value is genuinely unknown, use `unknown` and narrow at the use site rather than `any`. |
| Long function / high complexity | Extract a named helper for each distinct concern. Naming is the fix — if you can name the extraction clearly, the split is right. |
| Duplication | Extract a function or constant. Only when the duplication is *behaviorally* identical — coincidental syntactic match is not duplication. |
| `tsc` type error | Fix at the source of the wrong assumption, not the symptom. Adding a cast usually hides the bug, not fixes it. |

### When the right fix would change a public API

Don't, unless that's literally the only way to address the finding. Public-API churn during a janitor run looks like scope creep to the next reviewer and breaks downstream consumers. Defer with `JANITOR-DEFER: would require API change` instead.

## 5. When to defer

Returning "defer this one" is a legitimate output. Defer when:

- The candidate fix would change a public API (see above).
- The candidate fix would require modifying or deleting an existing test to silence the sensor. **Never gain a sensor pass by weakening test coverage** — that's gaming, not maintenance.
- The fix touches code under active development on another branch and would cause non-trivial conflicts.
- You cannot reason about whether a change is safe (e.g. dynamic typing hides the call graph). A confident defer is better than a guess.

The caller's workflow handles the actual `JANITOR-DEFER:` tagging and commit — your job is just to flag that this finding should be deferred and say why.

## 6. Output shape

When invoked, return a structured triage:

```
Picks (N = <cap>):
1. <file>:<line> — <kind> · <one-line rationale> · suggested fix: <one line>
2. …

Deferrals:
- <file>:<line> — <kind> · reason: <one line>
- …

Notes:
- <any cross-cutting observations the caller should know, e.g. "all picks cluster in src/api/handlers; expect to commit them as 2 fixes not 5">
```

The caller then iterates: apply fix 1, run tests, commit or revert, move on.

## 7. Hard rules

- **Never delete or weaken existing tests** to silence a sensor. That's gaming the verifier.
- **Never bypass `JANITOR-DEFER:` markers.** If a previous run tagged it, there was a reason. Only remove a marker if you have a concrete plan that addresses why it broke before.
- **Don't invent new conventions.** Match the project's existing folder names, module boundaries, and naming style.
- **One finding per fix.** Smaller diffs revert cleanly and read clearly.
- **Trust the cap.** If the project has 200 findings and your cap is 5, returning 5 is correct. The next run will pick up the next 5.
