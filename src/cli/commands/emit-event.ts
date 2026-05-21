import { z } from "zod";
import { PATHS } from "../../core/paths.ts";
import { emitEvent, initEventLog, setCurrentIteration, setRunId } from "../../core/events.ts";
import { die } from "../args.ts";

// Subcommand the orchestrator agent invokes around each sensor it runs.
// Validates the payload against a strict schema before appending to events.jsonl —
// keeps malformed agent output from breaking downstream consumers (logger tail,
// post-run analyzers).
//
//   marmite emit-event sensor-start --sensor eslint [--type debt]
//   marmite emit-event sensor-end   --sensor eslint --duration-ms 4321 --exit-code 0 [--type debt]

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

  die(
    `emit-event: unknown kind '${kind ?? ""}'. Supported: sensor-start, sensor-end.\n` +
      `  marmite emit-event sensor-start --sensor <name> [--type <drift|debt>]\n` +
      `  marmite emit-event sensor-end --sensor <name> --duration-ms <n> --exit-code <n> [--type <...>]`,
  );
}
