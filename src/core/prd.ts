import { z } from "zod";
import type { HarnessConfig } from "./types.ts";
import type { Reporter } from "./reporter.ts";
import { PATHS } from "./paths.ts";
import { readJson, writeAtomicJson } from "./utils.ts";

const PrdStorySchema = z.object({
  id: z.string().default(""),
  title: z.string().default(""),
  priority: z.number().default(Number.MAX_SAFE_INTEGER),
  passes: z.boolean().default(false),
  // Epic slug the story belongs to. Set by `marmite to-prd`; the epic-checkpoint
  // workflow halts the run at each epic boundary. Empty string means "ungrouped":
  // stories with no epic form a single bucket, so the run never halts (like one-shot).
  epic: z.string().default(""),
});
export type PrdStory = z.infer<typeof PrdStorySchema>;

const PrdFileSchema = z.object({
  userStories: z.array(z.looseObject({})),
});

// ── progress.json ─────────────────────────────────────────────────────────────
// Replaces the older free-form `progress.txt`. Holds a timeline of story
// completions plus a top-level patterns list. Tracked in git like prd.json —
// collaborators share the history.

const PatternSchema = z.object({
  name: z.string().default(""),
  description: z.string().default(""),
  addedInStory: z.string().default(""),
});
export type Pattern = z.infer<typeof PatternSchema>;

const StoryEntrySchema = z.object({
  kind: z.literal("story"),
  storyId: z.string(),
  ts: z.string(),
  verdict: z.enum(["pass", "fail_retry", "fail_abort"]).optional(),
  summary: z.string().default(""),
  testsAdded: z.array(z.string()).optional(),
  commitShas: z.array(z.string()).default([]),
});
export type StoryEntry = z.infer<typeof StoryEntrySchema>;

// Immutable approval record appended when a human approves an epic checkpoint
// (via `marmite cook --approve`). The epic-checkpoint gate derives "resume the
// next epic?" purely from the presence of one of these — nothing is ever
// mutated or removed.
const ApprovalEntrySchema = z.object({
  kind: z.literal("approval"),
  epic: z.string(),
  ts: z.string(),
  by: z.string().optional(),
});
export type ApprovalEntry = z.infer<typeof ApprovalEntrySchema>;

const TimelineEntrySchema = z.discriminatedUnion("kind", [StoryEntrySchema, ApprovalEntrySchema]);
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

const ProgressFileSchema = z.object({
  patterns: z.array(PatternSchema).default([]),
  timeline: z.array(TimelineEntrySchema).default([]),
});
export type Progress = z.infer<typeof ProgressFileSchema>;

export interface ProgressState {
  kind: "ok" | "missing" | "parse_error";
  patterns: Pattern[];
  timeline: TimelineEntry[];
  error?: string;
}

export async function readProgress(): Promise<ProgressState> {
  const read = await readJson(PATHS.progress);
  if (read.kind === "missing") return { kind: "missing", patterns: [], timeline: [] };
  if (read.kind === "malformed") {
    return { kind: "parse_error", patterns: [], timeline: [], error: read.error.message };
  }
  const parsed = ProgressFileSchema.safeParse(read.value);
  if (!parsed.success) {
    return {
      kind: "parse_error",
      patterns: [],
      timeline: [],
      error: parsed.error.issues.map((i) => i.message).join("; "),
    };
  }
  return { kind: "ok", patterns: parsed.data.patterns, timeline: parsed.data.timeline };
}

export interface PrdState {
  kind: "ok" | "parse_error";
  stories: PrdStory[];
  error?: string;
}

export async function readPrd(path: string): Promise<PrdState> {
  const read = await readJson(path);
  if (read.kind !== "present") {
    return {
      kind: "parse_error",
      stories: [],
      error: read.kind === "missing" ? "missing" : read.error.message,
    };
  }
  const file = PrdFileSchema.safeParse(read.value);
  if (!file.success) {
    return { kind: "parse_error", stories: [], error: "userStories is not an array" };
  }
  const stories = file.data.userStories.map((s) => PrdStorySchema.parse(s));
  return { kind: "ok", stories };
}

export function pickNextStory(stories: PrdStory[]): PrdStory | null {
  const open = stories.filter((s) => !s.passes && s.id !== "");
  if (open.length === 0) return null;
  open.sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id));
  return open[0]!;
}

// ── Epic checkpoint gate ────────────────────────────────────────────────────
// The epic-checkpoint workflow halts at each epic boundary until an approval
// record exists. All functions below are pure derivations over the immutable
// state (prd stories + progress timeline) — they never mutate anything.

// Epics in build order: ordered by the lowest story priority within each epic,
// ties broken by first appearance. Matches the order `pickNextStory` walks.
export function orderedEpics(stories: PrdStory[]): string[] {
  const minPriority = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  stories.forEach((s, idx) => {
    const e = s.epic;
    if (!minPriority.has(e) || s.priority < minPriority.get(e)!) minPriority.set(e, s.priority);
    if (!firstSeen.has(e)) firstSeen.set(e, idx);
  });
  return [...minPriority.keys()].sort(
    (a, b) => (minPriority.get(a)! - minPriority.get(b)!) || (firstSeen.get(a)! - firstSeen.get(b)!),
  );
}

export function epicComplete(stories: PrdStory[], epic: string): boolean {
  const inEpic = stories.filter((s) => s.epic === epic && s.id !== "");
  return inEpic.length > 0 && inEpic.every((s) => s.passes);
}

export function approvalExistsFor(timeline: TimelineEntry[], epic: string): boolean {
  return timeline.some((e) => e.kind === "approval" && e.epic === epic);
}

// The epic blocking the next story: the nearest earlier epic that is complete
// but not yet approved. Returns null when nothing blocks (first/ungrouped epic,
// already approved, or PRD complete) — i.e. the run may proceed.
export function blockingEpic(stories: PrdStory[], timeline: TimelineEntry[]): { epic: string } | null {
  const next = pickNextStory(stories);
  if (!next) return null;
  const epics = orderedEpics(stories);
  const k = epics.indexOf(next.epic);
  for (let j = k - 1; j >= 0; j--) {
    const e = epics[j]!;
    if (!epicComplete(stories, e)) continue;
    if (!approvalExistsFor(timeline, e)) return { epic: e };
  }
  return null;
}

// Appends an immutable approval record to the progress timeline. Reads the file
// raw (like markStoryPassing) so unknown fields are preserved. The caller is
// responsible for committing the file to git.
export async function appendApproval(epic: string, by: string | undefined): Promise<boolean> {
  const read = await readJson<Record<string, unknown>>(PATHS.progress);
  const progress: Record<string, unknown> =
    read.kind === "present" && read.value && typeof read.value === "object" ? read.value : {};
  const timeline = Array.isArray(progress.timeline) ? progress.timeline : [];
  timeline.push({ kind: "approval", epic, ts: new Date().toISOString(), ...(by ? { by } : {}) });
  progress.timeline = timeline;
  if (!Array.isArray(progress.patterns)) progress.patterns = [];
  await writeAtomicJson(PATHS.progress, progress);
  return true;
}

export async function markStoryPassing(
  config: HarnessConfig,
  storyId: string,
  reporter: Reporter,
): Promise<boolean> {
  const read = await readJson<Record<string, unknown>>(config.prdPath);
  if (read.kind !== "present") {
    reporter.error(
      `could not update prd.json for ${storyId}`,
      read.kind === "malformed" ? read.error.message : "missing",
      "prd",
    );
    return false;
  }
  const prd = read.value;
  const stories = Array.isArray(prd.userStories) ? prd.userStories : [];
  let matched = false;
  for (const s of stories) {
    if (s && typeof s === "object" && (s as any).id === storyId) {
      (s as any).passes = true;
      matched = true;
      break;
    }
  }
  if (!matched) {
    reporter.error(`story ${storyId} not found in prd.json`, "", "prd");
    return false;
  }
  await writeAtomicJson(config.prdPath, prd);
  return true;
}

export async function allStoriesPassingOrError(
  prdPath: string,
): Promise<{ kind: "done" } | { kind: "not_done" } | { kind: "error"; message: string }> {
  const prd = await readPrd(prdPath);
  if (prd.kind === "parse_error") return { kind: "error", message: prd.error ?? "parse error" };
  if (prd.stories.length === 0) return { kind: "not_done" };
  return prd.stories.every((s) => s.passes) ? { kind: "done" } : { kind: "not_done" };
}
