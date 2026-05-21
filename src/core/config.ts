import { z } from "zod";

export const SensorTypeSchema = z.enum(["drift", "debt"]);
export type SensorType = z.infer<typeof SensorTypeSchema>;

// Thresholds keyed by sensor type. A janitor task fires the moment any single
// threshold is met. Counts are produced by the orchestrator agent at sensor
// run-time; the harness does not enforce them itself.
export const JanitorConfigSchema = z.object({
  thresholds: z
    .object({
      drift: z.number().int().nonnegative().optional(),
      debt: z.number().int().nonnegative().optional(),
    })
    .optional(),
  // Cap on how many findings the janitor skill tackles per run. Small batches
  // are the safety mechanism — the skill should pick the highest-impact items.
  maxFindingsPerRun: z.number().int().positive().optional(),
  budgetUsd: z.number().nonnegative().optional(),
  // Optional allowlist; when omitted the janitor consults all configured sensors.
  sensors: z.array(z.string()).optional(),
});
export type JanitorConfig = z.infer<typeof JanitorConfigSchema>;

export const SensorEntrySchema = z.object({
  name: z.string().min(1, "sensor.name is required"),
  type: SensorTypeSchema,
  package: z.string().optional(),
  configPath: z.string().optional(),
  guidance: z.string().optional(),
});
export type SensorEntry = z.infer<typeof SensorEntrySchema>;

const DurationSchema = z.union([z.string(), z.number()]);

export const MarmiteConfigSchema = z.object({
  app: z.string().optional(),
  prd: z.string().optional(),
  // Base branch that PRs target and that the working branch reconciles against
  // after a merge. Consumed by workflows like pr-on-checkpoint. The working
  // branch is always whatever the user has checked out — marmite does not
  // manage it.
  baseBranch: z.string().optional(),
  // Workflow controls which agent prompts were installed at init time and which
  // optional behaviors the orchestrator runs (e.g. opening PRs and halting). The
  // harness does not act on this field directly — it reads prompts from
  // `.marmite/prompts/`. The orchestrator prompt may read `workflowConfig` at
  // runtime (e.g. pr-on-checkpoint reads `kind` and `stories`).
  workflow: z.string().optional(),
  workflowConfig: z.record(z.string(), z.unknown()).optional(),
  sensors: z.array(SensorEntrySchema).optional(),
  models: z
    .object({
      default: z.string().optional(),
      builder: z.string().optional(),
      verifier: z.string().optional(),
      orchestrator: z.string().optional(),
    })
    .optional(),
  timeouts: z
    .object({
      build: DurationSchema.optional(),
      verify: DurationSchema.optional(),
      fix: DurationSchema.optional(),
      orchestrate: DurationSchema.optional(),
    })
    .optional(),
  budget: z
    .object({
      perStory: z.number().optional(),
      total: z.number().optional(),
    })
    .optional(),
  retries: z
    .object({
      fix: z.number().int().nonnegative().optional(),
      transient: z.number().int().nonnegative().optional(),
    })
    .optional(),
  maxIterations: z.number().int().positive().optional(),
  // When present, the orchestrator agent compares post-run sensor counts to
  // these thresholds and materializes a janitor entry in `progress.json`
  // whenever any threshold is met. Omit to disable the feature entirely.
  janitor: JanitorConfigSchema.optional(),
});
export type MarmiteConfig = z.infer<typeof MarmiteConfigSchema>;

export function formatConfigError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
