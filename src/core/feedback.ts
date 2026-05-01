import { mkdir, rename } from "fs/promises";
import { resolve } from "path";
import { PATHS } from "./paths.ts";
import { emitEvent } from "./events.ts";
import { fileExists, formatDate } from "./utils.ts";
import type { Reporter } from "./reporter.ts";

// Async user-feedback channel: user drops Markdown into .marmite/feedback.md at any time;
// orchestrator picks it up next iteration and archives the file after using it.
export async function detectAndAnnounceFeedback(iteration: number, reporter: Reporter): Promise<void> {
  if (!(await fileExists(PATHS.feedback))) return;
  let raw = "";
  try {
    raw = await Bun.file(PATHS.feedback).text();
  } catch (err) {
    reporter.error(`failed to read ${PATHS.feedback}`, err, "feedback");
    return;
  }
  if (raw.trim() === "") return;
  const bytes = Buffer.byteLength(raw, "utf8");
  const preview = raw.slice(0, 200);
  reporter.feedbackDetected(bytes, preview);
  await emitEvent("feedback_detected", { iteration, bytes, preview });
}

// Defensive: if the orchestrator agent forgot to archive the feedback file,
// archive it ourselves so the same feedback isn't applied again next iteration.
export async function forceArchiveFeedbackIfPresent(iteration: number, reporter: Reporter): Promise<void> {
  if (!(await fileExists(PATHS.feedback))) return;
  // Skip empty leftovers — nothing meaningful to archive.
  try {
    const raw = await Bun.file(PATHS.feedback).text();
    if (raw.trim() === "") return;
  } catch {
    return;
  }
  try {
    await mkdir(PATHS.feedbackArchive, { recursive: true });
    const target = resolve(PATHS.feedbackArchive, `${formatDate()}-iter-${iteration}.md`);
    await rename(PATHS.feedback, target);
    reporter.feedbackForceArchived(target);
    await emitEvent("feedback_force_archived", { iteration, target });
  } catch (err) {
    reporter.error(`failed to force-archive feedback`, err, "feedback");
  }
}
