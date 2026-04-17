import { z } from "zod";
import type { HarnessConfig, HarnessState } from "./types.ts";
import { readJson, readJsonField, writeAtomicJson } from "./utils.ts";

export const STATE_VERSION = "1";

const SessionPhaseSchema = z.enum(["orchestrate", "build", "verify", "fix"]);

const HarnessStateSchema = z.object({
  version: z.literal(STATE_VERSION),
  branchName: z.string(),
  iteration: z.number().int(),
  storyId: z.string(),
  buildSessionId: z.string(),
  fixAttempts: z.number().int(),
  lastPhase: z.union([SessionPhaseSchema, z.literal("idle")]),
  updatedAt: z.string(),
});

export async function persistState(config: HarnessConfig, state: HarnessState): Promise<void> {
  await writeAtomicJson(config.statePath, state);
}

export async function loadState(config: HarnessConfig): Promise<HarnessState | null> {
  const read = await readJson(config.statePath);
  if (read.kind !== "present") return null;
  const parsed = HarnessStateSchema.safeParse(read.value);
  return parsed.success ? parsed.data : null;
}

export async function clearStateIfBranchChanged(config: HarnessConfig): Promise<void> {
  const state = await loadState(config);
  if (!state) return;
  const currentBranch = await readJsonField(config.prdPath, "branchName");
  if (state.branchName !== currentBranch) {
    try {
      await Bun.write(config.statePath, "");
    } catch {}
  }
}
