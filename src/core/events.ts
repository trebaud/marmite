import { appendFile } from "fs/promises";
import type { HarnessEvent, HarnessEventKind } from "./types.ts";

// JSONL event log. The harness writes structured events here so external tools
// (dashboards, post-run analyzers) can consume the run's history. Distinct from
// the human-readable console output, which lives in src/cli/logger.ts.

// Distributes over the union so each variant keeps its own discriminant fields
// (e.g. run_done's `reason`).
type PayloadFor<K extends HarnessEventKind, E = HarnessEvent> = E extends { kind: K }
  ? Omit<E, "kind">
  : never;

let eventLogPath: string | null = null;
let runId: string | null = null;
let currentIteration: number | null = null;

export function initEventLog(path: string): void {
  eventLogPath = path;
}

// Set/clear the per-run UUID that every event in this run is stamped with.
// Lets readers grep one run out of an events.jsonl that holds many.
export function setRunId(id: string | null): void {
  runId = id;
}

// Stamped on every event emitted while inside an iteration. Cleared with null
// between iterations so events like `run_done` don't carry stale iteration data.
export function setCurrentIteration(n: number | null): void {
  currentIteration = n;
}

export async function emitEvent<K extends HarnessEventKind>(
  kind: K,
  data: PayloadFor<K>,
): Promise<void> {
  if (!eventLogPath) return;
  const base: Record<string, unknown> = { ts: new Date().toISOString() };
  if (runId) base.runId = runId;
  if (currentIteration != null && !("iteration" in (data as Record<string, unknown>))) {
    base.iteration = currentIteration;
  }
  const entry = { ...base, kind, ...data };
  try {
    await appendFile(eventLogPath, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error(`  [events] failed to append: ${err}`);
  }
}

