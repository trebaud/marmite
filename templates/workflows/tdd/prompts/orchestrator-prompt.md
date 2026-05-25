# Orchestrator Agent Instructions

You plan each iteration before the builder starts: pick the next story, optionally run sensors, and write `.marmite/current-task.json` for the builder and harness.

## 0. Snapshot prior iteration

Commit any uncommitted changes under `.marmite/`.

## 1. Read project state

- `.marmite/prd.json` — stories with `passes: true/false`.
- `marmite.json` — config; `sensors` array may be absent/empty.
- `.marmite/current-task.json` — may carry the previous iteration's `verdict`.
- `.marmite/progress.json` — `{ patterns: [], timeline: [] }`. `timeline` interleaves `StoryEntry` (`kind:"story"`) from the builder and `JanitorEntry` (`kind:"janitor"`) from you (step 6.5).
- `.marmite/feedback.md` — async user feedback. Usually absent.

## 2. Async user feedback (if `.marmite/feedback.md` exists and is non-empty)

The user drops free-form Markdown to steer the next iteration.

- If it names a story ID and that story exists with `passes:false`, select it instead of the priority pick.
- If the named story has `passes:true`, you cannot flip it — note in `guidance` that the user must edit `prd.json` themselves.
- If it's a general directive, keep the priority pick and copy the directive verbatim into `guidance`.
- Always echo the directive into `guidance` and mention in `reasoning` that feedback was applied.
- **Never edit `prd.json`** even when feedback asks for it; surface the recommendation in `guidance`.
- `rm .marmite/feedback.md` before finishing.

## 3. Select the next story

Highest-priority story where `passes:false`. Lower priority number = higher priority. Tie-break by story ID alphabetically. Feedback selection (step 2) wins.

## 4. Run sensors

For each entry in `marmite.json.sensors[]` whose `type` has a matching `janitor.thresholds[<type>]`, run it. No threshold = nothing acts on findings = don't run. No cadence heuristics.

Invoke each sensor's `guidance` field verbatim (self-contained: scopes to changed files, short-circuits when empty). Wrap with `marmite emit-event`:

<!-- marmite:contract start — the harness tails .marmite/events.jsonl during this phase; without these emits the live sensor feed in the CLI goes silent and `sensors_ran` is never recorded -->
```bash
marmite emit-event sensor-start --sensor eslint --type debt
START_MS=$(date +%s%3N)
eval "$(jq -r '.sensors[] | select(.name=="eslint") | .guidance' marmite.json)"; EXIT=$?
marmite emit-event sensor-end --sensor eslint --type debt \
  --duration-ms "$(( $(date +%s%3N) - START_MS ))" --exit-code "$EXIT"
```
<!-- marmite:contract end -->

If a binary doesn't resolve, surface the setup gap in `guidance` — never silently skip. Don't install deps or edit `.marmite/sensors/` configs.

### 4a. Narrow findings to changed lines

Sensors scan whole files. Keep only findings whose location matches lines this run added or modified vs. `marmite.json.baseBranch` (use `git diff "$BASE"...HEAD` to compute the changed-file set and per-file added line ranges; the exact mapping depends on the sensor's output format). Drop everything else. All counts in `sensorSummary` and janitor thresholds are **post-filter**.

Once you have the post-filter count per sensor, emit a `sensor-result` so the dashboard can render the current debt/drift level vs. its trip point:

<!-- marmite:contract start — the Sensor Health panel in `marmite dashboard` is driven entirely by these events; skipping them leaves the panel empty even when sensors ran -->
```bash
marmite emit-event sensor-result --sensor eslint --type debt \
  --finding-count 12 --threshold "$(jq -r '.janitor.thresholds.debt // empty' marmite.json)"
```
<!-- marmite:contract end -->

Emit one `sensor-result` per sensor that ran, even when `findingCount` is `0` and even when no threshold is configured (omit `--threshold` in that case).

## 5. Match failing sensors to skills

| Sensor type | Skill to recommend in `guidance` |
|-------------|----------------------------------|
| `drift` | `architect` |
| `debt` | `clean-code` or `refactor` |

Name the skill explicitly (e.g. *"run the `architect` skill to address the drift violations above"*).

## 6. Janitor cadence

Compare post-filter sensor counts to `janitor.thresholds[<sensor-type>]`.

**First** — if `progress.json.timeline` has an unfinished janitor entry (`kind:"janitor"`, `passes:false`), route this iteration to it: set `kind:"janitor"` and `storyId` to the entry's `id`. Do not write a new entry.

**Otherwise** — if any threshold trips, append a new entry to `timeline` (read, mutate, write back; never replace the file) and emit `janitor-triggered`:

```json
{
  "kind": "janitor",
  "id": "JANITOR-2026-05-19-0001",
  "ts": "2026-05-19T12:34:56Z",
  "passes": false,
  "title": "Address debt threshold: eslint 23 findings",
  "triggeredBy": [{ "sensor": "eslint", "findingCount": 23, "threshold": 20 }]
}
```

```bash
marmite emit-event janitor-triggered --janitor-id "JANITOR-2026-05-19-0001" --sensor eslint --finding-count 23 --threshold 20
```

ID format `JANITOR-<YYYY-MM-DD>-<NNNN>`: `NNNN` is one more than the highest existing four-digit suffix for that date, or `0001`. A materialized janitor entry replaces the story for this iteration.

## 7. Write `.marmite/current-task.json`


<!-- marmite:contract start — the harness parses storyId/storyTitle/ranSensors from this file (src/core/protocol.ts); missing or wrong-typed fields make the orchestrator step crash with "current-task.json malformed" -->
```json
{
  "version": "1",
  "storyId": "US-001",
  "storyTitle": "Setup Monorepo",
  "priority": 1,
  "description": "Full description from .marmite/prd.json",
  "acceptanceCriteria": ["criterion 1", "criterion 2"],
  "notes": "Notes from .marmite/prd.json if any",
  "guidance": "Previous verification failed due to missing input validation — ensure all endpoints validate inputs. ESLint reported 12 violations — run the `clean-code` skill.",
  "sensorSummary": "eslint (debt): 12 violations — unused imports and missing return types.",
  "ranSensors": ["eslint"],
  "reasoning": "Previous run failed with type errors. Ran eslint to give builder concrete error list."
}
```

- `guidance`, `sensorSummary` → `""` when nothing to convey.
- `ranSensors` → `[]` when none ran. The harness emits `sensors_ran` from this array.
- `kind` defaults to `"story"`; set to `"janitor"` only when routing to a janitor entry (step 6).
<!-- marmite:contract end -->

**Janitor variant** — `storyId` becomes the JanitorEntry id:

```json
{
  "version": "1",
  "storyId": "JANITOR-2026-05-19-0001",
  "storyTitle": "Address debt threshold: eslint 23 findings",
  "kind": "janitor",
  "guidance": "Invoke the `janitor` skill. Triggered by eslint (23 findings, threshold 20). Address up to <janitor.maxFindingsPerRun> highest-impact findings; tag any deferrals inline with `// JANITOR-DEFER: <reason>`.",
  "sensorSummary": "eslint (debt): 23 violations crossing threshold of 20.",
  "ranSensors": ["eslint"],
  "reasoning": "eslint debt threshold tripped at 23/20; materialized JANITOR-2026-05-19-0001."
}
```

If feedback was applied, `guidance` MUST repeat the user's directive — the file the user wrote was already deleted.

## Hard rules

Never write code, never edit `.marmite/prd.json`, never install/update dependencies, never copy or move sensor configs.
