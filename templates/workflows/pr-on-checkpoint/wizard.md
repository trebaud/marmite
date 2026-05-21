# pr-on-checkpoint — extra wizard steps

The init wizard reads this file when the user picks the `pr-on-checkpoint` workflow and executes the steps below in order before moving on to sensors. Follow the same conventions as the main wizard: one question at a time, numbered options for multi-choice, inline defaults for free-text, never overwrite without confirmation.

## Step W1 — Verify gh availability (non-blocking)

Run `gh auth status`. If gh is missing or unauthenticated, mention it as a follow-up the user must complete before `marmite cook` will produce PRs (install `gh`, run `gh auth login`). Don't block init on it — the orchestrator has a manual fallback.

## Step W2 — Checkpoint trigger

Ask **when** the workflow should halt and open a PR. Two options:

1. `every` (default) — open a PR after every N passing stories. Ask a follow-up for N (default `1`, which is one PR per story). Save as `workflowConfig: { "kind": "every", "stories": N }`.
2. `epic` — open a PR after the last story of each PRD epic passes. Save as `workflowConfig: { "kind": "epic" }`. Stories in `.marmite/prd.json` always carry an `epic` field (`marmite to-prd` enforces it); for this trigger to be useful the user should split work into distinct epics rather than the default single-epic PRD.

## Step W3 — Base branch

The orchestrator opens PRs from whatever branch the user has checked out into a base branch, and reconciles back against base after each merge. **`baseBranch` is REQUIRED** for this workflow — if it's missing, the orchestrator halts on the very first run with a `guidance` complaint. The wizard MUST emit it as a top-level key in `marmite.json`.

The working branch is **not** configured — `marmite cook` always operates on the currently checked-out branch. Remind the user in the plan summary to `git checkout -b <branch>` before they run `marmite cook` if they don't want commits landing on whatever they have checked out now.

Detect the base-branch default before asking:

```bash
# Prefer the remote HEAD; fall back to local main/master; default "main"
git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@' \
  || (git show-ref --verify --quiet refs/heads/main && echo main) \
  || (git show-ref --verify --quiet refs/heads/master && echo master) \
  || echo main
```

Ask **one** question with the inline default:

> Base branch (`baseBranch`, default: `<detected>`)? Press Enter to accept, or type a branch name.

Save as a **top-level** key in `marmite.json` (`baseBranch`). Do **not** nest it under `workflowConfig`.

## marmite.json additions

When emitting `marmite.json` in the main wizard's step 4, include these top-level keys:

```jsonc
{
  "baseBranch": "<from W3>",         // e.g. "main"
  "workflowConfig": { /* from W2 */ }
}
```

Mention the base branch in the plan summary (main wizard's step 3), plus a reminder that `marmite cook` will run on the currently checked-out branch, so the user sees both before confirming.
