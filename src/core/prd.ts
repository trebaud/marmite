import { z } from "zod";
import type { HarnessConfig } from "./types.ts";
import { logError } from "./logger.ts";
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

export async function markStoryPassing(config: HarnessConfig, storyId: string): Promise<boolean> {
  const read = await readJson<Record<string, unknown>>(config.prdPath);
  if (read.kind !== "present") {
    logError(
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
    logError(`story ${storyId} not found in prd.json`, "", "prd");
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
  const done = prd.stories.every((s) => s.passes);
  return done ? { kind: "done" } : { kind: "not_done" };
}
