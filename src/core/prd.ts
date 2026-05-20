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
});
export type PrdStory = z.infer<typeof PrdStorySchema>;

const PrdFileSchema = z.object({
  userStories: z.array(z.looseObject({})),
});

// ── progress.json ─────────────────────────────────────────────────────────────
// Replaces the older free-form `progress.txt`. Holds a single interleaved
// timeline of story completions and janitor runs, plus a top-level patterns
// list. Tracked in git like prd.json — collaborators share the history.

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

const JanitorTriggerSchema = z.object({
  sensor: z.string(),
  findingCount: z.number().int().nonnegative(),
  threshold: z.number().int().nonnegative(),
});
export type JanitorTrigger = z.infer<typeof JanitorTriggerSchema>;

const JanitorEntrySchema = z.object({
  kind: z.literal("janitor"),
  id: z.string(),
  ts: z.string(),
  passes: z.boolean().default(false),
  title: z.string().default(""),
  triggeredBy: z.array(JanitorTriggerSchema).default([]),
  appliedFixes: z.array(z.string()).optional(),
  deferredFindings: z.array(z.string()).optional(),
  commitShas: z.array(z.string()).optional(),
});
export type JanitorEntry = z.infer<typeof JanitorEntrySchema>;

const TimelineEntrySchema = z.discriminatedUnion("kind", [
  StoryEntrySchema,
  JanitorEntrySchema,
]);
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

export function findUnfinishedJanitorEntry(timeline: TimelineEntry[]): JanitorEntry | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i]!;
    if (entry.kind === "janitor" && !entry.passes) return entry;
  }
  return null;
}

// The harness flips passes:true on a janitor entry the same way it does for a
// prd story. Returns false if the entry isn't found or the file is unreadable.
export async function markJanitorPassing(
  janitorId: string,
  reporter: Reporter,
): Promise<boolean> {
  const read = await readJson<Record<string, unknown>>(PATHS.progress);
  if (read.kind !== "present") {
    reporter.error(
      `could not update progress.json for ${janitorId}`,
      read.kind === "malformed" ? read.error.message : "missing",
      "progress",
    );
    return false;
  }
  const progress = read.value;
  const timeline = Array.isArray(progress.timeline) ? progress.timeline : [];
  let matched = false;
  for (const e of timeline) {
    if (e && typeof e === "object" && (e as any).kind === "janitor" && (e as any).id === janitorId) {
      (e as any).passes = true;
      matched = true;
      break;
    }
  }
  if (!matched) {
    reporter.error(`janitor entry ${janitorId} not found in progress.json`, "", "progress");
    return false;
  }
  await writeAtomicJson(PATHS.progress, progress);
  return true;
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
  const storiesDone = prd.stories.every((s) => s.passes);
  if (!storiesDone) return { kind: "not_done" };
  // Story queue is empty — but a pending janitor task blocks completion too.
  const progress = await readProgress();
  if (progress.kind === "parse_error") {
    return { kind: "error", message: `progress.json: ${progress.error ?? "parse error"}` };
  }
  if (progress.kind === "ok" && findUnfinishedJanitorEntry(progress.timeline)) {
    return { kind: "not_done" };
  }
  return { kind: "done" };
}
