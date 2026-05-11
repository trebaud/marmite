import { appendFile, open, stat } from "fs/promises";
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

// Tail events.jsonl from its current size, dispatching new lines to `onEvent`
// until `signal` aborts. Used by the orchestrator to surface sensor activity
// emitted by the agent (via `marmite emit-event`) in real time.
export function tailEvents(
  path: string,
  onEvent: (e: HarnessEvent & { ts?: string }) => void,
  signal: AbortSignal,
  pollMs = 250,
): void {
  let offset = 0;
  let buffered = "";
  let stopped = false;

  const stop = () => {
    stopped = true;
  };
  signal.addEventListener("abort", stop, { once: true });

  const init = async () => {
    try {
      offset = (await stat(path)).size;
    } catch {
      offset = 0;
    }
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const s = await stat(path);
      if (s.size > offset) {
        const fd = await open(path, "r");
        try {
          const buf = Buffer.alloc(s.size - offset);
          await fd.read(buf, 0, buf.length, offset);
          offset = s.size;
          buffered += buf.toString("utf8");
        } finally {
          await fd.close();
        }
        let nl: number;
        while ((nl = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (!line) continue;
          try {
            onEvent(JSON.parse(line));
          } catch {
            // Malformed JSONL line — drop it; not worth crashing the tail.
          }
        }
      }
    } catch {
      // File may not exist yet between init() and the first append; ignore.
    }
    if (!stopped) setTimeout(tick, pollMs);
  };

  void init().then(() => {
    if (!stopped) setTimeout(tick, pollMs);
  });
}
