import { z } from "zod";

const DurationSchema = z.union([z.string(), z.number()]);

// MCP server configs the harness will forward to the Claude Agent SDK. Mirrors
// the SDK's `McpServerConfigForProcessTransport` minus the `sdk` variant (which
// requires a live in-process McpServer instance and can't come from JSON).
const McpStdioServerSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const McpSseServerSchema = z.object({
  type: z.literal("sse"),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});
const McpHttpServerSchema = z.object({
  type: z.literal("http"),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});
export const McpServerConfigSchema = z.union([
  McpStdioServerSchema,
  McpSseServerSchema,
  McpHttpServerSchema,
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

// A sensor is a named quality check the user defines. `to-prd` reads these and
// folds them into each epic's "Refactor and harden" story so the builder runs
// them and the verifier confirms them — the harness itself does not execute
// sensors. `guidance` is the shell snippet / instructions for running the check.
export const SensorEntrySchema = z.object({
  name: z.string().min(1, "sensor.name is required"),
  guidance: z.string().min(1, "sensor.guidance is required"),
});
export type SensorEntry = z.infer<typeof SensorEntrySchema>;

export const MarmiteConfigSchema = z.object({
  app: z.string().optional(),
  prd: z.string().optional(),
  // Workflow selects which packaged agent prompts the harness loads and, for
  // epic-checkpoint, makes it halt at each epic boundary. It maps to a shipped
  // workflow under src/workflows/<workflow>/. Omitted → defaults to "one-shot".
  workflow: z.string().optional(),
  // User-defined quality checks surfaced in the per-epic "Refactor and harden"
  // stories that `to-prd` can append. Empty/omitted → those stories fall back
  // to generic lint/typecheck/test criteria.
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
  // Opt-in MCP servers forwarded to every agent (orchestrator, builder,
  // verifier). The harness keeps `strictMcpConfig: true`, so only the servers
  // listed here load — user/global Claude Code MCP config is still ignored to
  // avoid tool-list bloat on every agent spawn.
  mcpServers: z.record(z.string().min(1), McpServerConfigSchema).optional(),
});
export type MarmiteConfig = z.infer<typeof MarmiteConfigSchema>;

export function formatConfigError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
