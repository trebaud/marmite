---
name: to-prd
description: "Convert PRDs to prd.json format for the Ralph autonomous agent system. Use when you have an existing PRD and need to convert it to Ralph's JSON format. Triggers on: convert this prd, turn this into ralph format, create prd.json from this, ralph json, to-prd."
user-invocable: true
---

# Ralph PRD Converter

Converts existing PRDs to the prd.json format that Ralph uses for autonomous execution.

---

## The Job

Take a PRD (markdown file or text) and convert it to `prd.json` in your ralph directory.

---

## Output Format

```json
{
  "project": "[Project Name]",
  "branchName": "[app-name-kebab-case]",
  "description": "[Feature description from PRD title/intro]",
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
      "dependencies": []
    }
  ]
}
```

The `dependencies` field is **optional**. Omit it or leave it as `[]` when the story has no dependencies. When a story depends on previous stories, list their IDs:

```json
"dependencies": ["US-001", "US-002"]
```

Use this to communicate execution order intent — Ralph runs stories sequentially by priority, but `dependencies` makes the dependency graph explicit so humans reviewing the plan can spot ordering issues.
```

---

## Story Size: Optimize for Total Iterations

**Each Ralph iteration is expensive.** Too many small stories = too many iterations. Too few large stories = context overflow and broken code. The goal is a balanced list of **medium-complexity stories**.

### The calibration target

Aim for stories that a skilled developer could implement in **2–4 hours**. Each story should represent a coherent slice of work — not a single line change, and not an entire subsystem.

### Right-sized stories (group related work):
- Schema migration + server actions that use it (backend slice)
- A full UI section: component + data fetching + error state
- A complete CRUD flow for a small entity
- A feature toggle + the UI that respects it
- A set of closely related filter/sort options on a list

### Too small (merge these):
- "Add a database column" alone — combine with the server action that uses it
- "Display X badge" alone — combine with the toggle that changes it
- "Add dropdown" alone — combine with the filter logic it triggers

### Too big (split these):
- "Build the entire dashboard" — split by major panel or data domain
- "Add authentication" — split into: schema + middleware, login/register UI, session/redirect logic
- "Refactor the API" — split by resource or concern, not endpoint-by-endpoint

### Rule of thumb

If the story touches **more than two distinct layers** (e.g., DB + backend + two separate UI pages), split it. If it touches **less than one coherent feature** (single column, single button), merge it with its natural neighbour.

**Target list length:** For a medium PRD, aim for **5–12 stories total**. Fewer than 5 usually means stories are too big; more than 15 usually means over-splitting.

---

## Story Ordering: Dependencies First

Stories execute in priority order. Earlier stories must not depend on later ones.

**Correct order:**
1. Schema/database changes (migrations)
2. Server actions / backend logic
3. UI components that use the backend
4. Dashboard/summary views that aggregate data

**Wrong order:**
1. UI component (depends on schema that does not exist yet)
2. Schema change

---

## Acceptance Criteria: Must Be Verifiable

Each criterion must be something Ralph can CHECK, not something vague.

### Good criteria (verifiable):
- "Add `status` column to tasks table with default 'pending'"
- "Filter dropdown has options: All, Active, Completed"
- "Clicking delete shows confirmation dialog"
- "Typecheck passes"
- "Tests pass"

### Bad criteria (vague):
- "Works correctly"
- "User can do X easily"
- "Good UX"
- "Handles edge cases"

### Always include as final criterion:
```
"Typecheck passes"
```

For stories with testable logic, also include:
```
"Tests pass"
```

### For stories that change UI, also include:
```
"Verify in browser using dev-browser skill"
```

Frontend stories are NOT complete until visually verified. Ralph will use the dev-browser skill to navigate to the page, interact with the UI, and confirm changes work.

---

## Conversion Rules

1. **Each user story becomes one JSON entry**
2. **IDs**: Sequential (US-001, US-002, etc.)
3. **Priority**: Based on dependency order, then document order
4. **All stories**: `passes: false` and empty `notes`
5. **branchName**: Derive from the project name as kebab-case (e.g., `"TodoApp"` → `"todo-app"`, `"My App"` → `"my-app"`)
6. **Always add**: "Typecheck passes" to every story's acceptance criteria

---

## Splitting and Grouping PRDs

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

Four iterations instead of six, each story is a complete vertical slice.

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
  "branchName": "ralph/task-status",
  "description": "Task Status Feature - Track task progress with status indicators",
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
      "dependencies": []
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
      "dependencies": ["US-001"]
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
      "dependencies": ["US-001"]
    }
  ]
}
```

Note: the original 4 stories are now 3 by merging badge display and status toggle (both touch the same task row component).

---

## Archiving Previous Runs

**Before writing a new prd.json, check if there is an existing one from a different feature:**

1. Read the current `prd.json` if it exists
2. Check if `project` differs from the new feature's project name
3. If different AND `progress.txt` has content beyond the header:
   - Create archive folder: `archive/YYYY-MM-DD-feature-name/`
   - Copy current `prd.json` and `progress.txt` to archive
   - Reset `progress.txt` with fresh header

**The ralph.sh script handles this automatically** when you run it, but if you are manually updating prd.json between runs, archive first.

---

## Checklist Before Saving

Before writing prd.json, verify:

- [ ] **Previous run archived** (if prd.json exists with different project name, archive it first)
- [ ] Story count is balanced: **5–12 stories** for a medium PRD (fewer = too big, more = over-split)
- [ ] Each story groups logically related work (not a single micro-change, not a whole subsystem)
- [ ] Stories are ordered by dependency (schema to backend to UI)
- [ ] Every story has a `dependencies` field (empty array `[]` if none)
- [ ] `dependencies` only reference stories with lower priority numbers (no forward references)
- [ ] Every story has "Typecheck passes" as criterion
- [ ] UI stories have "Verify in browser using dev-browser skill" as criterion
- [ ] Acceptance criteria are verifiable (not vague)
- [ ] No story depends on a later story
