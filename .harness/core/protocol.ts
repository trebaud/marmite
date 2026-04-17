import { z } from "zod";
import type { HarnessConfig } from "./types.ts";
import { readJson } from "./utils.ts";

const VerificationVerdictSchema = z.enum(["pass", "fail_retry", "fail_abort"]);
export type VerificationVerdict = z.infer<typeof VerificationVerdictSchema>;

// Raw input schema — accepts both the current verdict-based shape and the legacy
// {passed, needsMoreFixes} shape. The transform below normalizes to VerificationResult.
const VerificationInputSchema = z
  .object({
    version: z.string().optional(),
    storyId: z.string().min(1, "missing storyId"),
    storyTitle: z.string().optional(),
    date: z.string().optional(),
    summary: z.string().optional(),
    qaResults: z
      .array(z.object({ criterion: z.string().default(""), passed: z.boolean().default(false) }))
      .optional(),
    codeQuality: z.array(z.string()).optional(),
    architecture: z.array(z.string()).optional(),
    verdict: VerificationVerdictSchema.optional(),
    passed: z.boolean().optional(),
    needsMoreFixes: z.boolean().optional(),
  })
  .transform((r, ctx) => {
    let verdict: VerificationVerdict;
    if (r.verdict) {
      verdict = r.verdict;
    } else if (r.passed === true) {
      verdict = "pass";
    } else if (r.needsMoreFixes === true) {
      verdict = "fail_retry";
    } else if (r.needsMoreFixes === false) {
      verdict = "fail_abort";
    } else {
      ctx.addIssue({
        code: "custom",
        message: "missing verdict (expected 'pass'|'fail_retry'|'fail_abort')",
      });
      return z.NEVER;
    }
    const summary = r.summary ?? "";
    if (verdict !== "pass" && summary.trim() === "") {
      ctx.addIssue({
        code: "custom",
        message: "summary must be non-empty when verdict is not 'pass'",
      });
      return z.NEVER;
    }
    return {
      version: r.version ?? "1",
      phase: "verify" as const,
      storyId: r.storyId,
      storyTitle: r.storyTitle ?? "",
      date: r.date ?? new Date().toISOString(),
      verdict,
      summary,
      qaResults: r.qaResults ?? [],
      codeQuality: r.codeQuality ?? [],
      architecture: r.architecture ?? [],
    };
  });

export type VerificationResult = z.infer<typeof VerificationInputSchema>;

const BuildStatusKindSchema = z.enum(["done", "skipped_no_work", "blocked", "error"]);
export type BuildStatusKind = z.infer<typeof BuildStatusKindSchema>;

const BuildStatusSchema = z
  .object({
    version: z.string().optional(),
    storyId: z.string().optional(),
    status: BuildStatusKindSchema,
    reason: z.string().optional(),
    date: z.string().optional(),
  })
  .transform((r) => ({
    version: r.version ?? "1",
    phase: "build" as const,
    storyId: r.storyId ?? "",
    status: r.status,
    reason: r.reason ?? "",
    date: r.date ?? new Date().toISOString(),
  }));

export type BuildStatus = z.infer<typeof BuildStatusSchema>;

export type ParsedVerification =
  | { kind: "present"; value: VerificationResult }
  | { kind: "missing" }
  | { kind: "malformed"; error: string };

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export async function readVerificationResultFile(config: HarnessConfig): Promise<ParsedVerification> {
  const read = await readJson(config.verificationResultsPath);
  if (read.kind === "missing") return { kind: "missing" };
  if (read.kind === "malformed") {
    return { kind: "malformed", error: read.error.message };
  }
  const parsed = VerificationInputSchema.safeParse(read.value);
  if (!parsed.success) {
    return { kind: "malformed", error: formatZodError(parsed.error) };
  }
  return { kind: "present", value: parsed.data };
}

export async function readBuildStatusFile(config: HarnessConfig): Promise<BuildStatus | null> {
  const read = await readJson(config.buildStatusPath);
  if (read.kind !== "present") return null;
  const parsed = BuildStatusSchema.safeParse(read.value);
  return parsed.success ? parsed.data : null;
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
