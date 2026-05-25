import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { die } from "../args.ts";
import { stripJsonc } from "../config.ts";

// `marmite dashboard [path] [--port <n>] [--host <h>] [--no-open]`
//
// Spins up a small Bun HTTP server that serves an HTML dashboard backed by
// .marmite/events.jsonl, with story metadata from sibling .marmite/prd.json
// and .marmite/progress.json. The page polls /api/dashboard, which re-reads
// all three files on every request so the view stays current while a run is
// in flight.

interface Args {
  path: string;
  port: number;
  host: string;
  open: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(3);
  let path: string | undefined;
  let port = 4321;
  let host = "127.0.0.1";
  let open = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-h" || a === "--help") {
      console.log(`Usage: marmite dashboard [path] [--port <n>] [--host <h>] [--no-open]

Serves a live HTML dashboard over a .marmite/events.jsonl file. Defaults to
./.marmite/events.jsonl on http://127.0.0.1:4321. Also reads prd.json and
progress.json from the same directory when present.

Options:
  --port <n>   Port to listen on (default: 4321)
  --host <h>   Host to bind (default: 127.0.0.1)
  --no-open    Do not open the dashboard in the browser
  -h, --help   Show this help`);
      process.exit(0);
    }
    if (a === "--port") {
      const v = args[++i];
      const n = parseInt(v ?? "", 10);
      if (!v || isNaN(n) || n < 1 || n > 65535) die(`--port requires a port in 1..65535, got '${v ?? ""}'`);
      port = n;
      continue;
    }
    if (a === "--host") {
      const v = args[++i];
      if (!v) die("--host requires a value");
      host = v;
      continue;
    }
    if (a === "--no-open") { open = false; continue; }
    if (a.startsWith("-")) die(`unknown flag: ${a}`);
    if (path !== undefined) die(`unexpected positional arg: ${a}`);
    path = a;
  }
  return {
    path: resolve(path ?? resolve(process.cwd(), ".marmite", "events.jsonl")),
    port,
    host,
    open,
  };
}

interface Event {
  ts?: string;
  kind: string;
  runId?: string;
  iteration?: number;
  storyId?: string;
  phase?: string;
  attempt?: number;
  durationMs?: number;
  costUsd?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  numTurns?: number;
  exitCode?: number;
  passed?: boolean;
  title?: string;
  qaPass?: number;
  qaFail?: number;
  [k: string]: unknown;
}

function readEvents(path: string): Event[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf-8");
  const out: Event[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && typeof obj.kind === "string") {
        out.push(obj as Event);
      }
    } catch {
      // Tolerate partial writes — the file is being appended live.
    }
  }
  return out;
}

interface PrdStory {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  priority?: number;
  passes?: boolean;
  epic?: string;
  dependencies?: string[];
}

interface PrdFile {
  project?: string;
  description?: string;
  userStories: PrdStory[];
}

function readPrd(path: string): PrdFile | null {
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(readFileSync(path, "utf-8"));
    if (!obj || !Array.isArray(obj.userStories)) return null;
    return obj as PrdFile;
  } catch {
    return null;
  }
}

interface Pattern {
  name: string;
  description: string;
  addedInStory?: string;
}

interface TimelineStoryEntry {
  kind: "story";
  storyId: string;
  ts: string;
  verdict?: string;
  summary?: string;
  commitShas?: string[];
}

interface TimelineJanitorEntry {
  kind: "janitor";
  id: string;
  ts: string;
  passes?: boolean;
  title?: string;
  appliedFixes?: string[];
  commitShas?: string[];
}

type TimelineEntry = TimelineStoryEntry | TimelineJanitorEntry;

interface ProgressFile {
  patterns: Pattern[];
  timeline: TimelineEntry[];
}

function readProgress(path: string): ProgressFile | null {
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(readFileSync(path, "utf-8"));
    if (!obj || typeof obj !== "object") return null;
    return {
      patterns: Array.isArray(obj.patterns) ? obj.patterns : [],
      timeline: Array.isArray(obj.timeline) ? obj.timeline : [],
    };
  } catch {
    return null;
  }
}

interface PhaseRollup {
  phase: string;
  attempts: number;
  durationMs: number;
  costUsd: number;
  turns: number;
  qaPass: number;
  qaFail: number;
  passed: boolean | null;
}

interface FileStat {
  file: string;
  added: number;
  deleted: number;
  binary: boolean;
}

interface CommitStat {
  sha: string;
  subject: string;
  files: FileStat[];
  totalAdded: number;
  totalDeleted: number;
}

interface StoryRollup {
  storyId: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  epic?: string;
  priority: number;
  passed: boolean | null;
  inPrd: boolean;
  attempts: number;
  totalCostUsd: number;
  phases: PhaseRollup[];
  summary?: string;
  commitShas?: string[];
  commitStats?: CommitStat[];
  completedAt?: string;
  verdict?: string;
  appliedFixes?: string[];
  isJanitor?: boolean;
}

interface MarmiteConfigInfo {
  workflow: string | null;
  baseBranch: string | null;
  app: string | null;
  models: {
    default?: string;
    builder?: string;
    verifier?: string;
    orchestrator?: string;
  };
  budget: {
    perStory?: number;
    total?: number;
  };
  maxIterations: number | null;
  sensors: { name: string; type: string }[];
  janitor: {
    thresholds?: { drift?: number; debt?: number };
    maxFindingsPerRun?: number;
  } | null;
  workflowConfig: Record<string, unknown> | null;
}

function readMarmiteConfig(path: string): MarmiteConfigInfo | null {
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(stripJsonc(readFileSync(path, "utf-8"))) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") return null;
    const models = (obj.models as Record<string, string> | undefined) ?? {};
    const budget = (obj.budget as Record<string, number> | undefined) ?? {};
    const sensorsRaw = Array.isArray(obj.sensors) ? (obj.sensors as Record<string, unknown>[]) : [];
    const sensors = sensorsRaw
      .filter((s) => typeof s?.name === "string" && typeof s?.type === "string")
      .map((s) => ({ name: s.name as string, type: s.type as string }));
    const janitorRaw = obj.janitor as Record<string, unknown> | undefined;
    return {
      workflow: typeof obj.workflow === "string" ? obj.workflow : null,
      baseBranch: typeof obj.baseBranch === "string" ? obj.baseBranch : null,
      app: typeof obj.app === "string" ? obj.app : null,
      models: {
        default: models.default,
        builder: models.builder,
        verifier: models.verifier,
        orchestrator: models.orchestrator,
      },
      budget: {
        perStory: typeof budget.perStory === "number" ? budget.perStory : undefined,
        total: typeof budget.total === "number" ? budget.total : undefined,
      },
      maxIterations: typeof obj.maxIterations === "number" ? obj.maxIterations : null,
      sensors,
      janitor: janitorRaw
        ? {
            thresholds: janitorRaw.thresholds as { drift?: number; debt?: number } | undefined,
            maxFindingsPerRun:
              typeof janitorRaw.maxFindingsPerRun === "number"
                ? (janitorRaw.maxFindingsPerRun as number)
                : undefined,
          }
        : null,
      workflowConfig:
        obj.workflowConfig && typeof obj.workflowConfig === "object"
          ? (obj.workflowConfig as Record<string, unknown>)
          : null,
    };
  } catch {
    return null;
  }
}

// Parse a git remote URL into an `owner/repo` slug. Returns null for non-GitHub
// remotes or unparsable strings — the dashboard then falls back to plain text.
function parseGitHubSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  // https://github.com/owner/repo  or  git@github.com:owner/repo
  const m =
    trimmed.match(/github\.com[:/]([^/]+)\/([^/]+)$/) ??
    trimmed.match(/^([^/]+)\/([^/]+)$/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

function readGitHubSlug(projectRoot: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "-C", projectRoot, "remote", "get-url", "origin"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    const url = new TextDecoder().decode(proc.stdout).trim();
    if (!url) return null;
    return parseGitHubSlug(url);
  } catch {
    return null;
  }
}

// Commit metadata is immutable, so we never need to re-shell once we've
// asked git for a given SHA. The dashboard polls every 3s — without this
// cache, even a handful of completed stories would re-invoke git per tick.
const commitStatCache = new Map<string, CommitStat | null>();

function getCommitStat(projectRoot: string, sha: string): CommitStat | null {
  if (commitStatCache.has(sha)) return commitStatCache.get(sha) ?? null;
  try {
    const proc = Bun.spawnSync(
      ["git", "-C", projectRoot, "show", "--numstat", "--format=%s", sha],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      commitStatCache.set(sha, null);
      return null;
    }
    const text = new TextDecoder().decode(proc.stdout).replace(/\r/g, "");
    const lines = text.split("\n");
    // `--format=%s` prints the subject as the first non-empty line, followed
    // by a blank, then the numstat rows.
    let subject = "";
    let idx = 0;
    while (idx < lines.length && lines[idx]!.trim() === "") idx++;
    if (idx < lines.length) { subject = lines[idx]!; idx++; }
    const files: FileStat[] = [];
    let totalAdded = 0;
    let totalDeleted = 0;
    for (; idx < lines.length; idx++) {
      const line = lines[idx]!;
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const aRaw = parts[0]!;
      const dRaw = parts[1]!;
      const file = parts.slice(2).join("\t");
      // Binary files show `-\t-` in numstat; surface those distinctly.
      const binary = aRaw === "-" && dRaw === "-";
      const added = binary ? 0 : parseInt(aRaw, 10) || 0;
      const deleted = binary ? 0 : parseInt(dRaw, 10) || 0;
      files.push({ file, added, deleted, binary });
      totalAdded += added;
      totalDeleted += deleted;
    }
    const stat: CommitStat = { sha, subject, files, totalAdded, totalDeleted };
    commitStatCache.set(sha, stat);
    return stat;
  } catch {
    commitStatCache.set(sha, null);
    return null;
  }
}

interface QaResult {
  criterion?: string;
  passed?: boolean;
}

interface HaltInfo {
  kind?: string;
  prNum?: number;
  branch?: string;
  baseBranch?: string;
  reason?: string;
}

interface CurrentTaskFile {
  storyId?: string;
  storyTitle?: string;
  kind?: string;
  priority?: number;
  description?: string;
  acceptanceCriteria?: string[];
  notes?: string;
  guidance?: string;
  reasoning?: string;
  sensorSummary?: string;
  ranSensors?: string[];
  halt?: HaltInfo;
  verdict?: string;
  summary?: string;
  qaResults?: QaResult[];
  verifiedAt?: string;
}

function readCurrentTask(path: string): CurrentTaskFile | null {
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(readFileSync(path, "utf-8"));
    if (!obj || typeof obj !== "object") return null;
    return obj as CurrentTaskFile;
  } catch {
    return null;
  }
}

interface CurrentTask {
  storyId: string;
  title: string;
  kind: "story" | "janitor" | "pr-review" | "unknown";
  phase: string | null;
  attempt: number | null;
  iteration: number | null;
  phaseStartedAt: string | null;
  phaseDurationMs: number | null;
  isPhaseActive: boolean;
  priority?: number;
  description?: string;
  acceptanceCriteria?: string[];
  notes?: string;
  guidance?: string;
  reasoning?: string;
  sensorSummary?: string;
  ranSensors?: string[];
  halt?: HaltInfo;
  verdict?: string;
  verifierSummary?: string;
  qaResults?: QaResult[];
  verifiedAt?: string;
  epic?: string;
  epicLabel?: string;
  prNum?: number;
  prUrl?: string;
}

function deriveCurrentTask(
  events: Event[],
  currentRunId: string | null,
  ct: CurrentTaskFile | null,
): CurrentTask | null {
  // No active story once the run wraps up.
  const scoped = currentRunId ? events.filter((e) => e.runId === currentRunId) : events;
  if (!scoped.length) return null;
  const last = scoped[scoped.length - 1]!;
  if (last.kind === "run_end" || last.kind === "run_done" || last.kind === "run_abort") return null;

  // Walk back to find the most recent phase_start — that's the active phase.
  let activePhaseStart: Event | null = null;
  let activePhaseEnded = false;
  for (let i = scoped.length - 1; i >= 0; i--) {
    const e = scoped[i]!;
    if (e.kind === "phase_end") activePhaseEnded = true; // any later phase_end wins
    if (e.kind === "phase_start") { activePhaseStart = e; break; }
  }
  // Reset the "ended" flag if it was for a different (older) phase. Easier:
  // re-scan forward from the phase_start to see if a matching phase_end follows.
  let isPhaseActive = false;
  let phaseStartedAt: string | null = null;
  let phase: string | null = null;
  let attempt: number | null = null;
  if (activePhaseStart) {
    phase = typeof activePhaseStart.phase === "string" ? activePhaseStart.phase : null;
    attempt = typeof activePhaseStart.attempt === "number" ? activePhaseStart.attempt : null;
    phaseStartedAt = typeof activePhaseStart.ts === "string" ? activePhaseStart.ts : null;
    const startIdx = scoped.indexOf(activePhaseStart);
    isPhaseActive = true;
    for (let j = startIdx + 1; j < scoped.length; j++) {
      const e = scoped[j]!;
      if (e.kind === "phase_end" && (typeof e.phase !== "string" || e.phase === phase)) {
        isPhaseActive = false;
        break;
      }
    }
    void activePhaseEnded;
  }

  // storyId: prefer phase_start.storyId, else nearest preceding event with storyId.
  let storyId: string | null = null;
  if (activePhaseStart && typeof activePhaseStart.storyId === "string") {
    storyId = activePhaseStart.storyId;
  } else {
    const startIdx = activePhaseStart ? scoped.indexOf(activePhaseStart) : scoped.length;
    for (let k = startIdx; k >= 0; k--) {
      const e = scoped[k]!;
      if (typeof e?.storyId === "string") { storyId = e.storyId; break; }
    }
  }
  if (!storyId && ct?.storyId) storyId = ct.storyId;
  if (!storyId) return null;

  // Iteration: latest seen in scope.
  let iteration: number | null = null;
  for (let i = scoped.length - 1; i >= 0; i--) {
    const it = scoped[i]!.iteration;
    if (typeof it === "number") { iteration = it; break; }
  }

  // current-task.json is keyed to the same storyId only if the orchestrator
  // already wrote it. Otherwise fall back to whatever we have in events.
  const titleFromCt = ct && ct.storyId === storyId ? ct.storyTitle : undefined;
  let title = titleFromCt ?? storyId;
  if (!titleFromCt) {
    // Find the title in story_selected events.
    for (let i = scoped.length - 1; i >= 0; i--) {
      const e = scoped[i]!;
      if (e.kind === "story_selected" && e.storyId === storyId && typeof e.title === "string") {
        title = e.title;
        break;
      }
    }
  }

  const ctKind = ct && ct.storyId === storyId ? ct.kind : undefined;
  const kind: CurrentTask["kind"] =
    ctKind === "janitor" || ctKind === "story" || ctKind === "pr-review"
      ? ctKind
      : storyId.toUpperCase().startsWith("JANITOR") ? "janitor" : "story";

  const phaseDurationMs = phaseStartedAt
    ? Math.max(0, Date.now() - Date.parse(phaseStartedAt))
    : null;

  const ctMatches = ct && ct.storyId === storyId;
  return {
    storyId,
    title,
    kind,
    phase,
    attempt,
    iteration,
    phaseStartedAt,
    phaseDurationMs,
    isPhaseActive,
    priority: ctMatches ? ct.priority : undefined,
    description: ctMatches ? ct.description : undefined,
    acceptanceCriteria: ctMatches ? ct.acceptanceCriteria : undefined,
    notes: ctMatches ? ct.notes : undefined,
    guidance: ctMatches ? ct.guidance : undefined,
    reasoning: ctMatches ? ct.reasoning : undefined,
    sensorSummary: ctMatches ? ct.sensorSummary : undefined,
    ranSensors: ctMatches ? ct.ranSensors : undefined,
    halt: ctMatches ? ct.halt : undefined,
    verdict: ctMatches ? ct.verdict : undefined,
    verifierSummary: ctMatches ? ct.summary : undefined,
    qaResults: ctMatches ? ct.qaResults : undefined,
    verifiedAt: ctMatches ? ct.verifiedAt : undefined,
  };
}

interface EpicGroup {
  slug: string;
  label: string;
  storiesTotal: number;
  storiesPassed: number;
  stories: StoryRollup[];
}

interface NextUpInfo {
  storyId: string;
  title: string;
  epic?: string;
}

interface HaltStatus {
  reason: string;
  iteration: number | null;
  prNum: number | null;
  prUrl: string | null;
  branch: string | null;
  at: string | null;
  haltedStoryId: string | null;
  nextUp: NextUpInfo | null;
}

interface Dashboard {
  source: string;
  prdSource: string | null;
  progressSource: string | null;
  project: string | null;
  runId: string | null;
  // The latest run's `mode` from its `run_start`. Older event logs predate
  // the field; treated as "cook" downstream. "maintenance" reflects a one-shot
  // `marmite refactor` pass and is surfaced as a badge in the header.
  runMode: "cook" | "maintenance" | null;
  startedAt: string | null;
  endedAt: string | null;
  status: "in_progress" | "completed" | "failed" | "halted" | "unknown";
  totalCostUsd: number;
  durationMs: number | null;
  storiesTotal: number;
  storiesPassed: number;
  stories: StoryRollup[];
  epics: EpicGroup[];
  currentTask: CurrentTask | null;
  patterns: Pattern[];
  totalEvents: number;
  iteration: number | null;
  config: MarmiteConfigInfo | null;
  configSource: string | null;
  githubSlug: string | null;
  halt: HaltStatus | null;
  usageLimit: UsageLimitStatus;
  sensorHealth: SensorHealth;
}

interface UsageLimitActive {
  // ISO timestamp when the harness logged the pause start.
  startedAt: string | null;
  // Wait window in ms the harness committed to before resuming.
  waitMs: number;
  // ISO timestamp the harness expects to resume at (startedAt + waitMs).
  expectedEndsAt: string | null;
  // Anthropic-provided reset (unix seconds), when known.
  resumeAt: number | null;
  phase: string;
  agentLabel: string;
  consecutive: number;
}

interface UsageLimitStatus {
  // Total number of pauses across every run in the events file.
  count: number;
  // Cumulative wait time across every completed pause (ms).
  totalWaitedMs: number;
  // Set when the current run is mid-pause (start without matching resume).
  active: UsageLimitActive | null;
}

interface SensorHealthEntry {
  sensor: string;
  sensorType: string | null;
  latestFindingCount: number | null;
  latestThreshold: number | null;
  latestIteration: number | null;
  latestTs: string | null;
  // Per-iteration findingCount points (oldest → newest, capped) for the sparkline.
  history: { iteration: number; findingCount: number }[];
  // Janitor trips this sensor has caused — drawn from janitor_triggered events.
  janitorTrips: number;
  // True when the sensor appears in marmite.json (even if no result events yet).
  configured: boolean;
}

interface SensorHealth {
  entries: SensorHealthEntry[];
  janitor: {
    triggered: number;
    applied: number;
    deferred: number;
  };
}

function pickLatestRun(events: Event[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "run_start" && typeof e.runId === "string") return e.runId;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (typeof e.runId === "string") return e.runId;
  }
  return null;
}

function buildDashboard(
  events: Event[],
  prd: PrdFile | null,
  progress: ProgressFile | null,
  currentTaskFile: CurrentTaskFile | null,
  config: MarmiteConfigInfo | null,
  githubSlug: string | null,
  projectRoot: string,
  source: string,
  prdSource: string | null,
  progressSource: string | null,
  configSource: string | null,
): Dashboard {
  const runId = pickLatestRun(events);

  // Header metadata reflects the latest run only — the user wants to see
  // status of the run currently in flight.
  const currentRunEvents = runId ? events.filter((e) => e.runId === runId) : events;
  const runStart = currentRunEvents.find((e) => e.kind === "run_start");
  const runMode: "cook" | "maintenance" | null =
    runStart && (runStart as any).mode === "maintenance" ? "maintenance" : runStart ? "cook" : null;
  const runEnd = [...currentRunEvents].reverse().find((e) => e.kind === "run_end");
  // `run_halt` is emitted by the orchestrator before `process.exit(0)`, so
  // there's no `run_end` after it. Surface this state distinctly.
  const runHalt = [...currentRunEvents].reverse().find((e) => e.kind === "run_halt");
  // A run_halt is "current" only if no later run_start/run_end has happened
  // (run_start would mean we resumed; run_end would override the halt anyway).
  const haltIsCurrent = runHalt && !runEnd;
  // current-task.json's halt block is the orchestrator's authoritative "next
  // action" record. When it carries `awaiting_pr_review` we treat the harness
  // as halted even if the latest run_halt event was overwritten by a later
  // run_start (e.g. a follow-up `marmite cook` invocation that didn't yet
  // produce its own run_halt). Without this, stale phase_start events from a
  // previous build would make the dashboard claim a story is in progress
  // while the harness is actually waiting on PR review.
  const fileHalt = currentTaskFile?.halt?.kind === "awaiting_pr_review"
    ? currentTaskFile.halt
    : null;

  let halt: HaltStatus | null = null;
  if (haltIsCurrent && runHalt) {
    const prNum = typeof runHalt.prNum === "number" ? runHalt.prNum : null;
    const branch = typeof runHalt.branch === "string" ? runHalt.branch : null;
    const prUrl = prNum && githubSlug ? `https://github.com/${githubSlug}/pull/${prNum}` : null;

    // The story that was being worked on when the run halted — preferred from
    // the halt event itself, then current-task.json, then the most recent
    // storyId we've seen in the run.
    let haltedStoryId: string | null =
      typeof runHalt.storyId === "string" ? runHalt.storyId : null;
    if (!haltedStoryId && currentTaskFile?.storyId) haltedStoryId = currentTaskFile.storyId;
    if (!haltedStoryId) {
      for (let i = currentRunEvents.length - 1; i >= 0; i--) {
        const e = currentRunEvents[i]!;
        if (typeof e.storyId === "string") { haltedStoryId = e.storyId; break; }
      }
    }

    // Once the PR merges and the run resumes, the orchestrator will mark the
    // halted story as passed and pick the next unpassed PRD story in priority
    // order. Surface that as "Next up" so the user knows what's queued.
    let nextUp: NextUpInfo | null = null;
    if (prd) {
      const sorted = [...prd.userStories].sort((a, b) => {
        const ap = typeof a.priority === "number" ? a.priority : Number.MAX_SAFE_INTEGER;
        const bp = typeof b.priority === "number" ? b.priority : Number.MAX_SAFE_INTEGER;
        if (ap !== bp) return ap - bp;
        return a.id.localeCompare(b.id, undefined, { numeric: true });
      });
      const next = sorted.find(
        (s) => s.passes !== true && s.id !== haltedStoryId,
      );
      if (next) nextUp = { storyId: next.id, title: next.title || next.id, epic: next.epic };
    }

    halt = {
      reason: typeof runHalt.reason === "string" ? runHalt.reason : "halted",
      iteration: typeof runHalt.iteration === "number" ? runHalt.iteration : null,
      prNum,
      prUrl,
      branch,
      at: typeof runHalt.ts === "string" ? runHalt.ts : null,
      haltedStoryId,
      nextUp,
    };
  } else if (fileHalt && !runEnd) {
    // Fallback: no live run_halt event in the current run, but current-task.json
    // still declares an awaiting_pr_review halt. Trust the file.
    const prNum = typeof fileHalt.prNum === "number" ? fileHalt.prNum : null;
    const branch = typeof fileHalt.branch === "string" ? fileHalt.branch : null;
    const prUrl = prNum && githubSlug ? `https://github.com/${githubSlug}/pull/${prNum}` : null;

    const haltedStoryId = currentTaskFile?.storyId ?? null;

    let nextUp: NextUpInfo | null = null;
    if (prd) {
      const sorted = [...prd.userStories].sort((a, b) => {
        const ap = typeof a.priority === "number" ? a.priority : Number.MAX_SAFE_INTEGER;
        const bp = typeof b.priority === "number" ? b.priority : Number.MAX_SAFE_INTEGER;
        if (ap !== bp) return ap - bp;
        return a.id.localeCompare(b.id, undefined, { numeric: true });
      });
      const next = sorted.find((s) => s.passes !== true && s.id !== haltedStoryId);
      if (next) nextUp = { storyId: next.id, title: next.title || next.id, epic: next.epic };
    }

    halt = {
      reason: "awaiting_pr_review",
      iteration: null,
      prNum,
      prUrl,
      branch,
      at: null,
      haltedStoryId,
      nextUp,
    };
  }

  const endedAt = typeof runEnd?.ts === "string" ? runEnd.ts : null;

  const status: Dashboard["status"] = runEnd
    ? (runEnd.passed === false || (typeof runEnd.exitCode === "number" && runEnd.exitCode !== 0)
        ? "failed"
        : "completed")
    : halt
      ? "halted"
      : runStart
        ? "in_progress"
        : "unknown";

  // "Run Duration" reflects cumulative active time across every `marmite run`
  // invocation in the events log — a halt+resume cycle splits the work over
  // several runIds but the user thinks of it as one project run. We sum each
  // run's (start → end) window: end is run_end/run_halt when present, Date.now()
  // for the currently in-flight run, and otherwise the last event we saw for
  // that runId (so a crashed run doesn't tick forever).
  interface RunWindow { start: number; end: number | null; lastTs: number }
  const runWindows = new Map<string, RunWindow>();
  for (const e of events) {
    if (typeof e.ts !== "string" || typeof e.runId !== "string") continue;
    const ts = Date.parse(e.ts);
    if (isNaN(ts)) continue;
    let w = runWindows.get(e.runId);
    if (e.kind === "run_start") {
      if (!w) { w = { start: ts, end: null, lastTs: ts }; runWindows.set(e.runId, w); }
      continue;
    }
    if (!w) continue;
    w.lastTs = ts;
    if (e.kind === "run_end" || e.kind === "run_halt") w.end = ts;
  }

  let startedAt: string | null = null;
  let durationMs: number | null = null;
  if (runWindows.size) {
    let total = 0;
    let earliest = Infinity;
    for (const [id, w] of runWindows) {
      if (w.start < earliest) earliest = w.start;
      let end: number;
      if (w.end != null) end = w.end;
      else if (id === runId && status === "in_progress") end = Date.now();
      else end = w.lastTs;
      total += Math.max(0, end - w.start);
    }
    durationMs = total;
    if (earliest !== Infinity) startedAt = new Date(earliest).toISOString();
  } else if (runStart && typeof runStart.ts === "string") {
    startedAt = runStart.ts;
  }

  let iteration: number | null = null;
  for (let i = currentRunEvents.length - 1; i >= 0; i--) {
    const it = currentRunEvents[i]!.iteration;
    if (typeof it === "number") { iteration = it; break; }
  }

  // Story rollups aggregate across ALL runs — a fresh run shouldn't hide
  // work from earlier runs of the same project.
  const storyMap = new Map<string, StoryRollup>();

  // Seed with the PRD so every story shows up in the pipeline even before
  // it has any events.
  const prdOrder = new Map<string, number>();
  if (prd) {
    prd.userStories.forEach((s, idx) => {
      const priority = typeof s.priority === "number" ? s.priority : idx + 1;
      prdOrder.set(s.id, priority);
      storyMap.set(s.id, {
        storyId: s.id,
        title: s.title || s.id,
        description: s.description,
        acceptanceCriteria: s.acceptanceCriteria,
        epic: s.epic,
        priority,
        passed: s.passes === true ? true : null,
        inPrd: true,
        attempts: 0,
        totalCostUsd: 0,
        phases: [],
      });
    });
  }

  const getStory = (id: string, isJanitor = false): StoryRollup => {
    let s = storyMap.get(id);
    if (!s) {
      s = {
        storyId: id,
        title: id,
        priority: Number.MAX_SAFE_INTEGER,
        passed: null,
        inPrd: false,
        attempts: 0,
        totalCostUsd: 0,
        phases: [],
        isJanitor: isJanitor || id.toUpperCase().startsWith("JANITOR"),
      };
      storyMap.set(id, s);
    }
    if (isJanitor) s.isJanitor = true;
    return s;
  };

  // Phase rollup keyed by `${storyId}::${phase}` — collapses retries within
  // a phase across all runs.
  const phaseMap = new Map<string, PhaseRollup>();
  const getPhase = (storyId: string, phase: string): PhaseRollup => {
    const key = `${storyId}::${phase}`;
    let p = phaseMap.get(key);
    if (!p) {
      p = { phase, attempts: 0, durationMs: 0, costUsd: 0, turns: 0, qaPass: 0, qaFail: 0, passed: null };
      phaseMap.set(key, p);
      getStory(storyId).phases.push(p);
    }
    return p;
  };

  let totalCostUsd = 0;

  for (const e of events) {
    const storyId = typeof e.storyId === "string" ? e.storyId : null;
    // `story_selected` carries the human-readable title for janitors and any
    // story that isn't in the PRD (e.g. an old PRD on disk).
    if (e.kind === "story_selected" && storyId) {
      const s = getStory(storyId);
      if (typeof e.title === "string" && !s.inPrd) s.title = e.title;
    }
    // `story_outcome` is the canonical pass/fail signal — emitted by
    // finalizeStoryOutcome after the verifier and (if needed) fix loop settle.
    if (e.kind === "story_outcome" && storyId) {
      const s = getStory(storyId);
      // Don't downgrade a confirmed pass — janitor retries within the same
      // run can emit a fail outcome before a later pass, and PRD-confirmed
      // passes from earlier runs should stick.
      if (typeof e.passed === "boolean" && s.passed !== true) s.passed = e.passed;
    }
    // `verification_verdict` is emitted before story_outcome; treat a "pass"
    // verdict as an early authoritative signal so the card updates even if a
    // story_outcome write was interrupted mid-flush.
    if (e.kind === "verification_verdict" && storyId) {
      const s = getStory(storyId);
      const verdict = typeof e.verdict === "string" ? e.verdict : null;
      if (verdict === "pass" && s.passed !== true) s.passed = true;
      // fail_retry is transient — never downgrade on it. fail_abort only
      // means failed if a later attempt didn't pass; story_outcome will
      // give the final word.
    }
    if (e.kind === "session_result") {
      const phase = typeof e.phase === "string" ? e.phase : "unknown";
      const targetStory = storyId ?? "(run-level)";
      const p = getPhase(targetStory, phase);
      p.attempts += 1;
      p.durationMs += typeof e.durationMs === "number" ? e.durationMs : 0;
      p.costUsd += typeof e.costUsd === "number" ? e.costUsd : 0;
      p.turns += typeof e.numTurns === "number" ? e.numTurns : 0;
      if (typeof e.qaPass === "number") p.qaPass += e.qaPass;
      if (typeof e.qaFail === "number") p.qaFail += e.qaFail;
      if (typeof e.passed === "boolean") p.passed = e.passed;
      const story = getStory(targetStory);
      story.attempts = Math.max(story.attempts, typeof e.attempt === "number" ? e.attempt : 1);
      if (typeof e.costUsd === "number") {
        totalCostUsd += e.costUsd;
        if (storyId) story.totalCostUsd += e.costUsd;
      }
    }
  }

  // Layer in progress.json — adds rich summaries, commits, janitor entries
  // not in the PRD, and authoritative pass markers for janitors.
  if (progress) {
    let janitorPriority = 10_000;
    for (const entry of progress.timeline) {
      if (entry.kind === "story") {
        const s = getStory(entry.storyId);
        s.summary = entry.summary;
        s.commitShas = entry.commitShas;
        s.completedAt = entry.ts;
        s.verdict = entry.verdict;
        if (entry.verdict === "pass" && s.passed !== true) s.passed = true;
        if (entry.verdict === "fail_abort" && s.passed === null) s.passed = false;
      } else if (entry.kind === "janitor") {
        const s = getStory(entry.id, true);
        if (entry.title) s.title = entry.title;
        s.commitShas = entry.commitShas;
        s.appliedFixes = entry.appliedFixes;
        s.completedAt = entry.ts;
        // `passes: false` on a janitor entry is the initial placeholder the
        // harness writes when the janitor is queued; only `true` flips passed.
        // Failure is signaled via story_outcome events, not progress.json.
        if (entry.passes === true && s.passed !== true) s.passed = true;
        if (s.priority === Number.MAX_SAFE_INTEGER) s.priority = janitorPriority++;
      }
    }
  }

  // PRD `passes` is the authoritative count for "stories completed" so the
  // counter reflects total project progress, not just the current run.
  const prdStoriesTotal = prd ? prd.userStories.length : storyMap.size;
  const prdStoriesPassed = prd
    ? prd.userStories.filter((s) => s.passes === true).length
    : [...storyMap.values()].filter((s) => s.passed === true).length;

  // Sort: PRD order first (by priority), then janitor entries by their
  // completion timestamp, then anything else.
  const stories = [...storyMap.values()].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.storyId.localeCompare(b.storyId, undefined, { numeric: true });
  });

  // Resolve git diffstats for every commit referenced by a story. Cached by
  // sha so this is a one-shot cost per commit even across dashboard ticks.
  for (const s of stories) {
    if (!s.commitShas || !s.commitShas.length) continue;
    const stats: CommitStat[] = [];
    for (const sha of s.commitShas) {
      const cs = getCommitStat(projectRoot, sha);
      if (cs) stats.push(cs);
    }
    if (stats.length) s.commitStats = stats;
  }

  // Group by epic in PRD order. Stories without an epic (janitors, ad-hoc)
  // land in a synthetic "maintenance" bucket so they stay grouped at the end.
  const epicMap = new Map<string, EpicGroup>();
  const epicSeen: string[] = [];
  const epicLabel = (slug: string): string =>
    slug.split(/[-_]+/).map((w) => w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)).join(" ");
  for (const s of stories) {
    const slug = s.epic ?? (s.isJanitor ? "__maintenance" : "__other");
    let group = epicMap.get(slug);
    if (!group) {
      group = {
        slug,
        label: slug === "__maintenance" ? "Maintenance" : slug === "__other" ? "Other" : epicLabel(slug),
        storiesTotal: 0,
        storiesPassed: 0,
        stories: [],
      };
      epicMap.set(slug, group);
      epicSeen.push(slug);
    }
    group.stories.push(s);
    group.storiesTotal++;
    if (s.passed === true) group.storiesPassed++;
  }
  // Real epics first (in the order they appeared in the PRD), then the
  // synthetic buckets at the end so the page reads top-down through the work.
  const epics = epicSeen
    .map((slug) => epicMap.get(slug)!)
    .sort((a, b) => {
      const aSynth = a.slug.startsWith("__") ? 1 : 0;
      const bSynth = b.slug.startsWith("__") ? 1 : 0;
      if (aSynth !== bSynth) return aSynth - bSynth;
      return 0;
    });

  return {
    source,
    prdSource,
    progressSource,
    project: prd?.project ?? null,
    runId,
    runMode,
    startedAt,
    endedAt,
    status,
    totalCostUsd,
    durationMs,
    storiesTotal: prdStoriesTotal,
    storiesPassed: prdStoriesPassed,
    stories,
    epics,
    // When the run is halted we surface the halted story inside the halt
    // banner instead — showing a spinning "Story in progress" card would be
    // misleading because nothing is actually running.
    currentTask:
      status === "in_progress"
        ? (() => {
            const ct = deriveCurrentTask(events, runId, currentTaskFile);
            if (ct) {
              const story = storyMap.get(ct.storyId);
              if (story?.epic) {
                ct.epic = story.epic;
                ct.epicLabel = epicMap.get(story.epic)?.label ?? epicLabel(story.epic);
              }
              if (ct.kind === "pr-review" && ct.halt?.prNum) {
                ct.prNum = ct.halt.prNum;
                if (githubSlug) {
                  ct.prUrl = `https://github.com/${githubSlug}/pull/${ct.halt.prNum}`;
                }
              }
            }
            return ct;
          })()
        : null,
    patterns: progress?.patterns ?? [],
    totalEvents: events.length,
    iteration,
    config,
    configSource,
    githubSlug,
    halt,
    usageLimit: computeUsageLimitStatus(events, runId),
    sensorHealth: computeSensorHealth(events, config),
  };
}

// Walks the events log to build a per-sensor health snapshot. `sensor_result`
// events carry the post-filter finding count + threshold the orchestrator
// observed; `janitor_triggered` events surface threshold trips for the cadence
// summary. Configured sensors with no result events yet are included so the
// panel shows the full surface area, not just sensors that have already run.
function computeSensorHealth(
  events: Event[],
  config: MarmiteConfigInfo | null,
): SensorHealth {
  // Cap the per-sensor history to keep the payload small — the sparkline only
  // needs the recent trend, not full history.
  const HISTORY_CAP = 30;

  const bySensor = new Map<string, SensorHealthEntry>();
  const ensure = (name: string, sensorType: string | null): SensorHealthEntry => {
    let entry = bySensor.get(name);
    if (!entry) {
      entry = {
        sensor: name,
        sensorType,
        latestFindingCount: null,
        latestThreshold: null,
        latestIteration: null,
        latestTs: null,
        history: [],
        janitorTrips: 0,
        configured: false,
      };
      bySensor.set(name, entry);
    } else if (sensorType && !entry.sensorType) {
      entry.sensorType = sensorType;
    }
    return entry;
  };

  if (config?.sensors) {
    for (const s of config.sensors) {
      ensure(s.name, s.type).configured = true;
    }
  }

  let triggered = 0;
  let applied = 0;
  let deferred = 0;

  for (const e of events) {
    if (e.kind === "sensor_result") {
      const name = typeof e.sensor === "string" ? e.sensor : null;
      if (!name) continue;
      const type = typeof e.sensorType === "string" ? e.sensorType : null;
      const findingCount = typeof e.findingCount === "number" ? e.findingCount : null;
      if (findingCount == null) continue;
      const entry = ensure(name, type);
      entry.latestFindingCount = findingCount;
      if (typeof e.threshold === "number") entry.latestThreshold = e.threshold;
      else if (entry.latestThreshold == null) entry.latestThreshold = null;
      if (typeof e.iteration === "number") entry.latestIteration = e.iteration;
      if (typeof e.ts === "string") entry.latestTs = e.ts;
      const point = {
        iteration: typeof e.iteration === "number" ? e.iteration : entry.history.length + 1,
        findingCount,
      };
      // Replace any prior point for the same iteration so the trend stays one-
      // per-iteration even if the agent emits multiple times.
      const dupIdx = entry.history.findIndex((p) => p.iteration === point.iteration);
      if (dupIdx >= 0) entry.history[dupIdx] = point;
      else entry.history.push(point);
      if (entry.history.length > HISTORY_CAP) entry.history.shift();
    } else if (e.kind === "janitor_triggered") {
      triggered++;
      const triggers = Array.isArray(e.triggers) ? (e.triggers as { sensor?: string }[]) : [];
      for (const t of triggers) {
        if (typeof t?.sensor === "string") ensure(t.sensor, null).janitorTrips++;
      }
    } else if (e.kind === "janitor_fix_applied") {
      applied++;
    } else if (e.kind === "janitor_fix_deferred") {
      deferred++;
    }
  }

  // Fall back to config thresholds when the agent didn't supply one with the
  // sensor_result. Keeps the gauge usable even before prompts catch up.
  if (config?.janitor?.thresholds) {
    for (const entry of bySensor.values()) {
      if (entry.latestThreshold != null) continue;
      if (entry.sensorType === "debt" && config.janitor.thresholds.debt != null) {
        entry.latestThreshold = config.janitor.thresholds.debt;
      } else if (entry.sensorType === "drift" && config.janitor.thresholds.drift != null) {
        entry.latestThreshold = config.janitor.thresholds.drift;
      }
    }
  }

  const entries = [...bySensor.values()].sort((a, b) => {
    // Configured + with-data first; alphabetical within groups.
    const aActive = a.latestFindingCount != null;
    const bActive = b.latestFindingCount != null;
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    return a.sensor.localeCompare(b.sensor);
  });

  return { entries, janitor: { triggered, applied, deferred } };
}

// Walks the events log to count usage-limit pauses, sum elapsed wait time, and
// detect whether the *current* run is mid-pause (a start without a matching
// resume). Pairing is per-run so a stale start from an aborted earlier run
// can't be misread as the live one.
function computeUsageLimitStatus(events: Event[], currentRunId: string | null): UsageLimitStatus {
  let count = 0;
  let totalWaitedMs = 0;
  // runId -> last unmatched pause_start payload (we only need the most recent).
  const pending = new Map<string, Event>();
  for (const e of events) {
    if (e.kind === "usage_limit_pause") {
      count++;
      const rid = typeof e.runId === "string" ? e.runId : "";
      pending.set(rid, e);
    } else if (e.kind === "usage_limit_resume") {
      const rid = typeof e.runId === "string" ? e.runId : "";
      pending.delete(rid);
      if (typeof e.waitedMs === "number") totalWaitedMs += e.waitedMs;
    }
  }
  let active: UsageLimitActive | null = null;
  if (currentRunId) {
    const start = pending.get(currentRunId);
    if (start) {
      const waitMs = typeof start.waitMs === "number" ? start.waitMs : 0;
      const startedAt = typeof start.ts === "string" ? start.ts : null;
      const startedMs = startedAt ? Date.parse(startedAt) : NaN;
      const expectedEndsAt =
        !isNaN(startedMs) && waitMs > 0 ? new Date(startedMs + waitMs).toISOString() : null;
      active = {
        startedAt,
        waitMs,
        expectedEndsAt,
        resumeAt: typeof start.resumeAt === "number" ? start.resumeAt : null,
        phase: typeof start.phase === "string" ? start.phase : "unknown",
        agentLabel: typeof start.agentLabel === "string" ? start.agentLabel : "",
        consecutive: typeof start.consecutive === "number" ? start.consecutive : 1,
      };
    }
  }
  return { count, totalWaitedMs, active };
}

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Marmite Dashboard</title>
    <link rel="icon" id="favicon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%239ca3af'/%3E%3C/svg%3E">
    <style>
        :root {
            color-scheme: light dark;
            --bg-page: #f8fafc;
            --bg-surface: #ffffff;
            --bg-surface-2: #f9fafb;
            --bg-sidebar: #ffffff;
            --bg-input: #ffffff;
            --bg-muted: #f3f4f6;
            --bg-code: #f3f4f6;
            --text-primary: #1f2937;
            --text-secondary: #4b5563;
            --text-muted: #6b7280;
            --text-faint: #9ca3af;
            --border: #e5e7eb;
            --border-strong: #d1d5db;
            --accent: #4f46e5;
            --accent-2: #6366f1;
            --accent-soft: #eef2ff;
            --accent-on: #ffffff;
            --success: #16a34a;
            --success-soft: #f0fdf4;
            --success-strong: #15803d;
            --danger: #dc2626;
            --danger-soft: #fef2f2;
            --warning: #d97706;
            --warning-soft: #fefce8;
            --warning-strong: #92400e;
            --janitor: #7c3aed;
            --janitor-soft: #ede9fe;
            --shadow-sm: 0 1px 3px rgba(15,23,42,0.06);
            --shadow: 0 2px 8px rgba(15,23,42,0.06);
            --shadow-hover: 0 6px 18px rgba(15,23,42,0.10);
        }
        [data-theme="dark"], html[data-theme="dark"] {
            color-scheme: dark;
            --bg-page: #0b1220;
            --bg-surface: #111827;
            --bg-surface-2: #0f172a;
            --bg-sidebar: #0f172a;
            --bg-input: #0b1220;
            --bg-muted: #1f2937;
            --bg-code: #1f2937;
            --text-primary: #e5e7eb;
            --text-secondary: #cbd5e1;
            --text-muted: #94a3b8;
            --text-faint: #64748b;
            --border: #1f2937;
            --border-strong: #334155;
            --accent: #818cf8;
            --accent-2: #a5b4fc;
            --accent-soft: #1e1b4b;
            --accent-on: #0b1220;
            --success: #22c55e;
            --success-soft: #052e1f;
            --success-strong: #4ade80;
            --danger: #f87171;
            --danger-soft: #2a1014;
            --warning: #fbbf24;
            --warning-soft: #2a1f08;
            --warning-strong: #fcd34d;
            --janitor: #a78bfa;
            --janitor-soft: #1e1b4b;
            --shadow-sm: 0 1px 3px rgba(0,0,0,0.4);
            --shadow: 0 2px 8px rgba(0,0,0,0.5);
            --shadow-hover: 0 6px 18px rgba(0,0,0,0.6);
        }
        @media (prefers-color-scheme: dark) {
            :root:not([data-theme="light"]) {
                color-scheme: dark;
                --bg-page: #0b1220;
                --bg-surface: #111827;
                --bg-surface-2: #0f172a;
                --bg-sidebar: #0f172a;
                --bg-input: #0b1220;
                --bg-muted: #1f2937;
                --bg-code: #1f2937;
                --text-primary: #e5e7eb;
                --text-secondary: #cbd5e1;
                --text-muted: #94a3b8;
                --text-faint: #64748b;
                --border: #1f2937;
                --border-strong: #334155;
                --accent: #818cf8;
                --accent-2: #a5b4fc;
                --accent-soft: #1e1b4b;
                --accent-on: #0b1220;
                --success: #22c55e;
                --success-soft: #052e1f;
                --success-strong: #4ade80;
                --danger: #f87171;
                --danger-soft: #2a1014;
                --warning: #fbbf24;
                --warning-soft: #2a1f08;
                --warning-strong: #fcd34d;
                --janitor: #a78bfa;
                --janitor-soft: #1e1b4b;
                --shadow-sm: 0 1px 3px rgba(0,0,0,0.4);
                --shadow: 0 2px 8px rgba(0,0,0,0.5);
                --shadow-hover: 0 6px 18px rgba(0,0,0,0.6);
            }
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: var(--bg-page);
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
        }
        a { color: var(--accent); }
        code { font-family: ui-monospace, SFMono-Regular, monospace; }

        /* ── Sidebar ─────────────────────────────────────────────── */
        .sidebar {
            width: 320px;
            min-width: 320px;
            background: var(--bg-sidebar);
            border-right: 1px solid var(--border);
            padding: 16px 0;
            position: sticky;
            top: 0;
            height: 100vh;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            transition: min-width 0.2s ease, width 0.2s ease;
        }
        .sidebar { scrollbar-width: thin; scrollbar-color: transparent transparent; }
        .sidebar:hover { scrollbar-color: var(--border-strong) transparent; }
        .sidebar::-webkit-scrollbar { width: 6px; }
        .sidebar::-webkit-scrollbar-track { background: transparent; }
        .sidebar::-webkit-scrollbar-thumb {
            background: transparent;
            border-radius: 3px;
            transition: background 0.2s;
        }
        .sidebar:hover::-webkit-scrollbar-thumb { background: var(--border-strong); }
        .sidebar::-webkit-scrollbar-thumb:hover { background: var(--text-faint); }
        .sidebar.collapsed { width: 48px; min-width: 48px; padding: 16px 0; }
        .sidebar.collapsed .sidebar-body { display: none; }
        .sidebar-controls { display: flex; align-items: center; justify-content: flex-end; padding: 0 8px; gap: 6px; }
        .sidebar-toggle, .theme-toggle {
            width: 32px; height: 32px;
            background: var(--bg-muted); color: var(--text-secondary);
            border: 1px solid var(--border); border-radius: 6px;
            cursor: pointer; font-size: 14px; line-height: 1;
            display: inline-flex; align-items: center; justify-content: center;
        }
        .sidebar-toggle:hover, .theme-toggle:hover { background: var(--accent-soft); color: var(--accent); }
        .sidebar.collapsed .sidebar-controls { justify-content: center; }
        .sidebar.collapsed .theme-toggle { display: none; }
        .sidebar-header {
            padding: 12px 18px 10px 18px;
            border-bottom: 1px solid var(--border);
            margin-bottom: 8px;
        }
        .sidebar-header h2 { font-size: 13px; color: var(--text-primary); text-transform: uppercase; letter-spacing: 0.6px; }
        .sidebar-header .subtitle { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
        .epic-group { margin-bottom: 4px; }
        .epic-group-header {
            display: flex; align-items: center; gap: 6px;
            padding: 7px 12px; margin: 4px 6px;
            font-size: 11px; font-weight: 700; color: var(--text-secondary);
            text-transform: uppercase; letter-spacing: 0.6px;
            cursor: pointer; user-select: none;
            border-radius: 6px;
        }
        .epic-group-header:hover { background: var(--bg-muted); }
        .epic-caret { font-size: 10px; color: var(--text-muted); transition: transform 0.15s; display: inline-block; width: 10px; }
        .epic-group.collapsed .epic-caret { transform: rotate(-90deg); }
        .epic-group.collapsed .epic-items,
        .epic-group.collapsed .epic-main-grid { display: none; }
        .epic-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .epic-count { font-size: 10px; color: var(--text-muted); font-weight: 600; }
        .epic-count.complete { color: var(--success); }
        .pipeline { padding: 0 6px; }
        .pipeline-item {
            position: relative;
            display: flex; align-items: flex-start; gap: 10px;
            padding: 8px 8px;
            border-radius: 6px;
            cursor: pointer;
            transition: background 0.12s;
            text-decoration: none;
            color: inherit;
        }
        .pipeline-item:hover { background: var(--bg-muted); }
        .pipeline-item.active { background: var(--accent-soft); }
        .pipeline-item:not(:last-child)::after {
            content: '';
            position: absolute;
            left: 19px; top: 30px; bottom: -2px;
            width: 2px; background: var(--border);
            z-index: 0;
        }
        .pipeline-icon {
            width: 22px; height: 22px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 12px; font-weight: 700; color: white;
            flex-shrink: 0;
            z-index: 1; position: relative;
        }
        .pipeline-icon.pass { background: var(--success); }
        .pipeline-icon.fail { background: var(--danger); }
        .pipeline-icon.pending { background: var(--border-strong); color: var(--text-secondary); }
        .pipeline-icon.active-run {
            background: var(--warning);
            box-shadow: 0 0 0 0 rgba(234,179,8,0.55);
            animation: pipeline-active-pulse 1.6s ease-in-out infinite;
        }
        @keyframes pipeline-active-pulse {
            0%   { box-shadow: 0 0 0 0   rgba(234,179,8,0.55); }
            70%  { box-shadow: 0 0 0 8px rgba(234,179,8,0);    }
            100% { box-shadow: 0 0 0 0   rgba(234,179,8,0);    }
        }
        @media (prefers-reduced-motion: reduce) {
            .pipeline-icon.active-run { animation: none; }
        }
        .pipeline-icon.janitor { background: var(--janitor); }
        .pipeline-text { flex: 1; min-width: 0; }
        .pipeline-id { font-size: 11px; font-weight: 700; color: var(--accent); text-transform: uppercase; }
        .pipeline-title {
            font-size: 13px; color: var(--text-primary); line-height: 1.3; margin-top: 2px;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }

        /* ── Main ────────────────────────────────────────────────── */
        .main {
            flex: 1;
            padding: 28px 24px;
            min-width: 0;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        header {
            background: var(--bg-surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 24px 26px;
            margin-bottom: 20px;
            box-shadow: var(--shadow);
        }
        .header-top {
            display: flex; align-items: flex-start; gap: 12px;
            margin-bottom: 6px;
        }
        .header-top h1 { color: var(--text-primary); font-size: 24px; flex: 1; min-width: 0; }
        .header-actions { display: flex; gap: 8px; flex-shrink: 0; }
        .header-btn {
            background: var(--bg-muted); color: var(--text-secondary);
            border: 1px solid var(--border); border-radius: 6px;
            padding: 6px 12px; font-size: 12px; font-weight: 600;
            cursor: pointer; font-family: inherit;
            display: inline-flex; align-items: center; gap: 6px;
        }
        .header-btn:hover { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
        .header-btn[disabled] { opacity: 0.4; cursor: not-allowed; }
        .meta { color: var(--text-muted); font-size: 13px; margin-bottom: 16px; }
        .meta code { background: var(--bg-code); color: var(--text-primary); padding: 2px 6px; border-radius: 4px; font-size: 11px; }
        .summary-grid {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
            gap: 12px; margin-top: 16px;
        }
        .summary-card {
            background: var(--bg-surface-2);
            border: 1px solid var(--border);
            color: var(--text-primary);
            padding: 14px 16px;
            border-radius: 8px;
        }
        .summary-card h3 {
            font-size: 11px; color: var(--text-muted);
            margin-bottom: 6px;
            text-transform: uppercase; letter-spacing: 0.6px;
            font-weight: 600;
        }
        .summary-card .value { font-size: 22px; font-weight: 700; color: var(--text-primary); }
        .summary-card.success { border-left: 3px solid var(--success); }
        .summary-card.success .value { color: var(--success); }
        .summary-card.warning { border-left: 3px solid var(--warning); }
        .summary-card.warning .value { color: var(--warning); }
        .summary-card.danger  { border-left: 3px solid var(--danger); }
        .summary-card.danger .value { color: var(--danger); }
        .summary-card.halted  { border-left: 3px solid var(--warning); }
        .summary-card.halted .value { color: var(--warning); }
        .budget-bar {
            position: relative;
            height: 18px;
            background: var(--bg-muted);
            border-radius: 4px;
            overflow: hidden;
            margin-top: 6px;
        }
        .budget-fill {
            height: 100%;
            background: var(--accent);
            transition: width 0.4s;
        }
        .budget-fill.warn { background: var(--warning); }
        .budget-fill.over { background: var(--danger); }
        .budget-label {
            position: absolute; inset: 0;
            display: flex; align-items: center; justify-content: center;
            font-size: 11px; font-weight: 600; color: var(--text-primary);
            mix-blend-mode: difference;
            filter: invert(1) grayscale(1) contrast(9);
        }
        .sparkline-wrap {
            margin-top: 14px;
            padding: 10px 14px;
            background: var(--bg-surface-2);
            border: 1px solid var(--border);
            border-radius: 8px;
        }
        .sparkline-label {
            font-size: 10px; color: var(--text-muted);
            text-transform: uppercase; letter-spacing: 0.6px;
            margin-bottom: 6px;
            display: flex; align-items: baseline; justify-content: space-between;
        }
        .sparkline-label .max { color: var(--text-faint); font-size: 10px; text-transform: none; letter-spacing: 0; }
        .sparkline {
            display: block; width: 100%; height: 32px;
        }
        .sparkline rect { fill: var(--accent); }
        .sparkline rect.pass { fill: var(--success); }
        .sparkline rect.fail { fill: var(--danger); }
        .sparkline rect.pending { fill: var(--warning); }

        /* ── Usage limit banner ─────────────────────────────────── */
        .usage-banner {
            background: var(--warning-soft);
            border: 1px solid var(--warning);
            border-radius: 12px;
            padding: 12px 16px;
            margin-bottom: 16px;
            display: flex;
            gap: 12px;
            align-items: center;
            box-shadow: var(--shadow);
        }
        .usage-banner-icon {
            width: 20px; height: 20px;
            color: var(--warning);
            flex-shrink: 0;
        }
        .usage-banner-icon svg { width: 100%; height: 100%; display: block; }
        .usage-banner-body { flex: 1; min-width: 0; }
        .usage-banner-label {
            font-size: 11px; font-weight: 700; color: var(--warning-strong);
            text-transform: uppercase; letter-spacing: 0.8px;
        }
        .usage-banner-title {
            font-size: 14px; color: var(--text-primary); margin-top: 2px;
        }
        .usage-banner-title strong { font-weight: 700; }
        .usage-banner-meta {
            font-size: 12px; color: var(--text-muted); margin-top: 4px;
        }

        /* ── Halt banner ────────────────────────────────────────── */
        .halt-banner {
            background: var(--warning-soft);
            border: 1px solid var(--warning);
            border-radius: 12px;
            padding: 16px 18px;
            margin-bottom: 16px;
            display: flex;
            gap: 14px;
            align-items: flex-start;
            box-shadow: var(--shadow);
        }
        .halt-banner-icon {
            width: 24px; height: 24px;
            color: var(--warning);
            flex-shrink: 0;
            margin-top: 2px;
        }
        .halt-banner-icon svg { width: 100%; height: 100%; display: block; }
        .halt-banner-body { flex: 1; min-width: 0; }
        .halt-banner-label {
            font-size: 11px; font-weight: 700; color: var(--warning-strong);
            text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 4px;
        }
        .halt-banner-title { font-size: 16px; font-weight: 700; color: var(--text-primary); line-height: 1.3; }
        .halt-banner-meta {
            display: flex; flex-wrap: wrap; gap: 10px;
            margin-top: 8px; font-size: 12px; color: var(--text-secondary);
        }
        .halt-banner-meta strong { color: var(--text-primary); font-weight: 600; }
        .halt-banner-meta a {
            color: var(--accent); text-decoration: none; font-weight: 600;
            background: var(--bg-surface); padding: 2px 8px; border-radius: 10px;
            border: 1px solid var(--border);
        }
        .halt-banner-meta a:hover { text-decoration: underline; }
        .halt-banner-story, .halt-banner-next {
            margin-top: 8px;
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
            font-size: 13px;
            color: var(--text-primary);
        }
        .halt-banner-story-label, .halt-banner-next-label {
            font-size: 10px; font-weight: 700;
            color: var(--warning-strong);
            text-transform: uppercase; letter-spacing: 0.7px;
            background: var(--bg-surface);
            padding: 2px 8px; border-radius: 10px;
            border: 1px solid var(--border);
            white-space: nowrap;
        }
        .halt-banner-next-label { color: var(--accent); }
        .halt-banner-story-link, .halt-banner-next-link {
            color: var(--text-primary);
            text-decoration: none;
        }
        .halt-banner-story-link:hover, .halt-banner-next-link:hover { text-decoration: underline; }
        .halt-banner-next-epic {
            font-size: 11px;
            color: var(--text-muted);
            background: var(--bg-surface);
            padding: 1px 8px;
            border-radius: 10px;
            border: 1px solid var(--border);
        }
        .halt-banner-action {
            margin-top: 10px;
            font-size: 12px;
            color: var(--text-secondary);
            display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        }
        .halt-banner-action code {
            background: var(--bg-code);
            color: var(--text-primary);
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 11px;
        }
        .copy-btn {
            background: var(--bg-surface);
            color: var(--accent);
            border: 1px solid var(--accent);
            border-radius: 6px;
            padding: 4px 10px;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            font-family: inherit;
        }
        .copy-btn:hover { background: var(--accent); color: var(--accent-on); }
        .copy-btn.done { background: var(--success); color: white; border-color: var(--success); }

        /* ── Config panel ───────────────────────────────────────── */
        .config-panel {
            background: var(--bg-surface-2);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 12px 16px;
            margin-top: 14px;
            font-size: 13px;
            color: var(--text-primary);
        }
        .config-panel-header {
            font-size: 11px; font-weight: 700; color: var(--text-muted);
            text-transform: uppercase; letter-spacing: 0.7px;
            margin-bottom: 8px;
            display: flex; justify-content: space-between; align-items: baseline;
        }
        .config-panel-header code { background: var(--bg-code); padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 500; color: var(--text-primary); }
        .config-grid {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 10px 18px;
        }
        .config-row { display: flex; flex-direction: column; }
        .config-row-label {
            font-size: 10px; font-weight: 600; color: var(--text-muted);
            text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;
        }
        .config-row-value { font-size: 13px; color: var(--text-primary); word-break: break-word; }
        .config-row-value code {
            background: var(--bg-code); color: var(--text-primary);
            padding: 1px 6px; border-radius: 3px;
            font-size: 12px;
        }
        .config-tag {
            display: inline-block;
            background: var(--accent-soft); color: var(--accent);
            font-size: 11px; font-weight: 600;
            padding: 2px 8px; border-radius: 10px; margin-right: 4px;
        }
        .sensor-health {
            background: var(--bg-surface-2);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 12px 16px;
            margin-top: 14px;
            color: var(--text-primary);
        }
        .sensor-health-header {
            font-size: 11px; font-weight: 700; color: var(--text-muted);
            text-transform: uppercase; letter-spacing: 0.7px;
            margin-bottom: 10px;
            display: flex; justify-content: space-between; align-items: baseline; gap: 10px;
        }
        .sensor-health-janitor-summary {
            font-size: 11px; font-weight: 500;
            color: var(--text-secondary); text-transform: none; letter-spacing: 0;
        }
        .sensor-health-empty {
            font-size: 12px; color: var(--text-muted); font-style: italic;
            padding: 4px 0;
        }
        .sensor-grid {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 10px;
        }
        .sensor-card {
            background: var(--bg-surface);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 10px 12px;
            display: flex; flex-direction: column; gap: 6px;
        }
        .sensor-card.warn { border-color: #f59e0b; }
        .sensor-card.danger { border-color: #dc2626; }
        .sensor-card-top {
            display: flex; align-items: baseline; justify-content: space-between; gap: 6px;
        }
        .sensor-card-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
        .sensor-card-type {
            font-size: 10px; font-weight: 600;
            text-transform: uppercase; letter-spacing: 0.5px;
            padding: 1px 6px; border-radius: 8px;
            background: var(--accent-soft); color: var(--accent);
        }
        .sensor-card-type.debt { background: rgba(245, 158, 11, 0.15); color: #b45309; }
        .sensor-card-type.drift { background: rgba(124, 58, 237, 0.15); color: #6d28d9; }
        [data-theme="dark"] .sensor-card-type.debt { color: #fbbf24; }
        [data-theme="dark"] .sensor-card-type.drift { color: #c4b5fd; }
        @media (prefers-color-scheme: dark) {
            [data-theme="auto"] .sensor-card-type.debt { color: #fbbf24; }
            [data-theme="auto"] .sensor-card-type.drift { color: #c4b5fd; }
        }
        .sensor-card-count {
            font-size: 20px; font-weight: 700; color: var(--text-primary);
            font-variant-numeric: tabular-nums;
        }
        .sensor-card.warn .sensor-card-count { color: #b45309; }
        .sensor-card.danger .sensor-card-count { color: #dc2626; }
        [data-theme="dark"] .sensor-card.warn .sensor-card-count { color: #fbbf24; }
        [data-theme="dark"] .sensor-card.danger .sensor-card-count { color: #f87171; }
        .sensor-card-threshold {
            font-size: 11px; color: var(--text-muted);
            font-variant-numeric: tabular-nums;
        }
        .sensor-card-bar {
            position: relative;
            background: var(--bg-muted);
            border-radius: 999px;
            height: 4px; overflow: hidden;
        }
        .sensor-card-bar-fill {
            position: absolute; left: 0; top: 0; bottom: 0;
            background: var(--accent);
            border-radius: 999px;
        }
        .sensor-card.warn .sensor-card-bar-fill { background: #f59e0b; }
        .sensor-card.danger .sensor-card-bar-fill { background: #dc2626; }
        .sensor-card-spark { display: block; width: 100%; height: 22px; }
        .sensor-card-foot {
            display: flex; justify-content: space-between; gap: 6px;
            font-size: 10px; color: var(--text-muted);
            text-transform: uppercase; letter-spacing: 0.4px;
        }
        .sensor-card-foot .trips { color: var(--text-secondary); font-weight: 600; }
        .sensor-card.empty .sensor-card-count { color: var(--text-muted); font-size: 13px; font-weight: 500; }
        .config-workflow-badge {
            display: inline-block;
            background: var(--text-primary); color: var(--bg-surface);
            font-size: 12px; font-weight: 700;
            padding: 3px 10px; border-radius: 12px;
            text-transform: uppercase; letter-spacing: 0.5px;
        }
        .mode-badge.maintenance {
            display: inline-block;
            background: var(--janitor-soft); color: var(--janitor);
            border: 1px solid var(--janitor);
            font-size: 11px; font-weight: 700;
            padding: 2px 8px; border-radius: 10px;
            text-transform: uppercase; letter-spacing: 0.5px;
        }

        /* ── Stories ───────────────────────────────────────────── */
        .stories-grid {
            display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
            gap: 18px; margin-top: 14px;
        }
        .epic-main {
            background: var(--bg-surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 18px;
            margin-top: 18px;
            box-shadow: var(--shadow-sm);
        }
        .epic-main-header {
            display: flex; align-items: center; justify-content: space-between;
            color: var(--text-primary); cursor: pointer; user-select: none;
            padding-bottom: 8px;
            gap: 12px;
        }
        .epic-main-title { font-size: 17px; font-weight: 700; }
        .epic-main-meta { font-size: 12px; color: var(--text-muted); }
        .epic-main .epic-caret { color: var(--text-muted); font-size: 13px; }
        .epic-progress {
            height: 4px; background: var(--bg-muted); border-radius: 2px; overflow: hidden;
            margin-top: 4px;
        }
        .epic-progress-bar { height: 100%; background: var(--success); transition: width 0.4s; }
        .story-card {
            background: var(--bg-surface);
            border: 1px solid var(--border);
            border-radius: 10px;
            overflow: hidden;
            box-shadow: var(--shadow-sm);
            transition: transform 0.2s, box-shadow 0.2s;
            scroll-margin-top: 20px;
        }
        .story-card:target { box-shadow: 0 0 0 2px var(--accent), var(--shadow-sm); }
        .story-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-hover); }
        .story-header {
            padding: 14px 18px; border-bottom: 1px solid var(--border);
            display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;
            background: var(--bg-surface);
        }
        .story-header.passed { border-bottom-color: var(--success); }
        .story-header.failed { border-bottom-color: var(--danger); }
        .story-header.pending { border-bottom-color: var(--warning); }
        .story-id { font-size: 12px; font-weight: 700; color: var(--accent); text-transform: uppercase; }
        .story-title { font-size: 15px; font-weight: 600; color: var(--text-primary); margin: 4px 0 0 0; line-height: 1.4; }
        .story-epic { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
        .story-cost-chip {
            font-size: 11px; color: var(--text-muted); margin-top: 4px;
        }
        .story-cost-chip.over { color: var(--danger); font-weight: 600; }
        .story-cost-bar {
            height: 3px; background: var(--bg-muted); border-radius: 2px;
            margin-top: 4px; overflow: hidden;
        }
        .story-cost-bar-fill { height: 100%; background: var(--accent); }
        .story-cost-bar-fill.warn { background: var(--warning); }
        .story-cost-bar-fill.over { background: var(--danger); }
        .badge {
            display: inline-block; padding: 4px 10px; border-radius: 20px;
            font-size: 11px; font-weight: 600; text-transform: uppercase;
            letter-spacing: 0.4px; white-space: nowrap;
        }
        .badge.pass    { background: var(--success); color: white; }
        .badge.fail    { background: var(--danger); color: white; }
        .badge.pending { background: var(--warning); color: white; }
        .badge.idle    { background: var(--bg-muted); color: var(--text-secondary); border: 1px solid var(--border); }
        .phases { padding: 16px 18px; }
        .phase { margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
        .phase:last-of-type { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
        .phase-name {
            font-size: 11px; font-weight: 700; color: var(--accent);
            text-transform: uppercase; margin-bottom: 6px; letter-spacing: 0.6px;
            cursor: help;
        }
        .phase-metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; font-size: 13px; }
        .metric { padding: 6px 8px; background: var(--bg-muted); border-radius: 6px; }
        .metric-label { color: var(--text-muted); font-size: 10px; text-transform: uppercase; margin-bottom: 2px; letter-spacing: 0.4px; }
        .metric-value { color: var(--text-primary); font-weight: 600; font-size: 13px; }
        .qa-results { display: flex; gap: 10px; font-size: 13px; margin-top: 8px; }
        .qa-pass { color: var(--success); font-weight: 600; }
        .qa-fail { color: var(--danger); font-weight: 600; }
        .cost { color: var(--accent); font-weight: 600; }
        .totals { padding: 12px 18px; border-top: 1px solid var(--border); font-weight: 600; font-size: 13px; background: var(--bg-surface-2); }
        .summary-block {
            padding: 12px 18px; background: var(--bg-surface-2); border-top: 1px solid var(--border);
            font-size: 12px; color: var(--text-secondary); line-height: 1.5; white-space: pre-wrap;
            max-height: 200px; overflow-y: auto;
        }
        .commits { padding: 10px 18px; font-size: 11px; color: var(--text-muted); background: var(--bg-surface-2); }
        .commits code { background: var(--bg-code); padding: 1px 5px; border-radius: 3px; font-size: 11px; }
        .story-details, .story-results { border-top: 1px solid var(--border); background: var(--bg-surface-2); }
        .story-details > summary, .story-results > summary {
            list-style: none;
            cursor: pointer;
            padding: 9px 18px;
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.7px;
            display: flex;
            align-items: center;
            gap: 8px;
            user-select: none;
        }
        .story-details > summary { color: var(--accent); }
        .story-results > summary { color: var(--success-strong); }
        .story-details > summary::-webkit-details-marker,
        .story-results > summary::-webkit-details-marker { display: none; }
        .story-details > summary::before,
        .story-results > summary::before {
            content: '▸';
            display: inline-block;
            font-size: 10px;
            transition: transform 0.15s;
        }
        .story-details > summary::before { color: var(--accent-2); }
        .story-results > summary::before { color: var(--success); }
        .story-details[open] > summary::before,
        .story-results[open] > summary::before { transform: rotate(90deg); }
        .story-details > summary:hover { background: var(--accent-soft); }
        .story-results > summary:hover { background: var(--success-soft); }
        .story-details-body { padding: 4px 18px 16px 18px; font-size: 13px; color: var(--text-primary); line-height: 1.55; }
        .story-details-section { margin-top: 10px; }
        .story-details-section:first-child { margin-top: 4px; }
        .story-details-label {
            font-size: 10px; font-weight: 700; color: var(--accent-2);
            text-transform: uppercase; letter-spacing: 0.7px;
            margin-bottom: 5px;
        }
        .story-details-text {
            color: var(--text-primary); white-space: pre-wrap;
            font-size: 13px; line-height: 1.55;
        }
        .story-details-criteria { list-style: none; padding: 0; margin: 0; }
        .story-details-criteria li {
            position: relative;
            padding: 3px 0 3px 22px;
            font-size: 13px; color: var(--text-primary); line-height: 1.5;
        }
        .story-details-criteria li::before {
            content: '○';
            position: absolute; left: 4px; top: 3px;
            color: var(--text-faint); font-weight: 700;
        }
        .story-details-criteria li.pass::before { content: '✓'; color: var(--success); }
        .story-details-criteria li.fail::before { content: '✗'; color: var(--danger); }

        .story-results-summary-meta {
            margin-left: auto;
            font-size: 10px; font-weight: 600;
            color: var(--text-muted);
            text-transform: none; letter-spacing: 0;
        }
        .story-results-summary-meta .diff-add { color: var(--success); }
        .story-results-summary-meta .diff-del { color: var(--danger); }
        .story-results-body { padding: 0; }
        .results-section { padding: 12px 18px; border-top: 1px solid var(--border); }
        .results-section:first-child { border-top: none; }
        .results-section-label {
            font-size: 10px; font-weight: 700; color: var(--success-strong);
            text-transform: uppercase; letter-spacing: 0.7px;
            margin-bottom: 8px;
        }
        .results-summary-text {
            font-size: 13px; color: var(--text-primary); line-height: 1.55;
            white-space: pre-wrap; max-height: 240px; overflow-y: auto;
        }
        .commit-list { display: flex; flex-direction: column; gap: 10px; }
        .commit-stat {
            background: var(--bg-surface); border: 1px solid var(--border);
            border-radius: 8px; padding: 10px 12px;
        }
        .commit-stat-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
        .commit-stat-sha {
            background: var(--text-primary); color: var(--bg-surface);
            padding: 2px 7px; border-radius: 4px;
            font-size: 11px; font-family: ui-monospace, SFMono-Regular, monospace;
        }
        .commit-stat-subject {
            font-size: 13px; color: var(--text-primary); font-weight: 500;
            flex: 1; min-width: 0;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .commit-stat-summary {
            font-size: 11px; color: var(--text-muted);
            font-family: ui-monospace, SFMono-Regular, monospace;
            white-space: nowrap;
        }
        .commit-stat-files { display: flex; flex-direction: column; gap: 3px; }
        .diff-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr) 44px 44px 100px;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            font-family: ui-monospace, SFMono-Regular, monospace;
        }
        .diff-file {
            color: var(--text-primary);
            overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
            text-align: left;
        }
        .diff-count { text-align: right; font-weight: 600; font-size: 11px; }
        .diff-add { color: var(--success); }
        .diff-del { color: var(--danger); }
        .diff-binary {
            grid-column: 2 / span 3;
            justify-self: end;
            color: var(--text-muted); font-style: italic; font-size: 11px;
        }
        .diff-bar {
            display: inline-flex; height: 8px;
            background: var(--bg-muted); border-radius: 2px; overflow: hidden;
        }
        .diff-bar-add { background: var(--success); height: 100%; }
        .diff-bar-del { background: var(--danger); height: 100%; }
        .results-phases { padding: 0 18px 12px 18px; }
        .results-phases .phase { margin: 0 0 14px 0; padding: 0 0 14px 0; }
        .results-phases .phase:last-child { margin-bottom: 0; padding-bottom: 0; }
        .results-total { margin-top: 4px; font-size: 12px; color: var(--text-secondary); }

        .empty {
            background: var(--bg-surface); border: 1px solid var(--border);
            border-radius: 12px; padding: 40px; text-align: center;
            box-shadow: var(--shadow); color: var(--text-muted);
        }
        .section-title {
            color: var(--text-primary); font-size: 13px;
            text-transform: uppercase; letter-spacing: 0.7px;
            margin: 24px 0 10px 0; font-weight: 700;
        }

        /* ── Patterns accordion ──────────────────────────────── */
        .patterns-details {
            background: var(--bg-surface);
            border: 1px solid var(--border);
            border-radius: 10px;
            box-shadow: var(--shadow-sm);
            margin-top: 14px;
        }
        .patterns-details > summary {
            list-style: none; cursor: pointer;
            padding: 12px 18px;
            font-size: 12px; font-weight: 700;
            color: var(--text-primary);
            text-transform: uppercase; letter-spacing: 0.7px;
            display: flex; align-items: center; gap: 8px; user-select: none;
        }
        .patterns-details > summary::-webkit-details-marker { display: none; }
        .patterns-details > summary::before {
            content: '▸'; font-size: 10px; color: var(--accent);
            transition: transform 0.15s;
        }
        .patterns-details[open] > summary::before { transform: rotate(90deg); }
        .patterns-list { padding: 0 18px 14px 18px; }
        .pattern { padding: 10px 0; border-bottom: 1px solid var(--border); }
        .pattern:last-child { border-bottom: none; }
        .pattern-name { font-weight: 600; color: var(--text-primary); font-size: 13px; }
        .pattern-tag { font-size: 10px; color: var(--text-muted); margin-left: 8px; }
        .pattern-desc { font-size: 12px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5; }

        /* ── Current task ────────────────────────────────────── */
        .current-task {
            background: var(--warning-soft);
            border: 1px solid var(--warning);
            border-radius: 10px;
            padding: 14px 18px;
            margin: 14px 0 4px 0;
            display: flex; gap: 14px; align-items: flex-start;
        }
        .current-task.janitor { background: var(--janitor-soft); border-color: var(--janitor); }
        .current-task.pr-review { background: var(--accent-soft); border-color: var(--accent); }
        .current-task-spinner {
            width: 24px; height: 24px; flex-shrink: 0;
            border: 3px solid var(--border);
            border-top-color: var(--danger);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-top: 2px;
        }
        .current-task.janitor .current-task-spinner { border-top-color: var(--janitor); }
        .current-task.pr-review .current-task-spinner { border-top-color: var(--accent); }
        @media (prefers-reduced-motion: reduce) {
            .current-task-spinner { animation: none; }
        }
        .current-task-body { flex: 1; min-width: 0; }
        .current-task-label {
            font-size: 11px; font-weight: 700; color: var(--warning-strong);
            text-transform: uppercase; letter-spacing: 0.7px; margin-bottom: 4px;
        }
        .current-task.janitor .current-task-label { color: var(--janitor); }
        .current-task.pr-review .current-task-label { color: var(--accent); }
        .current-task-title { font-size: 16px; font-weight: 700; color: var(--text-primary); line-height: 1.4; }
        .current-task-id { font-size: 12px; color: var(--text-muted); font-weight: 600; }
        .current-task-meta {
            display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px;
            font-size: 13px; color: var(--text-secondary);
        }
        .current-task-meta strong { color: var(--text-primary); font-weight: 600; }
        .current-task-phase {
            display: inline-flex; align-items: center; gap: 6px;
            background: var(--bg-surface); border: 1px solid var(--border);
            padding: 3px 10px; border-radius: 12px;
            font-weight: 600; font-size: 12px; color: var(--text-primary);
            text-transform: uppercase; letter-spacing: 0.5px;
        }
        .current-task-reasoning, .current-task-section {
            margin-top: 8px;
            font-size: 12px;
            background: var(--bg-surface);
            border: 1px solid var(--border);
            padding: 8px 10px;
            border-radius: 6px;
        }
        .current-task-section-label {
            font-size: 10px; font-weight: 700; color: var(--warning-strong);
            text-transform: uppercase; letter-spacing: 0.7px;
            margin-bottom: 4px;
        }
        .current-task.janitor .current-task-section-label { color: var(--janitor); }
        .current-task.pr-review .current-task-section-label { color: var(--accent); }
        .current-task-section-body { color: var(--text-primary); line-height: 1.5; white-space: pre-wrap; }
        .current-task-description {
            font-size: 13px; color: var(--text-primary); line-height: 1.5; margin-top: 8px;
        }
        .current-task-criteria { list-style: none; padding: 0; margin: 4px 0 0 0; }
        .current-task-criteria li {
            font-size: 12px; color: var(--text-primary); line-height: 1.5;
            padding: 3px 0 3px 22px; position: relative;
        }
        .current-task-criteria li::before {
            content: '○'; position: absolute; left: 4px; top: 3px;
            color: var(--text-faint); font-weight: 700;
        }
        .current-task-criteria li.pass::before { content: '✓'; color: var(--success); }
        .current-task-criteria li.fail::before { content: '✗'; color: var(--danger); }
        .current-task-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
        .current-task-tag {
            font-size: 11px; font-weight: 600;
            background: var(--bg-surface); border: 1px solid var(--border);
            color: var(--text-primary);
            padding: 2px 8px; border-radius: 10px;
        }
        .current-task-verdict {
            display: inline-block;
            font-size: 11px; font-weight: 700;
            padding: 3px 10px; border-radius: 12px;
            text-transform: uppercase; letter-spacing: 0.4px;
            margin-left: 8px;
        }
        .current-task-verdict.pass { background: var(--success); color: white; }
        .current-task-verdict.fail_retry { background: var(--warning); color: white; }
        .current-task-verdict.fail_abort { background: var(--danger); color: white; }
        .current-task-halt {
            margin-top: 10px;
            font-size: 12px;
            background: var(--danger-soft);
            color: var(--danger);
            padding: 8px 10px;
            border-radius: 6px;
            border: 1px solid var(--danger);
        }
        .current-task-halt strong { color: var(--danger); }
        @keyframes spin { to { transform: rotate(360deg); } }

        footer {
            text-align: center;
            color: var(--text-muted);
            margin-top: 28px; font-size: 12px;
        }
        .live-dot {
            display: inline-block; width: 8px; height: 8px; background: var(--success);
            border-radius: 50%; margin-right: 6px; animation: pulse 1.6s infinite;
        }
        @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.3 } }
        @media (prefers-reduced-motion: reduce) {
            .live-dot { animation: none; }
        }

        /* ── Mobile sidebar toggle ──────────────────────────── */
        .mobile-toggle {
            display: none;
            position: fixed;
            bottom: 18px; right: 18px;
            width: 48px; height: 48px;
            border-radius: 24px;
            background: var(--accent);
            color: var(--accent-on);
            border: none;
            box-shadow: var(--shadow-hover);
            z-index: 100;
            cursor: pointer;
            font-size: 18px;
            font-weight: 700;
        }

        @media (max-width: 720px) {
            body { display: block; }
            .sidebar {
                width: 100%; min-width: 0; height: auto;
                position: fixed; inset: 0; z-index: 90;
                transform: translateX(-100%); transition: transform 0.2s ease;
            }
            .sidebar.mobile-open { transform: translateX(0); }
            .sidebar.collapsed { display: none; }
            .mobile-toggle { display: flex; align-items: center; justify-content: center; }
            .main { padding: 16px 14px; }
            header { padding: 18px 16px; }
        }
    </style>
</head>
<body>
    <aside class="sidebar" id="sidebar">
        <div class="sidebar-controls">
            <button class="theme-toggle" id="themeToggle" title="Toggle theme" aria-label="Toggle theme">◐</button>
            <button class="sidebar-toggle" id="sidebarToggle" title="Collapse sidebar" aria-label="Collapse sidebar">‹</button>
        </div>
        <div class="sidebar-body">
            <div class="sidebar-header">
                <h2>Pipeline</h2>
                <div class="subtitle" id="sidebarSubtitle">—</div>
            </div>
            <nav class="pipeline" id="pipeline"></nav>
        </div>
    </aside>
    <button class="mobile-toggle" id="mobileToggle" aria-label="Open pipeline">☰</button>
    <div class="main">
        <div class="container">
            <header>
                <div class="header-top">
                    <h1 id="title">Marmite Dashboard</h1>
                    <div class="header-actions">
                        <button class="header-btn" id="jumpBtn" title="Jump to current task" disabled>↓ Current</button>
                    </div>
                </div>
                <div class="meta" id="meta"><span class="live-dot"></span>Loading…</div>
                <div id="haltBanner"></div>
                <div id="usageLimitBanner"></div>
                <div id="currentTask"></div>
                <div class="summary-grid" id="summary"></div>
                <div id="sparkline"></div>
                <div id="configPanel"></div>
                <div id="sensorHealth"></div>
            </header>
            <div id="content"></div>
            <div id="patternsWrap"></div>
            <footer id="footer"></footer>
        </div>
    </div>
    <script>
      'use strict';

      // ── Helpers ─────────────────────────────────────────────
      const fmtDur = (ms) => {
        if (ms == null) return '—';
        if (ms < 1000) return Math.round(ms) + 'ms';
        const s = ms / 1000;
        if (s < 60) return s.toFixed(1) + 's';
        const m = Math.floor(s / 60);
        const rem = Math.round(s % 60);
        if (m < 60) return m + 'm' + rem + 's';
        const h = Math.floor(m / 60);
        return h + 'h ' + (m % 60) + 'm';
      };
      const fmtCost = (usd) => '$' + (usd ?? 0).toFixed(2);
      const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      const middleTruncate = (s, max) => {
        if (!s || s.length <= max) return s;
        const head = Math.max(1, Math.floor((max - 1) / 2));
        const tail = Math.max(1, max - 1 - head);
        return s.slice(0, head) + '…' + s.slice(-tail);
      };

      const STATUS_LABEL = { in_progress: 'In Progress', completed: 'Completed', failed: 'Failed', halted: 'Halted', unknown: 'Unknown' };
      const STATUS_CLASS = { in_progress: 'warning', completed: 'success', failed: 'danger', halted: 'halted', unknown: '' };
      const STATUS_FAVICON_COLOR = {
        in_progress: '%23eab308',
        completed: '%2322c55e',
        failed: '%23ef4444',
        halted: '%23f59e0b',
        unknown: '%239ca3af',
      };
      const STATUS_TITLE_PREFIX = {
        in_progress: '● ',
        completed: '✓ ',
        failed: '✗ ',
        halted: '⏸ ',
        unknown: '',
      };
      const HALT_LABEL = { awaiting_pr_review: 'Awaiting PR Review' };

      const storyState = (s) => s.passed === true ? 'passed' : s.passed === false ? 'failed' : 'pending';

      // ── Project-scoped localStorage ─────────────────────────
      // Two projects on the same port would otherwise inherit each other's
      // collapsed-epic / open-details state. Hash by source path (always unique
      // per .marmite/events.jsonl install) so each project gets a clean namespace.
      let projectNs = 'default';
      const setProjectNs = (source) => {
        if (!source) return;
        let h = 5381;
        for (let i = 0; i < source.length; i++) h = ((h << 5) + h) ^ source.charCodeAt(i);
        projectNs = (h >>> 0).toString(36);
      };
      const lsKey = (k) => 'marmite-dashboard:' + projectNs + ':' + k;
      const ls = {
        getSet(k) {
          try { return new Set(JSON.parse(localStorage.getItem(lsKey(k)) || '[]')); }
          catch { return new Set(); }
        },
        setSet(k, set) {
          try { localStorage.setItem(lsKey(k), JSON.stringify([...set])); } catch {}
        },
        get(k) {
          try { return localStorage.getItem(lsKey(k)); } catch { return null; }
        },
        set(k, v) {
          try { localStorage.setItem(lsKey(k), v); } catch {}
        },
      };

      // ── Section render cache: only update DOM when payload changes ──
      // The page used to wipe innerHTML every poll, which lost text selection
      // and scroll state inside results panels. Hash the data going into each
      // section and skip the write when nothing changed.
      const sectionCache = new Map();
      const renderInto = (id, payload, renderer) => {
        const key = JSON.stringify(payload);
        if (sectionCache.get(id) === key) return;
        const el = document.getElementById(id);
        if (!el) return;
        try {
          el.innerHTML = renderer(payload);
          sectionCache.set(id, key);
        } catch (e) {
          console.error('[marmite-dashboard] ' + id + ':', e);
          el.innerHTML = '<div style="background:var(--danger-soft);color:var(--danger);padding:10px 14px;border-radius:8px;font-size:12px;margin:6px 0;border:1px solid var(--danger);">'
            + 'Failed to render ' + escape(id) + ': ' + escape((e && e.message) || String(e))
            + '</div>';
        }
      };

      // ── Phase / commit rendering ────────────────────────────
      const renderPhase = (p) => {
        const metrics = [
          ['Duration', fmtDur(p.durationMs)],
          ['Cost', '<span class="cost">' + fmtCost(p.costUsd) + '</span>'],
        ];
        if (p.turns) metrics.push(['Turns', p.turns]);
        if (p.attempts > 1) metrics.push(['Attempts', p.attempts]);
        const qa = (p.qaPass || p.qaFail)
          ? '<div class="qa-results">'
            + (p.qaPass ? '<span class="qa-pass">✓ Pass: ' + p.qaPass + '</span>' : '')
            + (p.qaFail ? '<span class="qa-fail">✗ Fail: ' + p.qaFail + '</span>' : '')
            + '</div>'
          : '';
        const phaseLabel = p.attempts > 1 ? escape(p.phase) + ' × ' + p.attempts : escape(p.phase);
        // Attempt breakdown on hover — we only have aggregates, not per-attempt,
        // but average over attempt count is still a useful estimate.
        let title = '';
        if (p.attempts > 1) {
          const avgDur = fmtDur(p.durationMs / p.attempts);
          const avgCost = fmtCost(p.costUsd / p.attempts);
          title = p.attempts + ' attempts · avg ' + avgDur + ' / ' + avgCost + ' per attempt';
        }
        return '<div class="phase">'
          + '<div class="phase-name"' + (title ? ' title="' + escape(title) + '"' : '') + '>' + phaseLabel + '</div>'
          + '<div class="phase-metrics">'
          + metrics.map(([k, v]) => '<div class="metric"><div class="metric-label">' + k + '</div><div class="metric-value">' + v + '</div></div>').join('')
          + '</div>' + qa + '</div>';
      };

      const renderCommitStat = (cs) => {
        const files = Array.isArray(cs && cs.files) ? cs.files : [];
        const sha = cs && typeof cs.sha === 'string' ? cs.sha : '';
        const subject = cs && typeof cs.subject === 'string' ? cs.subject : '';
        const totalAdded = cs && typeof cs.totalAdded === 'number' ? cs.totalAdded : 0;
        const totalDeleted = cs && typeof cs.totalDeleted === 'number' ? cs.totalDeleted : 0;
        const maxLineChanges = files.reduce(
          (acc, f) => Math.max(acc, (f.added || 0) + (f.deleted || 0)), 0,
        ) || 1;
        const rows = files.map((f) => {
          const added = typeof f.added === 'number' ? f.added : 0;
          const deleted = typeof f.deleted === 'number' ? f.deleted : 0;
          const file = typeof f.file === 'string' ? f.file : '';
          const display = middleTruncate(file, 60);
          if (f.binary) {
            return '<div class="diff-row">'
              + '<span class="diff-file" title="' + escape(file) + '">' + escape(display) + '</span>'
              + '<span class="diff-binary">binary</span>'
              + '</div>';
          }
          const total = added + deleted;
          const widthPct = (total / maxLineChanges) * 100;
          const addPct = total === 0 ? 0 : (added / total) * 100;
          const delPct = 100 - addPct;
          return '<div class="diff-row">'
            + '<span class="diff-file" title="' + escape(file) + '">' + escape(display) + '</span>'
            + '<span class="diff-count diff-add">+' + added + '</span>'
            + '<span class="diff-count diff-del">-' + deleted + '</span>'
            + '<span class="diff-bar" style="width:' + widthPct.toFixed(1) + '%">'
            +   '<span class="diff-bar-add" style="width:' + addPct.toFixed(1) + '%"></span>'
            +   '<span class="diff-bar-del" style="width:' + delPct.toFixed(1) + '%"></span>'
            + '</span>'
            + '</div>';
        }).join('');
        const fileLabel = files.length + ' file' + (files.length === 1 ? '' : 's');
        return '<div class="commit-stat">'
          + '<div class="commit-stat-header">'
          +   '<code class="commit-stat-sha">' + escape(sha.slice(0, 10)) + '</code>'
          +   '<span class="commit-stat-subject" title="' + escape(subject) + '">' + escape(subject || '(no subject)') + '</span>'
          +   '<span class="commit-stat-summary">'
          +     '<span class="diff-add">+' + totalAdded + '</span> '
          +     '<span class="diff-del">-' + totalDeleted + '</span> · ' + fileLabel
          +   '</span>'
          + '</div>'
          + (rows ? '<div class="commit-stat-files">' + rows + '</div>' : '')
          + '</div>';
      };

      // ── Story rendering ─────────────────────────────────────
      const renderStoryDetails = (s) => {
        const hasDescription = !!s.description;
        const hasCriteria = s.acceptanceCriteria && s.acceptanceCriteria.length > 0;
        if (!hasDescription && !hasCriteria) return '';
        const sections = [];
        if (hasDescription) {
          sections.push(
            '<div class="story-details-section">'
            + '<div class="story-details-label">Description</div>'
            + '<div class="story-details-text">' + escape(s.description) + '</div>'
            + '</div>'
          );
        }
        if (hasCriteria) {
          const items = s.acceptanceCriteria.map((c) => '<li>' + escape(c) + '</li>').join('');
          sections.push(
            '<div class="story-details-section">'
            + '<div class="story-details-label">Acceptance Criteria</div>'
            + '<ul class="story-details-criteria">' + items + '</ul>'
            + '</div>'
          );
        }
        const isOpen = ls.getSet('open-details').has(s.storyId);
        return '<details class="story-details" data-story-details="' + escape(s.storyId) + '"'
          + (isOpen ? ' open' : '') + '>'
          + '<summary>Story details</summary>'
          + '<div class="story-details-body">' + sections.join('') + '</div>'
          + '</details>';
      };

      const renderStoryResults = (s) => {
        const phases = Array.isArray(s.phases) ? s.phases : [];
        const commitStats = Array.isArray(s.commitStats) ? s.commitStats : [];
        const commitShas = Array.isArray(s.commitShas) ? s.commitShas : [];
        const hasPhases = phases.length > 0;
        const hasSummary = typeof s.summary === 'string' && s.summary.length > 0;
        const hasCommits = commitShas.length > 0 || commitStats.length > 0;
        if (!hasPhases && !hasSummary && !hasCommits) return '';

        const totalAdded = commitStats.reduce((a, c) => a + (c.totalAdded || 0), 0);
        const totalDeleted = commitStats.reduce((a, c) => a + (c.totalDeleted || 0), 0);
        const summaryMetaBits = [];
        if (commitStats.length) {
          summaryMetaBits.push(commitStats.length + ' commit' + (commitStats.length === 1 ? '' : 's'));
          summaryMetaBits.push(
            '<span class="diff-add">+' + totalAdded + '</span> <span class="diff-del">-' + totalDeleted + '</span>'
          );
        } else if (typeof s.totalCostUsd === 'number' && s.totalCostUsd > 0) {
          summaryMetaBits.push(fmtCost(s.totalCostUsd));
        }
        const summaryMeta = summaryMetaBits.length
          ? '<span class="story-results-summary-meta">' + summaryMetaBits.join(' · ') + '</span>'
          : '';

        const sections = [];
        if (hasSummary) {
          sections.push(
            '<div class="results-section">'
            + '<div class="results-section-label">Summary</div>'
            + '<div class="results-summary-text">' + escape(s.summary) + '</div>'
            + '</div>'
          );
        }
        if (hasCommits) {
          const commitsBody = commitStats.length
            ? '<div class="commit-list">' + commitStats.map(renderCommitStat).join('') + '</div>'
            : '<div style="font-size:12px; color:var(--text-muted);">'
              + commitShas.map((c) => '<code>' + escape(String(c).slice(0, 10)) + '</code>').join(' ')
              + '<div style="margin-top:4px; font-style:italic;">No diffstat available — commits may be from another repository or have been pruned.</div>'
              + '</div>';
          sections.push(
            '<div class="results-section">'
            + '<div class="results-section-label">Changes</div>'
            + commitsBody
            + '</div>'
          );
        }
        if (hasPhases) {
          const total = (typeof s.totalCostUsd === 'number' && s.totalCostUsd > 0)
            ? '<div class="results-total">Total cost: <span class="cost">' + fmtCost(s.totalCostUsd) + '</span></div>'
            : '';
          sections.push(
            '<div class="results-section">'
            + '<div class="results-section-label">Run Phases</div>'
            + '<div class="results-phases">' + phases.map(renderPhase).join('') + '</div>'
            + total
            + '</div>'
          );
        }

        const storyId = typeof s.storyId === 'string' ? s.storyId : '';
        const isOpen = storyId ? ls.getSet('open-results').has(storyId) : false;
        return '<details class="story-results" data-results-details="' + escape(storyId) + '"'
          + (isOpen ? ' open' : '') + '>'
          + '<summary>Run results' + summaryMeta + '</summary>'
          + '<div class="story-results-body">' + sections.join('') + '</div>'
          + '</details>';
      };

      const renderStoryCostChip = (s, budget) => {
        if (!budget || typeof budget.perStory !== 'number') return '';
        const cost = typeof s.totalCostUsd === 'number' ? s.totalCostUsd : 0;
        if (cost <= 0) return '';
        const pct = Math.min(100, (cost / budget.perStory) * 100);
        const over = cost > budget.perStory;
        const warn = !over && cost > budget.perStory * 0.8;
        const cls = over ? 'over' : warn ? 'warn' : '';
        return '<div class="story-cost-chip ' + (over ? 'over' : '') + '">'
          + fmtCost(cost) + ' / ' + fmtCost(budget.perStory) + '</div>'
          + '<div class="story-cost-bar"><div class="story-cost-bar-fill ' + cls + '" style="width:' + pct.toFixed(1) + '%"></div></div>';
      };

      const renderStory = (s, budget, runStatus, activeStoryId) => {
        let badge;
        const isActive = runStatus === 'in_progress' && s.storyId === activeStoryId;
        if (s.passed === true) {
          badge = '<span class="badge pass">✓ Pass' + (s.attempts > 1 ? ' (' + s.attempts + ' attempts)' : '') + '</span>';
        } else if (s.passed === false) {
          badge = '<span class="badge fail">✗ Fail</span>';
        } else if (isActive) {
          badge = '<span class="badge pending">… In Progress</span>';
        } else if (s.phases.length > 0) {
          // Story has prior phase events but it isn't the task currently being
          // built (run is in-flight on a different story, or it's halted).
          // Don't claim "In Progress" — the halt banner / current-task card
          // shows the true active work.
          badge = '<span class="badge idle">Paused</span>';
        } else {
          badge = '<span class="badge idle">Queued</span>';
        }
        const state = storyState(s);
        const epic = s.epic ? '<div class="story-epic">' + escape(s.epic) + '</div>' : '';
        const costChip = renderStoryCostChip(s, budget);
        const details = renderStoryDetails(s);
        const results = renderStoryResults(s);
        return '<div class="story-card" id="story-' + escape(s.storyId) + '" data-story-card="' + escape(s.storyId) + '">'
          + '<div class="story-header ' + state + '">'
          + '<div><div class="story-id">' + escape(s.storyId) + '</div>'
          + '<div class="story-title">' + escape(s.title) + '</div>'
          + epic
          + costChip
          + '</div>' + badge + '</div>'
          + details + results
          + '</div>';
      };

      // ── Current task ────────────────────────────────────────
      const renderCurrentTask = (ct) => {
        if (!ct) return '';
        const kindCls = ct.kind === 'janitor' ? 'janitor' : ct.kind === 'pr-review' ? 'pr-review' : '';
        const kindLabel = ct.kind === 'janitor'
          ? 'Janitor in progress'
          : ct.kind === 'pr-review'
            ? 'PR review in progress'
            : 'Story in progress';
        const phaseBits = [];
        if (ct.phase) {
          const phaseTxt = ct.phase + (ct.attempt && ct.attempt > 1 ? ' · attempt ' + ct.attempt : '');
          phaseBits.push('<span class="current-task-phase">' + escape(phaseTxt) + '</span>');
        }
        if (ct.phaseDurationMs != null) {
          const running = ct.isPhaseActive ? 'running ' : 'last phase ';
          // Live-ticking duration for the active phase. data-live-base holds the
          // ms accumulated up to phaseStartedAt; data-live-start is when we
          // saw it. Client side ticker adds (now - start) every second so the
          // user sees the timer increment without waiting for the next poll.
          const startMs = ct.phaseStartedAt ? Date.parse(ct.phaseStartedAt) : null;
          const live = ct.isPhaseActive && startMs && !isNaN(startMs)
            ? '<strong class="js-live-duration" data-live-mode="from-start" data-live-start="' + startMs + '">'
              + escape(fmtDur(Date.now() - startMs)) + '</strong>'
            : '<strong>' + escape(fmtDur(ct.phaseDurationMs)) + '</strong>';
          phaseBits.push('<span>' + running + 'for ' + live + '</span>');
        }
        if (ct.iteration != null) phaseBits.push('<span>iteration <strong>' + ct.iteration + '</strong></span>');
        if (ct.priority != null) phaseBits.push('<span>priority <strong>' + ct.priority + '</strong></span>');

        const verdictBadge = ct.verdict
          ? '<span class="current-task-verdict ' + escape(ct.verdict) + '">' + escape(ct.verdict.replace('_', ' ')) + '</span>'
          : '';

        const description = ct.description
          ? '<div class="current-task-description">' + escape(ct.description) + '</div>'
          : '';

        const criteria = ct.acceptanceCriteria && ct.acceptanceCriteria.length
          ? (() => {
              const qaByCriterion = new Map();
              if (ct.qaResults) {
                for (const q of ct.qaResults) {
                  if (q && typeof q.criterion === 'string') qaByCriterion.set(q.criterion, q.passed);
                }
              }
              const items = ct.acceptanceCriteria.map((c) => {
                const passed = qaByCriterion.get(c);
                const cls = passed === true ? 'pass' : passed === false ? 'fail' : '';
                return '<li class="' + cls + '">' + escape(c) + '</li>';
              }).join('');
              return '<div class="current-task-section">'
                + '<div class="current-task-section-label">Acceptance Criteria</div>'
                + '<ul class="current-task-criteria">' + items + '</ul>'
                + '</div>';
            })()
          : '';

        const sensors = (ct.ranSensors && ct.ranSensors.length) || ct.sensorSummary
          ? '<div class="current-task-section">'
            + '<div class="current-task-section-label">Sensors</div>'
            + (ct.ranSensors && ct.ranSensors.length
                ? '<div class="current-task-tags">'
                  + ct.ranSensors.map((s) => '<span class="current-task-tag">' + escape(s) + '</span>').join('')
                  + '</div>'
                : '')
            + (ct.sensorSummary
                ? '<div class="current-task-section-body" style="margin-top:6px;">' + escape(ct.sensorSummary) + '</div>'
                : '')
            + '</div>'
          : '';

        const section = (label, body) => '<div class="current-task-section">'
          + '<div class="current-task-section-label">' + label + '</div>'
          + '<div class="current-task-section-body">' + escape(body) + '</div>'
          + '</div>';
        const guidance = ct.guidance ? section('Guidance', ct.guidance) : '';
        const reasoning = ct.reasoning ? section('Reasoning', ct.reasoning) : '';
        const notes = ct.notes ? section('Notes', ct.notes) : '';
        const verifierSummary = ct.verifierSummary
          ? '<div class="current-task-section">'
            + '<div class="current-task-section-label">Verifier Summary'
            + (ct.verifiedAt ? ' · ' + escape(new Date(ct.verifiedAt).toLocaleString()) : '')
            + '</div>'
            + '<div class="current-task-section-body">' + escape(ct.verifierSummary) + '</div>'
            + '</div>'
          : '';

        const halt = ct.halt
          ? '<div class="current-task-halt">'
            + '<strong>Halted:</strong> ' + escape(ct.halt.kind || 'unknown')
            + (ct.halt.prNum ? ' · PR #' + ct.halt.prNum : '')
            + (ct.halt.branch ? ' · branch <code>' + escape(ct.halt.branch) + '</code>' : '')
            + (ct.halt.reason ? '<div style="margin-top:4px;">' + escape(ct.halt.reason) + '</div>' : '')
            + '</div>'
          : '';

        const isPrReview = ct.kind === 'pr-review';
        const headerTitle = isPrReview && ct.epicLabel ? ct.epicLabel : ct.title;
        const headerHref = isPrReview && ct.epic ? ('#epic-' + escape(ct.epic)) : ('#story-' + escape(ct.storyId));
        const prLink = isPrReview && ct.prNum
          ? (ct.prUrl
              ? '<a href="' + escape(ct.prUrl) + '" target="_blank" rel="noopener">PR #' + ct.prNum + ' ↗</a>'
              : 'PR #' + ct.prNum)
          : '';
        const headerSubline = isPrReview
          ? [
              ct.epic ? 'Epic · ' + escape(ct.epic) : null,
              prLink || null,
              'addressing review on ' + escape(ct.storyId),
            ].filter(Boolean).join(' · ')
          : escape(ct.storyId);
        return '<div class="current-task ' + kindCls + '" data-current-task-id="' + escape(ct.storyId) + '">'
          + '<div class="current-task-spinner"></div>'
          + '<div class="current-task-body">'
          + '<div class="current-task-label">' + escape(kindLabel) + verdictBadge + '</div>'
          + '<div class="current-task-title"><a href="' + headerHref + '" style="color:inherit;text-decoration:none;">'
          + escape(headerTitle) + '</a></div>'
          + '<div class="current-task-id">' + headerSubline + '</div>'
          + '<div class="current-task-meta">' + phaseBits.join('') + '</div>'
          + description + criteria + sensors + guidance + reasoning + notes + verifierSummary + halt
          + '</div></div>';
      };

      // ── Halt banner ─────────────────────────────────────────
      const findStory = (d, storyId) => {
        if (!storyId || !d || !d.stories) return null;
        return d.stories.find((s) => s.storyId === storyId) || null;
      };

      const PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="10" y1="9" x2="10" y2="15"/><line x1="14" y1="9" x2="14" y2="15"/></svg>';

      const renderHaltBanner = (d) => {
        if (!d || !d.halt) return '';
        const reason = typeof d.halt.reason === 'string' ? d.halt.reason : 'halted';
        const label = HALT_LABEL[reason] || reason.replace(/_/g, ' ');
        const bits = [];
        if (d.halt.prNum) {
          if (d.halt.prUrl) {
            bits.push('<a href="' + escape(d.halt.prUrl) + '" target="_blank" rel="noopener">PR #' + d.halt.prNum + ' ↗</a>');
          } else {
            bits.push('<span>PR <strong>#' + d.halt.prNum + '</strong></span>');
          }
        }
        if (d.halt.branch) bits.push('<span>branch <strong>' + escape(d.halt.branch) + '</strong></span>');
        if (d.halt.at) bits.push('<span>since <strong>' + escape(new Date(d.halt.at).toLocaleString()) + '</strong></span>');

        const haltedStory = findStory(d, d.halt.haltedStoryId);
        const haltedEpic = reason === 'awaiting_pr_review' && haltedStory && haltedStory.epic
          ? (d.epics || []).find((e) => e.slug === haltedStory.epic)
          : null;
        let haltedRow = '';
        if (haltedEpic) {
          const passed = haltedEpic.storiesPassed || 0;
          const total = haltedEpic.storiesTotal || 0;
          haltedRow = '<div class="halt-banner-story">'
            + '<span class="halt-banner-story-label">In review</span>'
            + '<a class="halt-banner-story-link" href="#epic-' + escape(haltedEpic.slug) + '">'
            +   '<strong>Epic · ' + escape(haltedEpic.label) + '</strong>'
            + '</a>'
            + '<span class="halt-banner-next-epic">' + passed + ' / ' + total + ' stories</span>'
            + '</div>';
        } else if (haltedStory) {
          haltedRow = '<div class="halt-banner-story">'
            + '<span class="halt-banner-story-label">'
            +   (reason === 'awaiting_pr_review' ? 'In review' : 'Halted on')
            + '</span>'
            + '<a class="halt-banner-story-link" href="#story-' + escape(haltedStory.storyId) + '">'
            +   '<strong>' + escape(haltedStory.storyId) + '</strong> · ' + escape(haltedStory.title || haltedStory.storyId)
            + '</a>'
            + '</div>';
        }

        const nextUp = d.halt.nextUp;
        const nextRow = nextUp && typeof nextUp.storyId === 'string'
          ? '<div class="halt-banner-next">'
            + '<span class="halt-banner-next-label">Next up</span>'
            + '<a class="halt-banner-next-link" href="#story-' + escape(nextUp.storyId) + '">'
            +   '<strong>' + escape(nextUp.storyId) + '</strong> · ' + escape(nextUp.title || nextUp.storyId)
            + '</a>'
            + (nextUp.epic ? '<span class="halt-banner-next-epic">' + escape(nextUp.epic) + '</span>' : '')
            + '</div>'
          : '';

        const actionText = reason === 'awaiting_pr_review'
          ? 'Once the PR is merged, re-run'
          : 'Resolve the halt condition, then re-run';

        return '<div class="halt-banner">'
          + '<div class="halt-banner-icon">' + PAUSE_SVG + '</div>'
          + '<div class="halt-banner-body">'
          + '<div class="halt-banner-label">Run halted</div>'
          + '<div class="halt-banner-title">' + escape(label) + '</div>'
          + '<div class="halt-banner-meta">' + bits.join('') + '</div>'
          + haltedRow + nextRow
          + '<div class="halt-banner-action">'
          +   actionText + ' <code>marmite cook</code>'
          +   ' <button class="copy-btn" id="copyResumeBtn" type="button">Copy</button>'
          + '</div>'
          + '</div></div>';
      };

      // ── Usage limit banner ──────────────────────────────────
      const renderUsageLimitBanner = (d) => {
        if (!d || !d.usageLimit || !d.usageLimit.active) return '';
        const a = d.usageLimit.active;
        // Countdown: prefer expectedEndsAt (startedAt + waitMs). Falls back to
        // resumeAt (Anthropic-provided unix-seconds) when the harness didn't
        // record a planned end. The live ticker rewrites the inner text every
        // second using data-live-deadline.
        const deadlineMs = a.expectedEndsAt
          ? Date.parse(a.expectedEndsAt)
          : (a.resumeAt ? a.resumeAt * 1000 : null);
        const initial = deadlineMs && !isNaN(deadlineMs)
          ? Math.max(0, deadlineMs - Date.now())
          : (a.waitMs || 0);
        const countdownSpan = deadlineMs && !isNaN(deadlineMs)
          ? '<span class="js-live-duration" data-live-mode="countdown" data-live-deadline="' + deadlineMs + '">'
            + fmtDur(initial) + '</span>'
          : fmtDur(initial);
        const consecutiveBit = a.consecutive > 1
          ? ' · consecutive pause #' + a.consecutive
          : '';
        const phaseBit = a.agentLabel ? escape(a.agentLabel) : escape(a.phase || 'session');
        const totalBit = (d.usageLimit.count > 1 || d.usageLimit.totalWaitedMs > 0)
          ? d.usageLimit.count + ' pauses · ' + fmtDur(d.usageLimit.totalWaitedMs) + ' waited this project'
          : '';
        return '<div class="usage-banner">'
          + '<div class="usage-banner-icon">' + PAUSE_SVG + '</div>'
          + '<div class="usage-banner-body">'
          +   '<div class="usage-banner-label">Anthropic usage limit</div>'
          +   '<div class="usage-banner-title">Paused on <strong>' + phaseBit + '</strong> · resuming in <strong>' + countdownSpan + '</strong>' + consecutiveBit + '</div>'
          +   (totalBit ? '<div class="usage-banner-meta">' + totalBit + '</div>' : '')
          + '</div></div>';
      };

      // ── Config panel ────────────────────────────────────────
      const renderConfigPanel = (d) => {
        if (!d || !d.config) return '';
        const c = d.config;
        const rows = [];
        if (c.workflow) rows.push(['Workflow', '<span class="config-workflow-badge">' + escape(c.workflow) + '</span>']);
        if (c.baseBranch) rows.push(['Base branch', '<code>' + escape(c.baseBranch) + '</code>']);
        if (d.githubSlug) {
          rows.push(['Repo',
            '<a href="https://github.com/' + escape(d.githubSlug) + '" target="_blank" rel="noopener">'
            + escape(d.githubSlug) + ' ↗</a>']);
        }
        if (c.maxIterations != null) rows.push(['Max iterations', String(c.maxIterations)]);
        const modelBits = [];
        if (c.models.default) modelBits.push('default: <code>' + escape(c.models.default) + '</code>');
        if (c.models.orchestrator) modelBits.push('orch: <code>' + escape(c.models.orchestrator) + '</code>');
        if (c.models.builder) modelBits.push('build: <code>' + escape(c.models.builder) + '</code>');
        if (c.models.verifier) modelBits.push('verify: <code>' + escape(c.models.verifier) + '</code>');
        if (modelBits.length) rows.push(['Models', modelBits.join('<br>')]);
        const budgetBits = [];
        if (c.budget.perStory != null) budgetBits.push('per story: <strong>$' + c.budget.perStory.toFixed(2) + '</strong>');
        if (c.budget.total != null) budgetBits.push('total: <strong>$' + c.budget.total.toFixed(2) + '</strong>');
        if (budgetBits.length) rows.push(['Budget', budgetBits.join('<br>')]);
        if (c.sensors && c.sensors.length) {
          rows.push(['Sensors',
            c.sensors.map((s) => '<span class="config-tag">' + escape(s.name) + ' · ' + escape(s.type) + '</span>').join('')]);
        }
        if (c.janitor) {
          const jBits = [];
          if (c.janitor.thresholds) {
            if (c.janitor.thresholds.debt != null) jBits.push('debt ≥ <strong>' + c.janitor.thresholds.debt + '</strong>');
            if (c.janitor.thresholds.drift != null) jBits.push('drift ≥ <strong>' + c.janitor.thresholds.drift + '</strong>');
          }
          if (c.janitor.maxFindingsPerRun != null) jBits.push('max/run: <strong>' + c.janitor.maxFindingsPerRun + '</strong>');
          if (jBits.length) rows.push(['Janitor', jBits.join('<br>')]);
        }
        if (!rows.length) return '';
        const grid = rows.map(([k, v]) =>
          '<div class="config-row">'
          + '<div class="config-row-label">' + escape(k) + '</div>'
          + '<div class="config-row-value">' + v + '</div>'
          + '</div>'
        ).join('');
        const sourceTag = d.configSource ? '<code title="' + escape(d.configSource) + '">marmite.json</code>' : '';
        return '<div class="config-panel">'
          + '<div class="config-panel-header"><span>Project Configuration</span>' + sourceTag + '</div>'
          + '<div class="config-grid">' + grid + '</div>'
          + '</div>';
      };

      // ── Sensor health panel ─────────────────────────────────
      // Renders one card per sensor (configured + any that have emitted
      // results). Empty state hides the panel entirely so projects without
      // sensors don't see a stray header.
      const renderSensorSparkline = (history) => {
        if (!Array.isArray(history) || history.length < 2) return '';
        const w = 100, h = 22, pad = 2;
        const counts = history.map((p) => p.findingCount);
        const max = Math.max(1, ...counts);
        const min = Math.min(0, ...counts);
        const range = Math.max(1, max - min);
        const step = (w - pad * 2) / (history.length - 1);
        const pts = history.map((p, i) => {
          const x = pad + i * step;
          const y = pad + (h - pad * 2) * (1 - (p.findingCount - min) / range);
          return x.toFixed(1) + ',' + y.toFixed(1);
        }).join(' ');
        return '<svg class="sensor-card-spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">'
          + '<polyline fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" points="' + pts + '"/>'
          + '</svg>';
      };

      const renderSensorCard = (entry) => {
        const hasData = entry.latestFindingCount != null;
        const threshold = typeof entry.latestThreshold === 'number' ? entry.latestThreshold : null;
        const count = hasData ? entry.latestFindingCount : null;
        let cls = '';
        let pct = 0;
        if (hasData && threshold != null && threshold > 0) {
          pct = Math.min(100, (count / threshold) * 100);
          if (count >= threshold) cls = 'danger';
          else if (count >= threshold * 0.8) cls = 'warn';
        }
        if (!hasData) cls += ' empty';
        const typeLabel = entry.sensorType ? entry.sensorType : '';
        const typeCls = typeLabel === 'debt' || typeLabel === 'drift' ? typeLabel : '';
        const typeChip = typeLabel
          ? '<span class="sensor-card-type ' + typeCls + '">' + escape(typeLabel) + '</span>'
          : '';
        const countText = hasData ? String(count) : 'no data';
        const thresholdText = threshold != null
          ? '/ ' + threshold + (typeLabel ? ' (' + escape(typeLabel) + ' trip)' : '')
          : 'no threshold set';
        const bar = hasData && threshold != null && threshold > 0
          ? '<div class="sensor-card-bar"><div class="sensor-card-bar-fill" style="width:' + pct.toFixed(1) + '%"></div></div>'
          : '';
        const spark = renderSensorSparkline(entry.history);
        const iter = entry.latestIteration != null
          ? 'iter ' + entry.latestIteration
          : (entry.configured ? 'awaiting run' : '');
        const trips = entry.janitorTrips > 0
          ? '<span class="trips">' + entry.janitorTrips + ' trip' + (entry.janitorTrips === 1 ? '' : 's') + '</span>'
          : '';
        return '<div class="sensor-card ' + cls.trim() + '">'
          + '<div class="sensor-card-top">'
          + '<span class="sensor-card-name">' + escape(entry.sensor) + '</span>'
          + typeChip
          + '</div>'
          + '<div class="sensor-card-count">' + escape(countText)
          + ' <span class="sensor-card-threshold">' + escape(thresholdText) + '</span></div>'
          + bar
          + spark
          + '<div class="sensor-card-foot"><span>' + escape(iter) + '</span>' + trips + '</div>'
          + '</div>';
      };

      const renderSensorHealth = (d) => {
        const h = d && d.sensorHealth;
        if (!h || !Array.isArray(h.entries) || h.entries.length === 0) return '';
        const cards = h.entries.map(renderSensorCard).join('');
        const j = h.janitor || { triggered: 0, applied: 0, deferred: 0 };
        const summaryBits = [];
        if (j.triggered) summaryBits.push(j.triggered + ' triggered');
        if (j.applied) summaryBits.push(j.applied + ' fix' + (j.applied === 1 ? '' : 'es') + ' applied');
        if (j.deferred) summaryBits.push(j.deferred + ' deferred');
        const summary = summaryBits.length
          ? '<span class="sensor-health-janitor-summary">Janitor: ' + summaryBits.join(' · ') + '</span>'
          : '';
        return '<div class="sensor-health">'
          + '<div class="sensor-health-header"><span>Sensor Health</span>' + summary + '</div>'
          + '<div class="sensor-grid">' + cards + '</div>'
          + '</div>';
      };

      // ── Summary cards ───────────────────────────────────────
      const renderBudgetCard = (totalCostUsd, budget) => {
        const totalBudget = budget && typeof budget.total === 'number' ? budget.total : null;
        if (!totalBudget) {
          return '<div class="summary-card"><h3>Total Cost</h3><div class="value">' + fmtCost(totalCostUsd) + '</div></div>';
        }
        const pct = Math.min(100, (totalCostUsd / totalBudget) * 100);
        const over = totalCostUsd > totalBudget;
        const warn = !over && totalCostUsd > totalBudget * 0.8;
        const cls = over ? 'danger' : warn ? 'warning' : '';
        const fillCls = over ? 'over' : warn ? 'warn' : '';
        return '<div class="summary-card ' + cls + '">'
          + '<h3>Cost / Budget</h3>'
          + '<div class="value">' + fmtCost(totalCostUsd) + '</div>'
          + '<div class="budget-bar"><div class="budget-fill ' + fillCls + '" style="width:' + pct.toFixed(1) + '%"></div>'
          + '<div class="budget-label">' + pct.toFixed(0) + '% of ' + fmtCost(totalBudget) + '</div></div>'
          + '</div>';
      };

      const renderSummary = (d) => {
        if (!d) return '';
        const budget = d.config && d.config.budget;
        const status = d.status || 'unknown';
        // Duration ticks live for in-progress runs. For other states, render plain.
        const startMs = d.startedAt ? Date.parse(d.startedAt) : null;
        const durLive = status === 'in_progress' && d.durationMs != null && startMs && !isNaN(startMs)
          ? '<span class="js-live-duration" data-live-mode="anchored" data-live-base="' + d.durationMs + '" data-live-anchor="' + Date.now() + '">'
            + fmtDur(d.durationMs) + '</span>'
          : fmtDur(d.durationMs);
        const cards = [
          '<div class="summary-card success"><h3>Stories Passed</h3><div class="value">' + d.storiesPassed + '/' + d.storiesTotal + '</div></div>',
          renderBudgetCard(d.totalCostUsd, budget),
          '<div class="summary-card"><h3>Run Duration</h3><div class="value">' + durLive + '</div></div>',
          '<div class="summary-card ' + (STATUS_CLASS[status] || '') + '"><h3>Status</h3><div class="value">' + (STATUS_LABEL[status] || status) + '</div></div>',
        ];
        // Only show the usage-limit card once the project has actually hit a
        // pause. The active-pause banner above already covers in-flight pauses.
        if (d.usageLimit && d.usageLimit.count > 0) {
          const cls = d.usageLimit.active ? 'warning' : '';
          cards.push(
            '<div class="summary-card ' + cls + '"><h3>Usage Limit Pauses</h3>'
            + '<div class="value">' + d.usageLimit.count + '× · ' + fmtDur(d.usageLimit.totalWaitedMs) + '</div>'
            + '</div>',
          );
        }
        return cards.join('');
      };

      // ── Cost sparkline ──────────────────────────────────────
      const renderSparkline = (d) => {
        if (!d || !Array.isArray(d.stories)) return '';
        // Only stories that have actually been worked on; otherwise we get a
        // forest of zeros that drowns the real data.
        const data = d.stories.filter((s) => (s.totalCostUsd || 0) > 0);
        if (data.length < 2) return '';
        const max = data.reduce((a, s) => Math.max(a, s.totalCostUsd || 0), 0);
        if (max === 0) return '';
        const W = 600, H = 36;
        const barW = W / data.length;
        const bars = data.map((s, i) => {
          const v = s.totalCostUsd || 0;
          const h = (v / max) * H;
          const x = i * barW;
          const cls = s.passed === true ? 'pass' : s.passed === false ? 'fail' : 'pending';
          const title = (s.storyId || '') + ' · ' + fmtCost(v) + (s.title ? ' — ' + s.title : '');
          return '<a href="#story-' + escape(s.storyId) + '"><rect class="' + cls + '" x="' + x.toFixed(1) + '" y="' + (H - h).toFixed(1)
            + '" width="' + Math.max(1, barW - 1).toFixed(1) + '" height="' + h.toFixed(1)
            + '"><title>' + escape(title) + '</title></rect></a>';
        }).join('');
        return '<div class="sparkline-wrap">'
          + '<div class="sparkline-label"><span>Cost per story</span><span class="max">max ' + fmtCost(max) + '</span></div>'
          + '<svg class="sparkline" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + bars + '</svg>'
          + '</div>';
      };

      // ── Pipeline (sidebar) ──────────────────────────────────
      const pipelineItem = (s, runStatus, activeStoryId) => {
        let iconCls, iconChar;
        const isActive = runStatus === 'in_progress' && s.storyId === activeStoryId;
        if (s.passed === true) { iconCls = 'pass'; iconChar = '✓'; }
        else if (s.passed === false) { iconCls = 'fail'; iconChar = '✗'; }
        else if (isActive) { iconCls = 'active-run'; iconChar = '•'; }
        else { iconCls = 'pending'; iconChar = '○'; }
        if (s.isJanitor && s.passed !== true && s.passed !== false) iconCls = 'janitor';
        const title = escape(s.title || s.storyId);
        return '<a class="pipeline-item" href="#story-' + escape(s.storyId) + '" data-story="' + escape(s.storyId) + '">'
          + '<div class="pipeline-icon ' + iconCls + '">' + iconChar + '</div>'
          + '<div class="pipeline-text">'
          + '<div class="pipeline-id">' + escape(s.storyId) + '</div>'
          + '<div class="pipeline-title" title="' + title + '">' + title + '</div>'
          + '</div></a>';
      };

      const renderPipeline = (d) => {
        if (!d || !d.epics || !d.epics.length) {
          return '<div style="padding: 0 20px; color: var(--text-muted); font-size: 13px;">No stories yet.</div>';
        }
        const collapsed = ls.getSet('collapsed-epics');
        return d.epics.map((g) => {
          const isCollapsed = collapsed.has(g.slug);
          const countCls = g.storiesPassed === g.storiesTotal && g.storiesTotal > 0 ? 'complete' : '';
          return '<div class="epic-group ' + (isCollapsed ? 'collapsed' : '') + '" data-epic="' + escape(g.slug) + '">'
            + '<div class="epic-group-header" data-toggle-epic="' + escape(g.slug) + '">'
            + '<span class="epic-caret">▾</span>'
            + '<span class="epic-label" title="' + escape(g.label) + '">' + escape(g.label) + '</span>'
            + '<span class="epic-count ' + countCls + '">' + g.storiesPassed + '/' + g.storiesTotal + '</span>'
            + '</div>'
            + '<div class="epic-items">' + g.stories.map((s) => pipelineItem(s, d.status, d.currentTask && d.currentTask.storyId)).join('') + '</div>'
            + '</div>';
        }).join('');
      };

      const renderEpicMain = (d) => {
        if (!d || !d.epics || !d.epics.length) {
          return '<div class="empty">No stories yet — waiting for events.</div>';
        }
        const budget = d.config && d.config.budget;
        const collapsed = ls.getSet('collapsed-epics');
        return d.epics.map((g) => {
          const isCollapsed = collapsed.has(g.slug);
          const pct = g.storiesTotal === 0 ? 0 : (g.storiesPassed / g.storiesTotal) * 100;
          return '<div id="epic-' + escape(g.slug) + '" class="epic-main epic-group ' + (isCollapsed ? 'collapsed' : '') + '" data-epic-main="' + escape(g.slug) + '">'
            + '<div class="epic-main-header" data-toggle-epic="' + escape(g.slug) + '">'
            + '<div><div class="epic-main-title">' + escape(g.label) + '</div>'
            + '<div class="epic-progress"><div class="epic-progress-bar" style="width:' + pct.toFixed(1) + '%"></div></div></div>'
            + '<div style="display:flex; align-items:center; gap:12px;">'
            + '<span class="epic-main-meta">' + g.storiesPassed + ' / ' + g.storiesTotal + ' passed</span>'
            + '<span class="epic-caret">▾</span></div>'
            + '</div>'
            + '<div class="epic-main-grid"><div class="stories-grid">' + g.stories.map((s) => renderStory(s, budget, d.status, d.currentTask && d.currentTask.storyId)).join('') + '</div></div>'
            + '</div>';
        }).join('');
      };

      const renderPatterns = (patterns) => {
        if (!patterns || !patterns.length) return '';
        const isOpen = ls.get('patterns-open') === '1';
        return '<details class="patterns-details" id="patternsDetails"' + (isOpen ? ' open' : '') + '>'
          + '<summary>Patterns learned (' + patterns.length + ')</summary>'
          + '<div class="patterns-list">'
          + patterns.map((p) =>
              '<div class="pattern">'
              + '<span class="pattern-name">' + escape(p.name) + '</span>'
              + (p.addedInStory ? '<span class="pattern-tag">added in ' + escape(p.addedInStory) + '</span>' : '')
              + '<div class="pattern-desc">' + escape(p.description) + '</div>'
              + '</div>'
            ).join('')
          + '</div></details>';
      };

      // ── Theme ───────────────────────────────────────────────
      // Binary light/dark, no auto. The CSS still picks the OS preference on
      // first paint via prefers-color-scheme; once the user toggles, the
      // explicit data-theme attribute wins.
      const applyTheme = (mode) => {
        document.documentElement.setAttribute('data-theme', mode);
        ls.set('theme', mode);
        const btn = document.getElementById('themeToggle');
        if (btn) btn.textContent = mode === 'dark' ? '☀' : '☾';
        if (btn) btn.title = mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
      };

      // ── Favicon + title ─────────────────────────────────────
      const setFavicon = (status) => {
        const c = STATUS_FAVICON_COLOR[status] || STATUS_FAVICON_COLOR.unknown;
        const svg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='" + c + "'/%3E%3C/svg%3E";
        const el = document.getElementById('favicon');
        if (el) el.href = svg;
      };
      const setTitle = (project, status) => {
        const prefix = STATUS_TITLE_PREFIX[status] || '';
        document.title = prefix + (project || 'Marmite') + ' Dashboard';
      };

      // ── Notifications ──────────────────────────────────────
      let notifiedStatus = null;
      const maybeNotify = (status, project) => {
        if (!('Notification' in window)) return;
        if (notifiedStatus === null) { notifiedStatus = status; return; }
        if (status === notifiedStatus) return;
        notifiedStatus = status;
        // Only notify on terminal/halt transitions, not when entering in_progress.
        if (status !== 'completed' && status !== 'failed' && status !== 'halted') return;
        if (Notification.permission === 'granted') {
          try {
            new Notification('Marmite — ' + (STATUS_LABEL[status] || status), {
              body: project || 'Run state changed',
              tag: 'marmite-dashboard',
            });
          } catch {}
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission().catch(() => {});
        }
      };

      // ── Top-level render ────────────────────────────────────
      let lastData = null;
      let lastStatus = null;

      const safeRender = (d) => {
        if (!d) return;
        const status = (typeof d.status === 'string') ? d.status : 'unknown';
        const project = typeof d.project === 'string' ? d.project : null;

        if (d.source && projectNs === 'default') {
          setProjectNs(d.source);
          // Re-prime filter/theme state once we know the namespace.
          const storedTheme = ls.get('theme');
          if (storedTheme) applyTheme(storedTheme);
        }

        // Header text — small, do it directly.
        document.getElementById('title').textContent = project ? '🚀 ' + project : '🚀 Marmite Dashboard';
        const live = status === 'in_progress' ? '<span class="live-dot"></span>' : '';
        const workflowBit = d.config && d.config.workflow
          ? ' · Workflow: <code>' + escape(d.config.workflow) + '</code>'
          : '';
        // marmite refactor runs surface a distinct chip so the user can tell
        // a one-shot maintenance pass apart from a normal cook run at a glance.
        const modeBit = d.runMode === 'maintenance'
          ? ' · <span class="mode-badge maintenance" title="One-shot maintenance pass (marmite refactor)">🧹 Maintenance</span>'
          : '';
        document.getElementById('meta').innerHTML = live
          + 'Run ID: <code>' + escape(d.runId || 'n/a') + '</code>'
          + workflowBit
          + modeBit;

        renderInto('haltBanner',  d.halt, renderHaltBanner.bind(null, d));
        renderInto('usageLimitBanner', d.usageLimit, () => renderUsageLimitBanner(d));
        renderInto('currentTask', d.currentTask, renderCurrentTask);
        renderInto('summary',     { d: { status, total: d.totalCostUsd, passed: d.storiesPassed, of: d.storiesTotal, dur: d.durationMs, started: d.startedAt, budget: d.config && d.config.budget } }, () => renderSummary(d));
        renderInto('sparkline',   d.stories ? d.stories.map((s) => [s.storyId, s.totalCostUsd, s.passed]) : null, () => renderSparkline(d));
        renderInto('configPanel', { config: d.config, github: d.githubSlug, src: d.configSource }, () => renderConfigPanel(d));
        renderInto('sensorHealth', d.sensorHealth, () => renderSensorHealth(d));
        renderInto('content',     d.epics, () => renderEpicMain(d));
        renderInto('patternsWrap', d.patterns, () => renderPatterns(d.patterns));
        renderInto('pipeline',     { epics: d.epics, collapsed: [...ls.getSet('collapsed-epics')] }, () => renderPipeline(d));

        const subtitleEl = document.getElementById('sidebarSubtitle');
        if (subtitleEl) {
          const passed = d.storiesPassed || 0;
          const total = d.storiesTotal || 0;
          subtitleEl.textContent = passed + ' / ' + total + ' passed' + (project ? ' · ' + project : '');
        }
        const started = d.startedAt ? new Date(d.startedAt).toLocaleString() : 'unknown';
        document.getElementById('footer').innerHTML =
          'Source: ' + escape(d.source || 'n/a')
          + ' · Started ' + escape(started)
          + ' · Status: ' + (STATUS_LABEL[status] || status);

        // Jump-to-current button enables only when there's something to jump to.
        const jumpBtn = document.getElementById('jumpBtn');
        if (jumpBtn) jumpBtn.disabled = !d.currentTask;

        setFavicon(status);
        setTitle(project, status);
        maybeNotify(status, project);

        lastStatus = status;
      };

      // ── Click handlers ─────────────────────────────────────
      // Sidebar/theme toggles
      const sidebar = document.getElementById('sidebar');
      const sbToggle = document.getElementById('sidebarToggle');
      if (ls.get('sidebar-collapsed') === '1') {
        sidebar.classList.add('collapsed');
        sbToggle.textContent = '›';
      }
      sbToggle.addEventListener('click', () => {
        const collapsed = sidebar.classList.toggle('collapsed');
        sbToggle.textContent = collapsed ? '›' : '‹';
        ls.set('sidebar-collapsed', collapsed ? '1' : '0');
      });

      const themeBtn = document.getElementById('themeToggle');
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      const initialTheme = ls.get('theme') || (prefersDark ? 'dark' : 'light');
      applyTheme(initialTheme);
      themeBtn.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') || 'light';
        applyTheme(cur === 'dark' ? 'light' : 'dark');
      });

      // Mobile sidebar
      const mobileToggle = document.getElementById('mobileToggle');
      mobileToggle.addEventListener('click', () => {
        sidebar.classList.toggle('mobile-open');
      });
      sidebar.addEventListener('click', (e) => {
        if (e.target.closest('[data-story]')) {
          sidebar.classList.remove('mobile-open');
        }
      });

      // Jump-to-current
      document.getElementById('jumpBtn').addEventListener('click', () => {
        const ct = lastData && lastData.currentTask;
        if (!ct) return;
        const card = document.getElementById('story-' + ct.storyId);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });

      // Details toggle persistence
      document.addEventListener('toggle', (ev) => {
        const el = ev.target;
        if (!(el instanceof HTMLDetailsElement)) return;
        const detailsId = el.getAttribute('data-story-details');
        if (detailsId) {
          const open = ls.getSet('open-details');
          if (el.open) open.add(detailsId); else open.delete(detailsId);
          ls.setSet('open-details', open);
          return;
        }
        const resultsId = el.getAttribute('data-results-details');
        if (resultsId) {
          const open = ls.getSet('open-results');
          if (el.open) open.add(resultsId); else open.delete(resultsId);
          ls.setSet('open-results', open);
          return;
        }
        if (el.id === 'patternsDetails') {
          ls.set('patterns-open', el.open ? '1' : '0');
        }
      }, true);

      // Epic toggle
      document.addEventListener('click', (ev) => {
        const header = ev.target.closest && ev.target.closest('[data-toggle-epic]');
        if (header) {
          const slug = header.getAttribute('data-toggle-epic');
          const collapsedSet = ls.getSet('collapsed-epics');
          if (collapsedSet.has(slug)) collapsedSet.delete(slug); else collapsedSet.add(slug);
          ls.setSet('collapsed-epics', collapsedSet);
          document.querySelectorAll('[data-epic="' + CSS.escape(slug) + '"], [data-epic-main="' + CSS.escape(slug) + '"]').forEach((el) => {
            el.classList.toggle('collapsed', collapsedSet.has(slug));
          });
          return;
        }
        const copyBtn = ev.target.closest && ev.target.closest('#copyResumeBtn');
        if (copyBtn) {
          navigator.clipboard.writeText('marmite cook').then(() => {
            copyBtn.classList.add('done');
            const old = copyBtn.textContent;
            copyBtn.textContent = '✓ Copied';
            setTimeout(() => {
              copyBtn.classList.remove('done');
              copyBtn.textContent = old;
            }, 1500);
          }).catch(() => {
            copyBtn.textContent = '✗ Copy failed';
          });
          return;
        }
      });

      // ── Live ticker ────────────────────────────────────────
      // Updates duration spans every second so the user sees the clock
      // increment without waiting for the next poll. Two modes:
      //   - from-start: just (now - data-live-start)
      //   - anchored:   base + (now - data-live-anchor) — for cumulative
      //                 durations where base is the server-computed total at
      //                 a known anchor timestamp.
      //   - countdown:  max(0, data-live-deadline - now) — for usage-limit
      //                 pause banners ticking down to resume.
      setInterval(() => {
        document.querySelectorAll('.js-live-duration').forEach((el) => {
          const mode = el.getAttribute('data-live-mode');
          if (mode === 'from-start') {
            const start = parseInt(el.getAttribute('data-live-start') || '0', 10);
            if (!start) return;
            el.textContent = fmtDur(Date.now() - start);
          } else if (mode === 'anchored') {
            const base = parseInt(el.getAttribute('data-live-base') || '0', 10);
            const anchor = parseInt(el.getAttribute('data-live-anchor') || '0', 10);
            if (!anchor) return;
            el.textContent = fmtDur(base + (Date.now() - anchor));
          } else if (mode === 'countdown') {
            const deadline = parseInt(el.getAttribute('data-live-deadline') || '0', 10);
            if (!deadline) return;
            el.textContent = fmtDur(Math.max(0, deadline - Date.now()));
          }
        });
      }, 1000);

      // ── Adaptive polling ───────────────────────────────────
      // 3s when in-progress, 15s otherwise, paused when the tab is hidden.
      let pollTimer = null;
      const pollInterval = () => {
        if (document.hidden) return null;
        return (lastStatus === 'in_progress') ? 3000 : 15000;
      };
      const schedule = () => {
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        const ivl = pollInterval();
        if (ivl == null) return;
        pollTimer = setTimeout(tick, ivl);
      };
      async function tick() {
        try {
          const r = await fetch('/api/dashboard', { cache: 'no-store' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const data = await r.json();
          lastData = data;
          safeRender(data);
        } catch (e) {
          document.getElementById('meta').innerHTML =
            '<span style="color:var(--danger)">Error: ' + escape((e && e.message) || String(e)) + '</span>';
        } finally {
          schedule();
        }
      }
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        } else {
          tick();
        }
      });
      tick();
    </script>
</body>
</html>`;

function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // Best-effort — if no GUI/`open` is available, the user can still copy the URL.
  }
}

export async function runDashboard(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  const marmiteDir = dirname(args.path);
  const prdPath = resolve(marmiteDir, "prd.json");
  const progressPath = resolve(marmiteDir, "progress.json");
  const currentTaskPath = resolve(marmiteDir, "current-task.json");
  // marmite.json lives one directory up from .marmite/ in the project root.
  const projectRoot = dirname(marmiteDir);
  const configPath = resolve(projectRoot, "marmite.json");
  // Resolve the GitHub slug once on startup. The remote URL doesn't change
  // mid-run, and shelling out per request would slow the dashboard down.
  const githubSlug = readGitHubSlug(projectRoot);

  const server = Bun.serve({
    port: args.port,
    hostname: args.host,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(INDEX_HTML, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/api/dashboard") {
        const events = readEvents(args.path);
        const prd = readPrd(prdPath);
        const progress = readProgress(progressPath);
        const currentTask = readCurrentTask(currentTaskPath);
        const config = readMarmiteConfig(configPath);
        const dash = buildDashboard(
          events,
          prd,
          progress,
          currentTask,
          config,
          githubSlug,
          projectRoot,
          args.path,
          prd ? prdPath : null,
          progress ? progressPath : null,
          config ? configPath : null,
        );
        return new Response(JSON.stringify(dash), {
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/api/events.jsonl") {
        if (!existsSync(args.path)) return new Response("", { headers: { "content-type": "application/x-ndjson" } });
        return new Response(readFileSync(args.path), {
          headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const displayHost = args.host === "0.0.0.0" ? "127.0.0.1" : args.host;
  const url = `http://${displayHost}:${server.port}`;
  console.log(`Marmite dashboard serving ${args.path}`);
  if (existsSync(prdPath)) console.log(`  prd:      ${prdPath}`);
  if (existsSync(progressPath)) console.log(`  progress: ${progressPath}`);
  if (existsSync(configPath)) console.log(`  config:   ${configPath}`);
  if (githubSlug) console.log(`  github:   ${githubSlug}`);
  console.log(`  → ${url}`);
  console.log(`  Press Ctrl-C to stop.`);
  if (args.open) openInBrowser(url);

  // Block forever so main.ts does not fall through into the cook path. Bun.serve
  // keeps the event loop alive on its own, but main.ts continues after this
  // returns; awaiting a never-resolving promise pins the process here.
  await new Promise<never>(() => {});
}
