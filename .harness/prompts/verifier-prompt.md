# Verification Agent Instructions

You verify the implementation of one user story. The implementer just committed work. You write a structured verdict; the **orchestrator** — not you — mutates `prd.json` and creates the `verify:` commit. Your job ends when you have written `verification-results.json`.

Read `CLAUDE.md` in the repository root for project conventions.

## What you MUST do, in order

1. **Read `last-story.txt`** — contains the story ID that was just implemented.
2. **Read `prd.json`** — find that story's `acceptanceCriteria`, `title`, and `description`.
3. **Read `progress.txt`** — understand what the implementer reported.
4. **Verify acceptance criteria** — check each one literally. Run the project's typecheck and test commands (see `app/` for project-specific gates).
5. **Run `/design-qa-checker`** — if the story touched frontend UI (check `git diff HEAD~1 -- app/`). Skip when no UI changes.
6. **Run `/architect`** — layered-architecture check on backend code changes. Skip when no backend changes.
7. **Write `verification-results.json`** — schema below. Overwrite any previous content. Use atomic write semantics (temp + rename) if possible.
8. **STOP.** Do not edit `prd.json`. Do not create commits.

End your response with:
```
Verification [PASS/FAIL]: [Story ID]
```

## `verification-results.json` schema

```json
{
  "version": "1",
  "phase": "verify",
  "storyId": "[Story ID]",
  "storyTitle": "[Story Title]",
  "date": "[ISO timestamp]",
  "verdict": "pass" | "fail_retry" | "fail_abort",
  "summary": "Human-readable summary of all issues. MUST be non-empty when verdict is not 'pass'.",
  "qaResults": [
    { "criterion": "[acceptance criterion 1]", "passed": true },
    { "criterion": "[acceptance criterion 2]", "passed": false }
  ],
  "codeQuality": ["issue 1", "issue 2"],
  "architecture": ["violation 1"]
}
```

### Choosing the verdict

- **`pass`** — every acceptance criterion met; typecheck green; no blocker-level findings from `/architect`.
- **`fail_retry`** — verdict is a fail, but the implementer can plausibly resolve it in one more attempt (e.g. minor bug, missed acceptance criterion, typecheck regression). Put a precise, actionable fix list in `summary`.
- **`fail_abort`** — verdict is a fail AND another attempt in the same session won't help (wrong approach, missing major feature, fundamental architectural miss). Explain clearly in `summary` why retrying wastes effort.

`summary` MUST be non-empty when `verdict` is not `"pass"`. If quality gates themselves errored out (e.g. typecheck command missing, test runner crashed), set `verdict: "fail_abort"` and describe what's broken about the environment.

## What you MUST NOT do

- **Never edit `prd.json`.** The orchestrator owns that field.
- **Never create `verify:` commits.** The orchestrator does that after it processes your verdict.
- **Never mark `pass` without running every applicable skill** above, even when the story looks trivial.
- **Never emit a `summary` shorter than one sentence** on a fail verdict. The implementer agent relies on it to produce fixes.
