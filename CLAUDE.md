# Marmite — Agent Guide

Autonomous build loop: one **builder** agent implements a story, one **verifier** agent reviews it, the **orchestrator** updates `prd.json` and persists state. Sessions run with `bypassPermissions` and communicate through files. **Only the orchestrator writes `prd.json`.**

## The Loop

```
pick next story (lowest priority.passes=false)
  → BUILD     fresh session, implements & commits
  → VERIFY    fresh session, writes verification-results.json
  → FIX       resumes build session with feedback (if verdict=fail_retry)
  → mark pass → next story, or exit
```

## Agent Workflows

### Builder (`.harness/prompts/builder-prompt.md`)
1. Read `prd.json`, `progress.txt`, `verification-results.json` (if present).
2. Checkout `branchName`.
3. Pick story: lowest `priority` where `passes: false` (tie-break `id` asc).
4. Implement in `app/` only.
5. Run quality checks (typecheck, tests).
6. Commit: `feat: [Story ID] - [Title]` (fix attempts: `fix: [Story ID] - address verification feedback`).
7. Write `last-story.txt`, append to `progress.txt`.
8. **STOP** — never touch `prd.json`.

### Verifier (`.harness/prompts/verifier-prompt.md`)
1. Read `last-story.txt`, `prd.json`, `progress.txt`.
2. Verify acceptance criteria, run typecheck + tests, then `/design-qa-checker` (UI changes) and `/architect` (backend changes).
3. Write `verification-results.json` (schema below).
4. **STOP** — never touch `prd.json`, never commit.

### Orchestrator (`.harness/core/orchestrator.ts`)
- Validates `verification-results.json` (zod).
- `verdict=pass` → sets `passes: true`, commits `verify: [Story ID] - passed verification`.
- `verdict=fail_retry` → resumes build session with `summary` as fix prompt.
- `verdict=fail_abort` → records failure, moves on.
- Checkpoints `.harness/state.json` after every phase.
- Enforces per-phase timeouts and per-story cost budget.

## Protocol Files

| File | Writer | Reader | Purpose |
|---|---|---|---|
| `prd.json` | orchestrator only | all | Story status |
| `last-story.txt` | builder | verifier | Story ID just implemented |
| `verification-results.json` | verifier | orchestrator | Verdict + summary |
| `build-status.json` | builder (non-normal exit) | orchestrator | `skipped_no_work` / `blocked` / `error` |
| `progress.txt` | builder (append only) | builder, verifier | Cumulative learnings |
| `.harness/state.json` | orchestrator | orchestrator (resume) | Crash checkpoint |
| `.harness/events.jsonl` | orchestrator | post-run tooling | Structured event log |

## Verification Result Schema (v1)

Validated by zod in `.harness/core/protocol.ts`:

```json
{
  "version": "1",
  "phase": "verify",
  "storyId": "US-001",
  "storyTitle": "...",
  "date": "[ISO timestamp]",
  "verdict": "pass" | "fail_retry" | "fail_abort",
  "summary": "non-empty when verdict != pass",
  "qaResults": [{ "criterion": "...", "passed": true }],
  "codeQuality": ["..."],
  "architecture": ["..."]
}
```

Legacy `{ passed, needsMoreFixes }` shape is accepted and normalized to the verdict enum.

## PRD Format (`prd.json`)

```json
{
  "project": "...",
  "branchName": "...",
  "description": "...",
  "userStories": [
    {
      "id": "US-001",
      "title": "...",
      "description": "As a ..., I want ... so that ...",
      "acceptanceCriteria": ["...", "Typecheck passes"],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

## App Code

**All generated app code lives in `app/`**, never outside. Project-specific stack, conventions, and quality-gate commands should be documented by the target project (e.g. in an `app/CLAUDE.md` or the PRD) — the harness itself stays stack-agnostic.

## Commit Conventions

| Agent | Format |
|---|---|
| Builder (new story) | `feat: [Story ID] - [Title]` |
| Builder (fix) | `fix: [Story ID] - address verification feedback` |
| Verifier | **does not commit** |
| Orchestrator (pass) | `verify: [Story ID] - passed verification` |

## Skills

| Skill | Purpose | Used by |
|---|---|---|
| `/design-qa-checker` | UI vs Bitrefill design system | verifier |
| `/architect` | Layered architecture enforcement | verifier |
| `/prd`, `/ralph` | PRD authoring & conversion | manual |

## Progress Log Format

Builder **appends only** to `progress.txt`:

```
## [Date/Time] - [Story ID]
- What was implemented
- Files changed
- **Learnings:** anything future iterations should know that isn't obvious from the code
---
```

Reusable patterns belong in the nearest `CLAUDE.md`, not `progress.txt`.
