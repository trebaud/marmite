import { z } from "zod";
import { readJson } from "./utils.ts";
import { PATHS } from "./paths.ts";

const VerificationVerdictSchema = z.enum(["pass", "fail_retry", "fail_abort"]);
export type VerificationVerdict = z.infer<typeof VerificationVerdictSchema>;

// current-task.json is written by the orchestrator agent (story fields) and then
// updated in-place by the verifier (verdict fields). We only parse the verdict
// portion here; the verdict field being absent means the verifier hasn't run yet.
const VerificationInputSchema = z
  .object({
    storyId: z.string().min(1, "missing storyId"),
    storyTitle: z.string().optional(),
    verdict: VerificationVerdictSchema.optional(),
    summary: z.string().optional(),
    qaResults: z
      .array(z.object({ criterion: z.string().default(""), passed: z.boolean().default(false) }))
      .optional(),
    verifiedAt: z.string().optional(),
  })
  .transform((r, ctx) => {
    if (!r.verdict) {
      ctx.addIssue({ code: "custom", message: "verdict not yet written by verifier" });
      return z.NEVER;
    }
    const summary = r.summary ?? "";
    if (r.verdict !== "pass" && summary.trim() === "") {
      ctx.addIssue({ code: "custom", message: "summary must be non-empty when verdict is not 'pass'" });
      return z.NEVER;
    }
    return {
      storyId: r.storyId,
      storyTitle: r.storyTitle ?? "",
      verdict: r.verdict,
      summary,
      qaResults: r.qaResults ?? [],
      verifiedAt: r.verifiedAt ?? new Date().toISOString(),
    };
  });

export type VerificationResult = z.infer<typeof VerificationInputSchema>;

export type ParsedVerification =
  | { kind: "present"; value: VerificationResult }
  | { kind: "missing" }
  | { kind: "malformed"; error: string };

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

// Reads the verdict written by the verifier into current-task.json.
// Returns "missing" if the file doesn't exist or the verifier hasn't written a verdict yet.
export async function readVerificationResultFile(): Promise<ParsedVerification> {
  const read = await readJson(PATHS.currentTask);
  if (read.kind === "missing") return { kind: "missing" };
  if (read.kind === "malformed") {
    return { kind: "malformed", error: read.error.message };
  }
  const parsed = VerificationInputSchema.safeParse(read.value);
  if (!parsed.success) {
    const err = parsed.error;
    // "verdict not yet written" is expected between orchestrate and verify phases — treat as missing.
    if (err.issues.every((i) => i.message === "verdict not yet written by verifier")) {
      return { kind: "missing" };
    }
    return { kind: "malformed", error: formatZodError(err) };
  }
  return { kind: "present", value: parsed.data };
}


// Halt instruction written by the orchestrator when a workflow needs to stop the
// harness mid-run (e.g. waiting on a human PR merge in pr-on-checkpoint).
// The harness reads this after the orchestrate phase and exits 0 cleanly.
//
// `awaiting_pr_review` — the harness has paused for a PR to be reviewed and
// merged. `prNum` is present when the orchestrator opened the PR itself via
// `gh pr create`; absent when gh was unavailable and the user is expected to
// open the PR manually from the pushed branch. `reason` carries an optional
// explanation surfaced in the CLI (e.g. "gh CLI not installed").
const HaltSchema = z.object({
  kind: z.literal("awaiting_pr_review"),
  prNum: z.number().int().positive().optional(),
  branch: z.string().optional(),
  baseBranch: z.string().optional(),
  reason: z.string().optional(),
});
export type Halt = z.infer<typeof HaltSchema>;

const CurrentTaskDecisionSchema = z
  .object({
    storyId: z.string().min(1, "missing storyId"),
    storyTitle: z.string().optional(),
    ranSensors: z.array(z.string()).default([]),
    halt: HaltSchema.optional(),
    // "janitor" — sensor-debt-driven refactor task instead of a user story
    // (mark-passing routes to progress.json instead of prd.json).
    // "pr-review" — addressing PR review comments on an already-passing story
    // while the pr-on-checkpoint workflow is awaiting merge. The harness runs
    // build+verify but does NOT mark anything passing or write a verify commit
    // (the underlying story is already passes:true).
    kind: z.enum(["story", "janitor", "pr-review"]).optional(),
  })
  .transform((r) => ({
    storyId: r.storyId,
    storyTitle: r.storyTitle ?? "",
    ranSensors: r.ranSensors,
    halt: r.halt,
    kind: r.kind ?? "story",
  }));

export type CurrentTaskDecision = z.infer<typeof CurrentTaskDecisionSchema>;

export type ParsedCurrentTaskDecision =
  | { kind: "present"; value: CurrentTaskDecision }
  | { kind: "missing" }
  | { kind: "malformed"; error: string };

export async function readCurrentTaskDecision(): Promise<ParsedCurrentTaskDecision> {
  const read = await readJson(PATHS.currentTask);
  if (read.kind === "missing") return { kind: "missing" };
  if (read.kind === "malformed") return { kind: "malformed", error: read.error.message };
  const parsed = CurrentTaskDecisionSchema.safeParse(read.value);
  if (!parsed.success) return { kind: "malformed", error: formatZodError(parsed.error) };
  return { kind: "present", value: parsed.data };
}

export function buildFixPrompt(summary: string): string {
  return [
    "The verification agent has reviewed your work and found issues. Here is the summary:\n",
    "```",
    summary.trim(),
    "```\n",
    "Fix all issues listed above, then commit the fixes with message: `fix: [Story ID] - address verification feedback`.",
    "Do NOT start a new story — only fix the issues from verification.",
  ].join("\n");
}
