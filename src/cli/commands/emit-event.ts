import { z } from "zod";
import { PATHS } from "../../core/paths.ts";
import { emitEvent, initEventLog, setCurrentIteration, setRunId } from "../../core/events.ts";
import { die } from "../args.ts";

// Subcommand the orchestrator agent invokes around each sensor it runs.
// Validates the payload against a strict schema before appending to events.jsonl —
// keeps malformed agent output from breaking downstream consumers (logger tail,
// post-run analyzers).
//
//   marmite emit-event sensor-start  --sensor eslint [--type debt]
//   marmite emit-event sensor-end    --sensor eslint --duration-ms 4321 --exit-code 0 [--type debt]
//   marmite emit-event sensor-result --sensor eslint --finding-count 12 [--type debt] [--threshold 20] [--duration-ms 4321] [--exit-code 0]
//
// Janitor lifecycle (emitted by the orchestrator agent and the janitor skill;
// the dashboard's Sensor Health panel and per-sensor janitorTrips counter
// consume them):
//
//   marmite emit-event janitor-triggered --janitor-id <ID> --sensor <name> --finding-count <n> --threshold <n>
//   marmite emit-event janitor-fix-applied --janitor-id <ID> --finding <kind> [--commit-sha <sha>]
//   marmite emit-event janitor-fix-deferred --janitor-id <ID> --finding <kind> --reason <text>
//   marmite emit-event janitor-done --janitor-id <ID> --applied <n> --deferred <n>

const SensorStart = z.object({
  kind: z.literal("sensor_start"),
  sensor: z.string().min(1),
  sensorType: z.string().min(1).optional(),
});

const SensorEnd = z.object({
  kind: z.literal("sensor_end"),
  sensor: z.string().min(1),
  sensorType: z.string().min(1).optional(),
  durationMs: z.number().int().min(0),
  exitCode: z.number().int(),
});

const SensorResult = z.object({
  kind: z.literal("sensor_result"),
  sensor: z.string().min(1),
  sensorType: z.string().min(1).optional(),
  findingCount: z.number().int().min(0),
  threshold: z.number().int().min(0).optional(),
  durationMs: z.number().int().min(0).optional(),
  exitCode: z.number().int().optional(),
});

// `janitor_triggered` carries one or more trigger rows (one per sensor that
// crossed its threshold or — in `marmite refactor` maintenance mode — produced
// any findings). The CLI accepts the common single-sensor case via flags and
// wraps it in the array shape the event type expects.
const JanitorTriggered = z.object({
  kind: z.literal("janitor_triggered"),
  janitorId: z.string().min(1),
  triggers: z.array(
    z.object({
      sensor: z.string().min(1),
      findingCount: z.number().int().min(0),
      threshold: z.number().int().min(0),
    }),
  ).min(1),
});

const JanitorFixApplied = z.object({
  kind: z.literal("janitor_fix_applied"),
  janitorId: z.string().min(1),
  finding: z.string().min(1),
  commitSha: z.string().min(1).optional(),
});

const JanitorFixDeferred = z.object({
  kind: z.literal("janitor_fix_deferred"),
  janitorId: z.string().min(1),
  finding: z.string().min(1),
  reason: z.string().min(1),
});

const JanitorDone = z.object({
  kind: z.literal("janitor_done"),
  janitorId: z.string().min(1),
  applied: z.number().int().min(0),
  deferred: z.number().int().min(0),
});

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) die(`emit-event: unexpected positional '${a}'`);
    const v = args[++i];
    if (v === undefined) die(`emit-event: ${a} requires a value`);
    out[a.slice(2)] = v;
  }
  return out;
}

export async function runEmitEvent(argv: string[]): Promise<void> {
  // argv is the full process.argv; subcommand at [2], kind at [3], flags after.
  const kind = argv[3];
  const flags = parseFlags(argv.slice(4));

  initEventLog(PATHS.events);
  if (process.env.MARMITE_RUN_ID) setRunId(process.env.MARMITE_RUN_ID);
  const itEnv = process.env.MARMITE_ITERATION;
  if (itEnv) {
    const n = Number(itEnv);
    if (Number.isInteger(n) && n > 0) setCurrentIteration(n);
  }

  if (kind === "sensor-start") {
    const parsed = SensorStart.safeParse({
      kind: "sensor_start",
      sensor: flags["sensor"],
      sensorType: flags["type"],
    });
    if (!parsed.success) die(`emit-event sensor-start: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const { kind: _k, ...payload } = parsed.data;
    await emitEvent("sensor_start", payload);
    return;
  }

  if (kind === "sensor-end") {
    const durationMs = flags["duration-ms"] != null ? Number(flags["duration-ms"]) : NaN;
    const exitCode = flags["exit-code"] != null ? Number(flags["exit-code"]) : NaN;
    const parsed = SensorEnd.safeParse({
      kind: "sensor_end",
      sensor: flags["sensor"],
      sensorType: flags["type"],
      durationMs,
      exitCode,
    });
    if (!parsed.success) die(`emit-event sensor-end: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const { kind: _k, ...payload } = parsed.data;
    await emitEvent("sensor_end", payload);
    return;
  }

  if (kind === "sensor-result") {
    const findingCount = flags["finding-count"] != null ? Number(flags["finding-count"]) : NaN;
    const threshold = flags["threshold"] != null ? Number(flags["threshold"]) : undefined;
    const durationMs = flags["duration-ms"] != null ? Number(flags["duration-ms"]) : undefined;
    const exitCode = flags["exit-code"] != null ? Number(flags["exit-code"]) : undefined;
    const parsed = SensorResult.safeParse({
      kind: "sensor_result",
      sensor: flags["sensor"],
      sensorType: flags["type"],
      findingCount,
      threshold,
      durationMs,
      exitCode,
    });
    if (!parsed.success) die(`emit-event sensor-result: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const { kind: _k, ...payload } = parsed.data;
    await emitEvent("sensor_result", payload);
    return;
  }

  if (kind === "janitor-triggered") {
    const findingCount = flags["finding-count"] != null ? Number(flags["finding-count"]) : NaN;
    const threshold = flags["threshold"] != null ? Number(flags["threshold"]) : NaN;
    const parsed = JanitorTriggered.safeParse({
      kind: "janitor_triggered",
      janitorId: flags["janitor-id"],
      triggers: [{ sensor: flags["sensor"], findingCount, threshold }],
    });
    if (!parsed.success) die(`emit-event janitor-triggered: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const { kind: _k, ...payload } = parsed.data;
    await emitEvent("janitor_triggered", payload);
    return;
  }

  if (kind === "janitor-fix-applied") {
    const parsed = JanitorFixApplied.safeParse({
      kind: "janitor_fix_applied",
      janitorId: flags["janitor-id"],
      finding: flags["finding"],
      commitSha: flags["commit-sha"],
    });
    if (!parsed.success) die(`emit-event janitor-fix-applied: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const { kind: _k, ...payload } = parsed.data;
    await emitEvent("janitor_fix_applied", payload);
    return;
  }

  if (kind === "janitor-fix-deferred") {
    const parsed = JanitorFixDeferred.safeParse({
      kind: "janitor_fix_deferred",
      janitorId: flags["janitor-id"],
      finding: flags["finding"],
      reason: flags["reason"],
    });
    if (!parsed.success) die(`emit-event janitor-fix-deferred: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const { kind: _k, ...payload } = parsed.data;
    await emitEvent("janitor_fix_deferred", payload);
    return;
  }

  if (kind === "janitor-done") {
    const applied = flags["applied"] != null ? Number(flags["applied"]) : NaN;
    const deferred = flags["deferred"] != null ? Number(flags["deferred"]) : NaN;
    const parsed = JanitorDone.safeParse({
      kind: "janitor_done",
      janitorId: flags["janitor-id"],
      applied,
      deferred,
    });
    if (!parsed.success) die(`emit-event janitor-done: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const { kind: _k, ...payload } = parsed.data;
    await emitEvent("janitor_done", payload);
    return;
  }

  die(
    `emit-event: unknown kind '${kind ?? ""}'. Supported: sensor-start, sensor-end, sensor-result, janitor-triggered, janitor-fix-applied, janitor-fix-deferred, janitor-done.\n` +
      `  marmite emit-event sensor-start --sensor <name> [--type <drift|debt>]\n` +
      `  marmite emit-event sensor-end --sensor <name> --duration-ms <n> --exit-code <n> [--type <...>]\n` +
      `  marmite emit-event sensor-result --sensor <name> --finding-count <n> [--type <...>] [--threshold <n>] [--duration-ms <n>] [--exit-code <n>]\n` +
      `  marmite emit-event janitor-triggered --janitor-id <id> --sensor <name> --finding-count <n> --threshold <n>\n` +
      `  marmite emit-event janitor-fix-applied --janitor-id <id> --finding <kind> [--commit-sha <sha>]\n` +
      `  marmite emit-event janitor-fix-deferred --janitor-id <id> --finding <kind> --reason <text>\n` +
      `  marmite emit-event janitor-done --janitor-id <id> --applied <n> --deferred <n>`,
  );
}
