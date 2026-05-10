---
name: to-prd
description: "Convert a markdown PRD into the .marmite/prd.json format that `marmite cook` consumes. Used internally by `marmite to-prd <PRD.md>`."
user-invocable: false
---

# Marmite PRD Converter

You are running as the `marmite to-prd` converter. Your job: read the user's markdown PRD at `$MARMITE_PRD_INPUT`, transform it into the `prd.json` schema below, write it to `$MARMITE_PRD_OUTPUT`, and validate the result with `$MARMITE_VALIDATE_PRD`.

The user invoked this command with a path to their PRD (`marmite to-prd ./PRD.md`). They are sitting in their project's working directory.

---

## Workflow

1. **Read the input.** `Read $MARMITE_PRD_INPUT`. Skim the structure: title, sections, requirements, any explicit user stories.
2. **Draft the JSON in memory.** Apply the sizing/ordering rules below. Don't write the file yet.
3. **Show the plan.** Print a short summary: project name, branch name, story count, and a one-line title for each story (with priority and dependencies). Ask the user to confirm or request changes.
4. **Iterate if asked.** Merge/split stories, reorder, rename — whatever the user wants. Re-print the summary after each change. Loop until they accept.
5. **Write the file.** `Write $MARMITE_PRD_OUTPUT` with the final JSON.
6. **Validate.** Run `bun run $MARMITE_VALIDATE_PRD $MARMITE_PRD_OUTPUT`. If it exits non-zero, read the errors, fix the JSON, write again, and re-run the validator. Loop until exit 0.
7. **Report.** Print a 2–3 line summary: "wrote N stories to .marmite/prd.json, validated OK" plus any semantic notes (e.g. "merged X and Y because they touched the same component").

Do not run `marmite cook` for the user. End the session after step 7.

---

## Output Format

```json
{
  "project": "[Project Name]",
  "branchName": "[kebab-case-from-project]",
  "description": "[One-line feature description from PRD title/intro]",
  "userStories": [
    {
      "id": "US-001",
      "title": "[Story title]",
      "description": "As a [user], I want [feature] so that [benefit]",
      "acceptanceCriteria": [
        "Criterion 1",
        "Criterion 2",
        "Typecheck passes"
      ],
      "priority": 1,
      "passes": false,
      "notes": "",
      "dependencies": [],
      "epic": "auth"
    }
  ]
}
```

The `dependencies` field is optional. Use it to communicate execution order intent — marmite runs stories sequentially by priority, but `dependencies` makes the dependency graph explicit so humans reviewing the plan can spot ordering issues. Dependencies must point at stories with **lower priority numbers** (the validator enforces this).

The `epic` field is required. It groups related stories under a shared label (e.g. `"auth"`, `"dashboard"`, `"checkout"`). Stories in the same epic must be contiguous in priority order. The `pr-on-checkpoint` workflow with `kind: "epic"` uses this field to decide when to open a PR — once every story in an epic has passed, the next orchestrator iteration cuts a PR for the whole epic. Other workflows ignore it. If the PRD doesn't break work into distinct themes, put every story in a single `"main"` epic.

---

## Story Size: Optimize for Total Iterations

**Each marmite iteration is expensive.** Too many small stories = too many iterations. Too few large stories = context overflow and broken code. The goal is a balanced list of medium-complexity stories.

### Calibration target

Aim for stories that a skilled developer could implement in **2–4 hours**. Each story should represent a coherent slice of work — not a single line change, and not an entire subsystem.

### Right-sized (group related work)

- Schema migration + server actions that use it (backend slice)
- A full UI section: component + data fetching + error state
- A complete CRUD flow for a small entity
- A feature toggle + the UI that respects it
- A set of closely related filter/sort options on a list

### Too small (merge these)

- "Add a database column" alone — combine with the server action that uses it
- "Display X badge" alone — combine with the toggle that changes it
- "Add dropdown" alone — combine with the filter logic it triggers

### Too big (split these)

- "Build the entire dashboard" — split by major panel or data domain
- "Add authentication" — split into: schema + middleware, login/register UI, session/redirect logic
- "Refactor the API" — split by resource or concern, not endpoint-by-endpoint

### Rule of thumb

If the story touches **more than two distinct layers** (e.g. DB + backend + two separate UI pages), split it. If it touches **less than one coherent feature** (single column, single button), merge it with its natural neighbour.

**Target list length:** for a medium PRD, aim for **5–12 stories total**. Fewer than 5 usually means stories are too big; more than 15 usually means over-splitting.

---

## Story Ordering: Dependencies First

Stories execute in priority order. Earlier stories must not depend on later ones.

**Correct:**
1. Schema/database changes (migrations)
2. Server actions / backend logic
3. UI components that use the backend
4. Dashboard/summary views that aggregate data

**Wrong:**
1. UI component (depends on schema that doesn't exist yet)
2. Schema change

---

## Acceptance Criteria: Must Be Verifiable

Each criterion must be something a verifier can CHECK, not something vague.

### Good (verifiable)

- "Add `status` column to tasks table with default 'pending'"
- "Filter dropdown has options: All, Active, Completed"
- "Clicking delete shows confirmation dialog"
- "Typecheck passes"
- "Tests pass"

### Bad (vague)

- "Works correctly"
- "User can do X easily"
- "Good UX"
- "Handles edge cases"

### Always include as final criterion

```
"Typecheck passes"
```

For stories with testable logic, also include:
```
"Tests pass"
```

For UI stories, also include:
```
"Verify in browser using dev-browser skill"
```

Frontend stories are NOT complete until visually verified.

---

## Conversion Rules

1. **Each user story becomes one JSON entry.**
2. **IDs**: sequential `US-001`, `US-002`, … (the validator enforces the `US-###` format).
3. **Priority**: based on dependency order, then document order.
4. **All stories**: `passes: false`, `notes: ""`. The validator rejects stories with `passes: true` in a freshly-generated PRD.
5. **branchName**: derive from the project name as kebab-case (`"TodoApp"` → `"todo-app"`, `"My App"` → `"my-app"`).
6. **Always add** "Typecheck passes" to every story's acceptance criteria.

---

## Splitting and Grouping

Group logically related work into medium-complexity stories. Neither atomize everything nor lump everything together.

**Original:**
> "Add user notification system"

**Over-split (too many iterations):**
1. Add notifications table
2. Add notification service
3. Add bell icon to header
4. Add dropdown panel
5. Add mark-as-read
6. Add preferences page

**Well-grouped (efficient):**
1. US-001: Notifications schema + backend service (DB + send/receive logic)
2. US-002: Notification bell + dropdown panel (header icon + list UI)
3. US-003: Mark-as-read + unread count badge (interaction + state)
4. US-004: Notification preferences page (settings UI + persistence)

Four iterations instead of six, each story a complete vertical slice.

---

## Example

**Input PRD:**
```markdown
# Task Status Feature

Add ability to mark tasks with different statuses.

## Requirements
- Toggle between pending/in-progress/done on task list
- Filter list by status
- Show status badge on each task
- Persist status in database
```

**Output prd.json:**
```json
{
  "project": "TaskApp",
  "branchName": "task-status",
  "description": "Track task progress with status indicators on the task list.",
  "userStories": [
    {
      "id": "US-001",
      "title": "Task status schema and server actions",
      "description": "As a developer, I need status stored in the DB and exposed via server actions.",
      "acceptanceCriteria": [
        "Add status column: 'pending' | 'in_progress' | 'done' (default 'pending')",
        "Generate and run migration successfully",
        "Server action updateTaskStatus(id, status) persists change",
        "Typecheck passes"
      ],
      "priority": 1,
      "passes": false,
      "notes": "",
      "dependencies": [],
      "epic": "main"
    },
    {
      "id": "US-002",
      "title": "Status badge and inline toggle on task list",
      "description": "As a user, I want to see and change task status directly from the list.",
      "acceptanceCriteria": [
        "Each task row shows a colored status badge (gray=pending, blue=in_progress, green=done)",
        "Each row has a status dropdown that saves immediately via server action",
        "UI updates without full page refresh",
        "Typecheck passes",
        "Verify in browser using dev-browser skill"
      ],
      "priority": 2,
      "passes": false,
      "notes": "",
      "dependencies": ["US-001"],
      "epic": "main"
    },
    {
      "id": "US-003",
      "title": "Filter tasks by status",
      "description": "As a user, I want to filter the list to see only certain statuses.",
      "acceptanceCriteria": [
        "Filter dropdown: All | Pending | In Progress | Done",
        "Filter persists in URL params",
        "Typecheck passes",
        "Verify in browser using dev-browser skill"
      ],
      "priority": 3,
      "passes": false,
      "notes": "",
      "dependencies": ["US-001"],
      "epic": "main"
    }
  ]
}
```

The original 4 requirements collapsed into 3 stories by merging badge display and status toggle (both touch the same task row component).

---

## Pre-write checklist

Before calling `Write` on `$MARMITE_PRD_OUTPUT`, verify:

- [ ] Story count balanced: **5–12 stories** for a medium PRD.
- [ ] Each story groups logically related work (not a single micro-change, not a whole subsystem).
- [ ] Stories ordered by dependency (schema → backend → UI).
- [ ] IDs match `US-###`, sequential, no duplicates.
- [ ] Every story has `passes: false`, `notes: ""`, `dependencies: []` (or non-empty array of valid prior IDs).
- [ ] `dependencies` only reference IDs with strictly lower `priority`.
- [ ] Every story has an `epic` value; stories sharing an `epic` are contiguous in priority order. Default to a single `"main"` epic if the PRD has no natural grouping.
- [ ] Every story has "Typecheck passes" as a criterion.
- [ ] UI stories have "Verify in browser using dev-browser skill" as a criterion.
- [ ] Acceptance criteria are verifiable (not vague).

After writing, **always** run `bun run $MARMITE_VALIDATE_PRD $MARMITE_PRD_OUTPUT` and fix any errors before declaring done.
