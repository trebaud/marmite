import { unlink } from "fs/promises";
import { PATHS } from "./paths.ts";
import { emitEvent } from "./events.ts";
import { fileExists } from "./utils.ts";
import type { Reporter } from "./reporter.ts";

// Async user-feedback channel: user drops Markdown into .marmite/feedback.md at any time;
// orchestrator picks it up next iteration and deletes the file after using it.
export async function detectAndAnnounceFeedback(iteration: number, reporter: Reporter): Promise<boolean> {
  if (!(await fileExists(PATHS.feedback))) return false;
  let raw = "";
  try {
    raw = await Bun.file(PATHS.feedback).text();
  } catch (err) {
    reporter.error(`failed to read ${PATHS.feedback}`, err, "feedback");
    return false;
  }
  if (raw.trim() === "") return false;
  const bytes = Buffer.byteLength(raw, "utf8");
  const preview = raw.slice(0, 200);
  reporter.feedbackDetected(bytes, preview);
  await emitEvent("feedback_detected", { iteration, bytes, preview });
  return true;
}

// Defensive: if the orchestrator agent forgot to delete the feedback file,
// delete it ourselves so the same feedback isn't applied again next iteration.
export async function forceClearFeedbackIfPresent(iteration: number, reporter: Reporter, feedbackWasDetected = false): Promise<void> {
  if (!(await fileExists(PATHS.feedback))) {
    if (feedbackWasDetected) await emitEvent("feedback_applied", { iteration });
    return;
  }
  // Skip empty leftovers — nothing meaningful to clear.
  try {
    const raw = await Bun.file(PATHS.feedback).text();
    if (raw.trim() === "") return;
  } catch {
    return;
  }
  try {
    await unlink(PATHS.feedback);
    reporter.feedbackForceCleared();
    await emitEvent("feedback_force_cleared", { iteration });
  } catch (err) {
    reporter.error(`failed to force-clear feedback`, err, "feedback");
  }
}
