import { appendFile } from "fs/promises";

// JSONL event log. The harness writes structured events here so external tools
// (dashboards, post-run analyzers) can consume the run's history. Distinct from
// the human-readable console output, which lives in src/cli/logger.ts.

let eventLogPath: string | null = null;

export function initEventLog(path: string): void {
  eventLogPath = path;
}

export async function emitEvent(kind: string, data: Record<string, unknown>): Promise<void> {
  if (!eventLogPath) return;
  const entry = { ts: new Date().toISOString(), kind, ...data };
  try {
    await appendFile(eventLogPath, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error(`  [events] failed to append: ${err}`);
  }
}
