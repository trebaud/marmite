import { resolve } from "path";
import { mkdir } from "fs/promises";
import type { HarnessConfig } from "./types.ts";
import { logArchive } from "./logger.ts";
import { PATHS } from "./paths.ts";
import {
  fileExists,
  formatDate,
  readJsonField,
  readText,
  writeAtomic,
} from "./utils.ts";

// Detects when the PRD switched to a new branch and archives the old run's
// prd.json + progress.txt so they aren't overwritten by the new project.
export async function archivePreviousRun(config: HarnessConfig): Promise<void> {
  const prdExists = await fileExists(config.prdPath);
  const lastBranchExists = await fileExists(PATHS.lastBranch);
  if (!prdExists || !lastBranchExists) return;

  const currentBranch = await readJsonField(config.prdPath, "branchName");
  const lastBranch = (await readText(PATHS.lastBranch)).trim();
  if (!currentBranch || !lastBranch || currentBranch === lastBranch) return;

  // Snapshot both files into memory once to avoid check-then-write races.
  const prdBuf = await Bun.file(config.prdPath).arrayBuffer();
  const progressBuf = (await fileExists(PATHS.progress))
    ? await Bun.file(PATHS.progress).arrayBuffer()
    : null;

  const date = formatDate();
  const folderName = lastBranch.replace(/[^\w.-]/g, "_");
  const archiveFolder = resolve(PATHS.archiveDir, `${date}-${folderName}`);

  logArchive(lastBranch, archiveFolder);
  await mkdir(archiveFolder, { recursive: true });
  await writeAtomic(resolve(archiveFolder, "prd.json"), prdBuf);
  if (progressBuf) {
    await writeAtomic(resolve(archiveFolder, "progress.txt"), progressBuf);
  }

  // Reset progress log + clear stale state files for the new branch.
  await writeAtomic(
    PATHS.progress,
    `# Harness Progress Log\nStarted: ${new Date().toString()}\n---\n`,
  );
  for (const p of [PATHS.state, PATHS.events, PATHS.currentTask]) {
    if (await fileExists(p)) {
      try {
        await Bun.write(p, "");
      } catch {}
    }
  }
}

export async function trackBranch(config: HarnessConfig): Promise<void> {
  const currentBranch = await readJsonField(config.prdPath, "branchName");
  if (currentBranch) {
    await writeAtomic(PATHS.lastBranch, currentBranch);
  }
}

export async function initProgress(config: HarnessConfig): Promise<void> {
  if (await fileExists(PATHS.progress)) return;
  await writeAtomic(
    PATHS.progress,
    `# Harness Progress Log\nStarted: ${new Date().toString()}\n---\n`,
  );
}
