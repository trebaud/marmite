import { z } from "zod";

export const SensorTypeSchema = z.enum(["drift", "debt", "pulse", "safe"]);
export type SensorType = z.infer<typeof SensorTypeSchema>;

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
});
export type MarmiteConfig = z.infer<typeof MarmiteConfigSchema>;

export function formatConfigError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
