---
name: to-prd
description: "Convert a markdown PRD into the .marmite/prd.json format that `marmite cook` consumes. Used internally by `marmite to-prd <PRD.md>`."
user-invocable: false
---

# Marmite PRD Converter

You are running as the `marmite to-prd` converter. Your **only job** is to translate the markdown PRD at `$MARMITE_PRD_INPUT` into the JSON schema below and write it to `$MARMITE_PRD_OUTPUT`.

This is a mechanical conversion — **do not resize, merge, split, reorder, or re-interpret stories.** The markdown PRD is the source of truth; preserve every user story exactly as authored.

---

## Workflow

1. **Read** `$MARMITE_PRD_INPUT`.
2. **Convert** the markdown into the JSON schema (rules below).
3. **Write** the JSON to `$MARMITE_PRD_OUTPUT`.
4. **Validate**: run `bun run validate-prd.ts $MARMITE_PRD_OUTPUT`. If it exits non-zero, fix the JSON and re-validate. Loop until exit 0.
5. **Report** one line: `wrote N stories to .marmite/prd.json, validated OK`.

Do not prompt the user for confirmation. Do not run `marmite cook`. End the session after step 5.

---

## Output Schema

```json
{
  "project": "[Project Name]",
  "description": "[One-line feature description from PRD title/intro]",
  "userStories": [
    {
      "id": "US-001",
      "title": "[Story title]",
      "description": "As a [user], I want [feature] so that [benefit]",
      "acceptanceCriteria": ["Criterion 1", "Criterion 2", "Typecheck passes"],
      "priority": 1,
      "passes": false,
      "notes": "",
      "dependencies": [],
      "epic": "auth"
    }
  ]
}
```

Field rules enforced by `validate-prd.ts`:

- `id` matches `US-\d{3,}` (e.g. `US-001`), unique across the list.
- `priority` is a non-negative integer. Stories execute in priority order.
- `passes` must be `false` in a freshly-generated PRD.
- `dependencies` (optional) must reference existing `US-###` ids with strictly lower `priority`.
- `epic` is required and non-empty.
- `acceptanceCriteria` has at least one item.

---

## Conversion Rules

### Top-level fields

- **`project`**: PRD title (strip leading `PRD:` / `# `).
- **`description`**: one-line summary from the PRD's Introduction/Overview section. If multi-paragraph, take the first sentence.

### User stories — preserve 1:1

For each `### US-NNN: ...` heading in the markdown PRD, emit exactly one JSON entry. Do **not** merge, split, or skip stories.

- **`id`**: copy from the markdown heading (e.g. `US-001`). Re-number sequentially starting at `US-001` only if the markdown uses a non-conforming scheme.
- **`title`**: text after the `US-NNN:` prefix in the heading.
- **`description`**: the `**Description:**` line, verbatim.
- **`acceptanceCriteria`**: each `- [ ] ...` bullet under `**Acceptance Criteria:**` becomes one string. Strip the `- [ ] ` prefix. Keep wording verbatim.
- **`priority`**: assigned in document order — first story is `1`, second is `2`, etc.
- **`passes`**: always `false`.
- **`notes`**: always `""`.
- **`dependencies`**: parsed from the `**Dependencies:**` line in the markdown story.
  - `None` (or missing) → `[]`.
  - Comma-separated ids → array of those ids (e.g. `"US-001, US-002"` → `["US-001", "US-002"]`).
- **`epic`**: parsed from the `**Epic:**` line.
  - Format in markdown is `EP-NNN — [Epic title]`. Use a kebab-case slug of the epic title as the JSON value (e.g. `"EP-001 — Data model"` → `"data-model"`).
  - If the PRD has no Epics section, use `"main"` for every story.

### Acceptance criteria normalization

- Preserve all criteria from the markdown verbatim.
- If "Typecheck passes" is missing from a story, append it.
- If the criteria mention browser/UI verification but not the exact dev-browser phrasing, leave the existing wording — do not add or rewrite.

---

## Validation Loop

After `Write`, always run:

```bash
bun run validated-prd.ts $MARMITE_PRD_OUTPUT
```

If validation fails, read the numbered error list, fix only the cited fields, re-write, and re-run. The validator enforces:

- Schema shape (types, required fields, id format).
- No duplicate ids.
- `dependencies` resolve to lower-priority stories.
- `passes` is `false` for every story.

---

## Example

**Input PRD excerpt:**
```markdown
# PRD: Task Status Feature

## Introduction
Add ability to mark tasks with different statuses.

## Epics
- **EP-001: Data model** — Persist status on tasks.
- **EP-002: Task UI** — Show and edit status inline.

## User Stories

### US-001: Task status schema and server actions
**Epic:** EP-001 — Data model

**Dependencies:** None

**Description:** As a developer, I need status stored in the DB and exposed via server actions.

**Acceptance Criteria:**
- [ ] Add status column: 'pending' | 'in_progress' | 'done' (default 'pending')
- [ ] Server action updateTaskStatus(id, status) persists change
- [ ] Typecheck passes

### US-002: Status badge and inline toggle on task list
**Epic:** EP-002 — Task UI

**Dependencies:** US-001

**Description:** As a user, I want to see and change task status from the list.

**Acceptance Criteria:**
- [ ] Each task row shows a colored status badge
- [ ] Inline dropdown saves immediately via server action
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill
```

**Output prd.json:**
```json
{
  "project": "Task Status Feature",
  "description": "Add ability to mark tasks with different statuses.",
  "userStories": [
    {
      "id": "US-001",
      "title": "Task status schema and server actions",
      "description": "As a developer, I need status stored in the DB and exposed via server actions.",
      "acceptanceCriteria": [
        "Add status column: 'pending' | 'in_progress' | 'done' (default 'pending')",
        "Server action updateTaskStatus(id, status) persists change",
        "Typecheck passes"
      ],
      "priority": 1,
      "passes": false,
      "notes": "",
      "dependencies": [],
      "epic": "data-model"
    },
    {
      "id": "US-002",
      "title": "Status badge and inline toggle on task list",
      "description": "As a user, I want to see and change task status from the list.",
      "acceptanceCriteria": [
        "Each task row shows a colored status badge",
        "Inline dropdown saves immediately via server action",
        "Typecheck passes",
        "Verify in browser using dev-browser skill"
      ],
      "priority": 2,
      "passes": false,
      "notes": "",
      "dependencies": ["US-001"],
      "epic": "task-ui"
    }
  ]
}
```

---

## Pre-write checklist

- [ ] One JSON story per markdown story (no merging, splitting, or dropping).
- [ ] IDs preserved from markdown (or sequentially assigned if the source is non-conforming).
- [ ] `priority` matches document order.
- [ ] `dependencies` parsed from the `**Dependencies:**` line; `None` → `[]`.
- [ ] `epic` parsed from the `**Epic:**` line and slugified; `"main"` if no Epics section exists.
- [ ] Every story has `passes: false`, `notes: ""`.
- [ ] "Typecheck passes" present in every story's acceptance criteria.
- [ ] Validator passes
