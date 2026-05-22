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
  kind: "story" | "janitor" | "unknown";
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
    ctKind === "janitor" || ctKind === "story"
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
  const runEnd = [...currentRunEvents].reverse().find((e) => e.kind === "run_end");
  // `run_halt` is emitted by the orchestrator before `process.exit(0)`, so
  // there's no `run_end` after it. Surface this state distinctly.
  const runHalt = [...currentRunEvents].reverse().find((e) => e.kind === "run_halt");
  // A run_halt is "current" only if no later run_start/run_end has happened
  // (run_start would mean we resumed; run_end would override the halt anyway).
  const haltIsCurrent = runHalt && !runEnd;

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
  }

  const startedAt = typeof runStart?.ts === "string" ? runStart.ts : null;
  const endedAt = typeof runEnd?.ts === "string" ? runEnd.ts : null;

  let durationMs: number | null = null;
  if (startedAt) {
    const start = Date.parse(startedAt);
    const end = endedAt ? Date.parse(endedAt) : halt?.at ? Date.parse(halt.at) : Date.now();
    if (!isNaN(start) && !isNaN(end)) durationMs = end - start;
  }

  const status: Dashboard["status"] = runEnd
    ? (runEnd.passed === false || (typeof runEnd.exitCode === "number" && runEnd.exitCode !== 0)
        ? "failed"
        : "completed")
    : halt
      ? "halted"
      : runStart
        ? "in_progress"
        : "unknown";

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
        ? deriveCurrentTask(events, runId, currentTaskFile)
        : null,
    patterns: progress?.patterns ?? [],
    totalEvents: events.length,
    iteration,
    config,
    configSource,
    githubSlug,
    halt,
  };
}

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Marmite Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
        }

        /* ── Sidebar ─────────────────────────────────────────────── */
        .sidebar {
            width: 320px;
            min-width: 320px;
            background: rgba(255,255,255,0.96);
            box-shadow: 4px 0 20px rgba(0,0,0,0.1);
            padding: 20px 0;
            position: sticky;
            top: 0;
            height: 100vh;
            overflow-y: auto;
            transition: min-width 0.25s ease, width 0.25s ease, padding 0.25s ease;
        }
        .sidebar.collapsed { width: 48px; min-width: 48px; padding: 20px 0; }
        .sidebar.collapsed .sidebar-body { display: none; }
        .sidebar-toggle {
            width: 32px; height: 32px; margin: 0 8px 12px auto; display: block;
            background: #667eea; color: white; border: none; border-radius: 6px;
            cursor: pointer; font-size: 16px; line-height: 1;
        }
        .sidebar.collapsed .sidebar-toggle { margin: 0 auto 12px auto; }
        .sidebar-header {
            padding: 0 20px 12px 20px;
            border-bottom: 1px solid #eee;
            margin-bottom: 12px;
        }
        .sidebar-header h2 { font-size: 14px; color: #333; text-transform: uppercase; letter-spacing: 1px; }
        .sidebar-header .subtitle { font-size: 12px; color: #777; margin-top: 4px; }
        .epic-group { margin-bottom: 6px; }
        .epic-group-header {
            display: flex; align-items: center; gap: 6px;
            padding: 8px 12px; margin: 8px 0 4px 0;
            font-size: 11px; font-weight: 700; color: #555;
            text-transform: uppercase; letter-spacing: 0.8px;
            cursor: pointer; user-select: none;
            border-radius: 6px;
        }
        .epic-group-header:hover { background: #f3f4f6; }
        .epic-caret { font-size: 10px; color: #888; transition: transform 0.2s; display: inline-block; width: 10px; }
        .epic-group.collapsed .epic-caret { transform: rotate(-90deg); }
        .epic-group.collapsed .epic-items,
        .epic-group.collapsed .epic-main-grid { display: none; }
        .epic-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .epic-count { font-size: 10px; color: #888; font-weight: 600; }
        .epic-count.complete { color: #22c55e; }
        .pipeline { padding: 0 8px; }
        .epic-items { padding: 0 4px; }
        .pipeline-item {
            position: relative;
            display: flex; align-items: flex-start; gap: 10px;
            padding: 10px 8px 10px 8px;
            border-radius: 6px;
            cursor: pointer;
            transition: background 0.15s;
            text-decoration: none;
            color: inherit;
        }
        .pipeline-item:hover { background: #f3f4f6; }
        .pipeline-item.active { background: #eef2ff; }
        .pipeline-item:not(:last-child)::after {
            content: '';
            position: absolute;
            left: 19px; top: 32px; bottom: -2px;
            width: 2px; background: #e5e7eb;
            z-index: 0;
        }
        .pipeline-icon {
            width: 22px; height: 22px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 12px; font-weight: 700; color: white;
            flex-shrink: 0;
            z-index: 1; position: relative;
        }
        .pipeline-icon.pass { background: #22c55e; }
        .pipeline-icon.fail { background: #ef4444; }
        .pipeline-icon.pending { background: #d1d5db; color: #4b5563; }
        .pipeline-icon.active-run { background: #eab308; box-shadow: 0 0 0 4px rgba(234,179,8,0.25); }
        .pipeline-icon.janitor { background: #8b5cf6; }
        .pipeline-text { flex: 1; min-width: 0; }
        .pipeline-id { font-size: 11px; font-weight: 700; color: #667eea; text-transform: uppercase; }
        .pipeline-title {
            font-size: 13px; color: #333; line-height: 1.3; margin-top: 2px;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }

        /* ── Main ────────────────────────────────────────────────── */
        .main {
            flex: 1;
            padding: 40px 20px;
            min-width: 0;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        header {
            background: white; border-radius: 12px; padding: 30px; margin-bottom: 30px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.1);
        }
        h1 { color: #333; margin-bottom: 8px; font-size: 28px; }
        .meta { color: #666; font-size: 13px; margin-bottom: 20px; }
        .meta code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 11px; }
        .summary-grid {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 16px; margin-top: 20px;
        }
        .summary-card {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white; padding: 18px; border-radius: 8px; text-align: center;
        }
        .summary-card h3 {
            font-size: 13px; opacity: 0.9; margin-bottom: 8px;
            text-transform: uppercase; letter-spacing: 1px;
        }
        .summary-card .value { font-size: 28px; font-weight: bold; }
        .summary-card.success { background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); }
        .summary-card.warning { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); }
        .summary-card.danger  { background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%); }
        .summary-card.halted  { background: linear-gradient(135deg, #f59e0b 0%, #b45309 100%); }
        .halt-banner {
            background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
            border: 2px solid #f59e0b;
            border-radius: 12px;
            padding: 18px 22px;
            margin-bottom: 20px;
            display: flex;
            gap: 16px;
            align-items: flex-start;
            box-shadow: 0 6px 20px rgba(245,158,11,0.2);
        }
        .halt-banner-icon {
            font-size: 28px;
            line-height: 1;
            margin-top: 2px;
        }
        .halt-banner-body { flex: 1; min-width: 0; }
        .halt-banner-label {
            font-size: 11px; font-weight: 700; color: #92400e;
            text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px;
        }
        .halt-banner-title { font-size: 17px; font-weight: 700; color: #1f2937; line-height: 1.3; }
        .halt-banner-meta {
            display: flex; flex-wrap: wrap; gap: 12px;
            margin-top: 8px; font-size: 13px; color: #4b5563;
        }
        .halt-banner-meta strong { color: #1f2937; font-weight: 600; }
        .halt-banner-meta a {
            color: #1d4ed8; text-decoration: none; font-weight: 600;
            background: rgba(255,255,255,0.7); padding: 3px 10px; border-radius: 12px;
        }
        .halt-banner-meta a:hover { background: rgba(255,255,255,1); text-decoration: underline; }
        .halt-banner-story, .halt-banner-next {
            margin-top: 10px;
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
            font-size: 13px;
            color: #1f2937;
        }
        .halt-banner-story-label, .halt-banner-next-label {
            font-size: 10px;
            font-weight: 700;
            color: #92400e;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            background: rgba(255,255,255,0.7);
            padding: 3px 8px;
            border-radius: 10px;
            white-space: nowrap;
        }
        .halt-banner-next-label { color: #1e40af; }
        .halt-banner-story-link, .halt-banner-next-link {
            color: #1f2937;
            text-decoration: none;
        }
        .halt-banner-story-link:hover, .halt-banner-next-link:hover { text-decoration: underline; }
        .halt-banner-next-epic {
            font-size: 11px;
            color: #4b5563;
            background: rgba(255,255,255,0.5);
            padding: 2px 8px;
            border-radius: 10px;
        }
        .config-panel {
            background: rgba(255,255,255,0.92);
            border-radius: 10px;
            padding: 14px 18px;
            margin-top: 16px;
            font-size: 13px;
            color: #1f2937;
        }
        .config-panel-header {
            font-size: 11px; font-weight: 700; color: #4b5563;
            text-transform: uppercase; letter-spacing: 1px;
            margin-bottom: 8px;
            display: flex; justify-content: space-between; align-items: baseline;
        }
        .config-panel-header code { background: #f3f4f6; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 500; }
        .config-grid {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 10px 18px;
        }
        .config-row { display: flex; flex-direction: column; }
        .config-row-label {
            font-size: 10px; font-weight: 600; color: #6b7280;
            text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;
        }
        .config-row-value { font-size: 13px; color: #1f2937; word-break: break-word; }
        .config-row-value code {
            background: #f3f4f6; padding: 1px 6px; border-radius: 3px;
            font-size: 12px; font-family: ui-monospace, SFMono-Regular, monospace;
        }
        .config-tag {
            display: inline-block;
            background: #eef2ff; color: #4338ca;
            font-size: 11px; font-weight: 600;
            padding: 2px 8px; border-radius: 10px; margin-right: 4px;
        }
        .config-workflow-badge {
            display: inline-block;
            background: #1e293b; color: #f8fafc;
            font-size: 12px; font-weight: 700;
            padding: 3px 10px; border-radius: 12px;
            text-transform: uppercase; letter-spacing: 0.5px;
        }
        .stories-grid {
            display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
            gap: 20px; margin-top: 16px;
        }
        .epic-main {
            background: rgba(255,255,255,0.08);
            border-radius: 12px;
            padding: 20px;
            margin-top: 24px;
        }
        .epic-main-header {
            display: flex; align-items: center; justify-content: space-between;
            color: white; cursor: pointer; user-select: none;
            padding-bottom: 8px;
        }
        .epic-main-title { font-size: 18px; font-weight: 700; letter-spacing: 0.5px; }
        .epic-main-meta { font-size: 13px; opacity: 0.85; }
        .epic-main .epic-caret { color: rgba(255,255,255,0.85); font-size: 14px; }
        .epic-progress {
            height: 4px; background: rgba(255,255,255,0.25); border-radius: 2px; overflow: hidden;
            margin-top: 6px;
        }
        .epic-progress-bar { height: 100%; background: #22c55e; transition: width 0.4s; }
        .story-card {
            background: white; border-radius: 12px; overflow: hidden;
            box-shadow: 0 10px 40px rgba(0,0,0,0.1);
            transition: transform 0.3s, box-shadow 0.3s;
            scroll-margin-top: 20px;
        }
        .story-card:target { box-shadow: 0 0 0 3px #667eea, 0 10px 40px rgba(0,0,0,0.1); }
        .story-card:hover { transform: translateY(-3px); box-shadow: 0 15px 50px rgba(0,0,0,0.15); }
        .story-header {
            padding: 18px 20px; border-bottom: 2px solid #eee;
            display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;
        }
        .story-header.passed { background: #f0fdf4; border-bottom-color: #22c55e; }
        .story-header.failed { background: #fef2f2; border-bottom-color: #ef4444; }
        .story-header.pending { background: #fefce8; border-bottom-color: #eab308; }
        .story-id { font-size: 13px; font-weight: 600; color: #667eea; text-transform: uppercase; }
        .story-title { font-size: 15px; font-weight: 600; color: #333; margin: 6px 0 0 0; line-height: 1.4; }
        .story-epic { font-size: 11px; color: #888; margin-top: 4px; }
        .badge {
            display: inline-block; padding: 5px 10px; border-radius: 20px;
            font-size: 11px; font-weight: 600; text-transform: uppercase;
            letter-spacing: 0.5px; white-space: nowrap;
        }
        .badge.pass    { background: #22c55e; color: white; }
        .badge.fail    { background: #ef4444; color: white; }
        .badge.pending { background: #eab308; color: white; }
        .badge.idle    { background: #d1d5db; color: #4b5563; }
        .phases { padding: 18px 20px; }
        .phase { margin-bottom: 18px; padding-bottom: 18px; border-bottom: 1px solid #eee; }
        .phase:last-of-type { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
        .phase-name {
            font-size: 11px; font-weight: 700; color: #667eea;
            text-transform: uppercase; margin-bottom: 8px; letter-spacing: 1px;
        }
        .phase-metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; font-size: 13px; }
        .metric { padding: 7px 9px; background: #f5f5f5; border-radius: 6px; }
        .metric-label { color: #666; font-size: 10px; text-transform: uppercase; margin-bottom: 3px; }
        .metric-value { color: #333; font-weight: 600; font-size: 13px; }
        .qa-results { display: flex; gap: 10px; font-size: 13px; margin-top: 8px; }
        .qa-pass { color: #22c55e; font-weight: 600; }
        .qa-fail { color: #ef4444; font-weight: 600; }
        .cost { color: #f97316; font-weight: 600; }
        .totals { padding: 14px 20px; border-top: 1px solid #eee; font-weight: 600; font-size: 13px; background: #fafafa; }
        .summary-block {
            padding: 14px 20px; background: #f9fafb; border-top: 1px solid #eee;
            font-size: 12px; color: #444; line-height: 1.5; white-space: pre-wrap;
            max-height: 200px; overflow-y: auto;
        }
        .commits { padding: 10px 20px 14px 20px; font-size: 11px; color: #6b7280; background: #f9fafb; }
        .commits code { background: #e5e7eb; padding: 1px 5px; border-radius: 3px; font-size: 11px; }
        .story-details { border-top: 1px solid #eee; background: #fafbff; }
        .story-details > summary {
            list-style: none;
            cursor: pointer;
            padding: 10px 20px;
            font-size: 11px;
            font-weight: 700;
            color: #4f46e5;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            display: flex;
            align-items: center;
            gap: 8px;
            user-select: none;
        }
        .story-details > summary::-webkit-details-marker { display: none; }
        .story-details > summary::before {
            content: '▸';
            display: inline-block;
            font-size: 10px;
            color: #6366f1;
            transition: transform 0.2s;
        }
        .story-details[open] > summary::before { transform: rotate(90deg); }
        .story-details > summary:hover { background: #eef2ff; }
        .story-details-body {
            padding: 4px 20px 18px 20px;
            font-size: 13px;
            color: #1f2937;
            line-height: 1.55;
        }
        .story-details-section { margin-top: 12px; }
        .story-details-section:first-child { margin-top: 4px; }
        .story-details-label {
            font-size: 10px;
            font-weight: 700;
            color: #6366f1;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            margin-bottom: 6px;
        }
        .story-details-text {
            color: #1f2937;
            white-space: pre-wrap;
            font-size: 13px;
            line-height: 1.6;
        }
        .story-details-criteria {
            list-style: none;
            padding: 0;
            margin: 0;
        }
        .story-details-criteria li {
            position: relative;
            padding: 4px 0 4px 22px;
            font-size: 13px;
            color: #1f2937;
            line-height: 1.5;
        }
        .story-details-criteria li::before {
            content: '○';
            position: absolute;
            left: 4px;
            top: 4px;
            color: #9ca3af;
            font-weight: 700;
        }
        .story-details-criteria li.pass::before { content: '✓'; color: #16a34a; }
        .story-details-criteria li.fail::before { content: '✗'; color: #dc2626; }

        /* ── Run results expandable ───────────────────────────── */
        .story-results { border-top: 1px solid #eee; background: #f9fafb; }
        .story-results > summary {
            list-style: none;
            cursor: pointer;
            padding: 10px 20px;
            font-size: 11px;
            font-weight: 700;
            color: #047857;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            display: flex;
            align-items: center;
            gap: 8px;
            user-select: none;
        }
        .story-results > summary::-webkit-details-marker { display: none; }
        .story-results > summary::before {
            content: '▸';
            display: inline-block;
            font-size: 10px;
            color: #10b981;
            transition: transform 0.2s;
        }
        .story-results[open] > summary::before { transform: rotate(90deg); }
        .story-results > summary:hover { background: #ecfdf5; }
        .story-results-summary-meta {
            margin-left: auto;
            font-size: 10px;
            font-weight: 600;
            color: #6b7280;
            text-transform: none;
            letter-spacing: 0;
        }
        .story-results-summary-meta .diff-add { color: #16a34a; }
        .story-results-summary-meta .diff-del { color: #dc2626; }
        .story-results-body { padding: 0; }
        .results-section { padding: 12px 20px; border-top: 1px solid #eef2f7; }
        .results-section:first-child { border-top: none; }
        .results-section-label {
            font-size: 10px;
            font-weight: 700;
            color: #047857;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            margin-bottom: 8px;
        }
        .results-summary-text {
            font-size: 13px;
            color: #1f2937;
            line-height: 1.55;
            white-space: pre-wrap;
            max-height: 240px;
            overflow-y: auto;
        }
        .commit-list { display: flex; flex-direction: column; gap: 10px; }
        .commit-stat {
            background: white;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 10px 12px;
        }
        .commit-stat-header {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
            margin-bottom: 8px;
        }
        .commit-stat-sha {
            background: #1f2937;
            color: #f9fafb;
            padding: 2px 7px;
            border-radius: 4px;
            font-size: 11px;
            font-family: ui-monospace, SFMono-Regular, monospace;
        }
        .commit-stat-subject {
            font-size: 13px;
            color: #111827;
            font-weight: 500;
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .commit-stat-summary {
            font-size: 11px;
            color: #6b7280;
            font-family: ui-monospace, SFMono-Regular, monospace;
            white-space: nowrap;
        }
        .commit-stat-files {
            display: flex;
            flex-direction: column;
            gap: 3px;
        }
        .diff-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr) 44px 44px 100px;
            align-items: center;
            gap: 8px;
            font-size: 12px;
            font-family: ui-monospace, SFMono-Regular, monospace;
        }
        .diff-file {
            color: #1f2937;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            direction: rtl;
            text-align: left;
        }
        .diff-count { text-align: right; font-weight: 600; font-size: 11px; }
        .diff-add { color: #16a34a; }
        .diff-del { color: #dc2626; }
        .diff-binary {
            grid-column: 2 / span 3;
            justify-self: end;
            color: #6b7280;
            font-style: italic;
            font-size: 11px;
        }
        .diff-bar {
            display: inline-flex;
            height: 8px;
            background: #f1f5f9;
            border-radius: 2px;
            overflow: hidden;
        }
        .diff-bar-add { background: #22c55e; height: 100%; }
        .diff-bar-del { background: #ef4444; height: 100%; }
        .results-phases { padding: 0 20px 12px 20px; }
        .results-phases .phase { margin: 0 0 14px 0; padding: 0 0 14px 0; }
        .results-phases .phase:last-child { margin-bottom: 0; padding-bottom: 0; }
        .results-total {
            margin-top: 4px;
            font-size: 12px;
            color: #4b5563;
        }
        .empty {
            background: white; border-radius: 12px; padding: 40px; text-align: center;
            box-shadow: 0 10px 40px rgba(0,0,0,0.1); color: #666;
        }
        .section-title { color: white; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; margin: 32px 0 12px 0; opacity: 0.9; }
        .patterns {
            background: white; border-radius: 12px; padding: 20px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.1);
        }
        .pattern { padding: 10px 0; border-bottom: 1px solid #f3f4f6; }
        .pattern:last-child { border-bottom: none; }
        .pattern-name { font-weight: 600; color: #333; font-size: 13px; }
        .pattern-tag { font-size: 10px; color: #888; margin-left: 8px; }
        .pattern-desc { font-size: 12px; color: #555; margin-top: 4px; line-height: 1.5; }
        .current-task {
            background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
            border: 1px solid #fcd34d;
            border-radius: 10px;
            padding: 16px 20px;
            margin: 18px 0 4px 0;
            display: flex;
            gap: 16px;
            align-items: flex-start;
        }
        .current-task.janitor { background: linear-gradient(135deg, #ede9fe 0%, #ddd6fe 100%); border-color: #c4b5fd; }
        .current-task-spinner {
            width: 28px; height: 28px; flex-shrink: 0;
            border: 3px solid rgba(0,0,0,0.1);
            border-top-color: #ef4444;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-top: 2px;
        }
        .current-task.janitor .current-task-spinner { border-top-color: #8b5cf6; }
        .current-task-body { flex: 1; min-width: 0; }
        .current-task-label {
            font-size: 11px; font-weight: 700; color: #92400e;
            text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px;
        }
        .current-task.janitor .current-task-label { color: #5b21b6; }
        .current-task-title { font-size: 16px; font-weight: 700; color: #1f2937; line-height: 1.4; }
        .current-task-id { font-size: 12px; color: #6b7280; font-weight: 600; }
        .current-task-meta {
            display: flex; flex-wrap: wrap; gap: 14px; margin-top: 8px;
            font-size: 13px; color: #4b5563;
        }
        .current-task-meta strong { color: #1f2937; font-weight: 600; }
        .current-task-phase {
            display: inline-flex; align-items: center; gap: 6px;
            background: rgba(255,255,255,0.7);
            padding: 3px 10px; border-radius: 12px;
            font-weight: 600; font-size: 12px; color: #1f2937;
            text-transform: uppercase; letter-spacing: 0.5px;
        }
        .current-task-reasoning {
            margin-top: 8px;
            font-size: 12px;
            color: #4b5563;
            line-height: 1.5;
            background: rgba(255,255,255,0.4);
            padding: 8px 10px;
            border-radius: 6px;
        }
        .current-task-section {
            margin-top: 10px;
            font-size: 12px;
            background: rgba(255,255,255,0.4);
            padding: 8px 10px;
            border-radius: 6px;
        }
        .current-task-section-label {
            font-size: 10px;
            font-weight: 700;
            color: #92400e;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            margin-bottom: 4px;
        }
        .current-task.janitor .current-task-section-label { color: #5b21b6; }
        .current-task-section-body { color: #1f2937; line-height: 1.5; white-space: pre-wrap; }
        .current-task-description {
            font-size: 13px;
            color: #1f2937;
            line-height: 1.5;
            margin-top: 8px;
        }
        .current-task-criteria { list-style: none; padding: 0; margin: 4px 0 0 0; }
        .current-task-criteria li {
            font-size: 12px; color: #1f2937; line-height: 1.5;
            padding: 3px 0 3px 22px; position: relative;
        }
        .current-task-criteria li::before {
            content: '○'; position: absolute; left: 4px; top: 3px;
            color: #9ca3af; font-weight: 700;
        }
        .current-task-criteria li.pass::before { content: '✓'; color: #16a34a; }
        .current-task-criteria li.fail::before { content: '✗'; color: #dc2626; }
        .current-task-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
        .current-task-tag {
            font-size: 11px; font-weight: 600;
            background: rgba(255,255,255,0.7);
            color: #1f2937;
            padding: 2px 8px; border-radius: 10px;
        }
        .current-task-verdict {
            display: inline-block;
            font-size: 11px; font-weight: 700;
            padding: 3px 10px; border-radius: 12px;
            text-transform: uppercase; letter-spacing: 0.5px;
            margin-left: 8px;
        }
        .current-task-verdict.pass { background: #22c55e; color: white; }
        .current-task-verdict.fail_retry { background: #eab308; color: white; }
        .current-task-verdict.fail_abort { background: #ef4444; color: white; }
        .current-task-halt {
            margin-top: 10px;
            font-size: 12px;
            background: #fee2e2;
            color: #991b1b;
            padding: 8px 10px;
            border-radius: 6px;
            border: 1px solid #fca5a5;
        }
        .current-task-halt strong { color: #7f1d1d; }
        @keyframes spin { to { transform: rotate(360deg); } }
        footer { text-align: center; color: white; margin-top: 32px; font-size: 13px; opacity: 0.85; }
        .live-dot {
            display: inline-block; width: 8px; height: 8px; background: #22c55e;
            border-radius: 50%; margin-right: 6px; animation: pulse 1.6s infinite;
        }
        @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.3 } }

        @media (max-width: 720px) {
            body { display: block; }
            .sidebar { width: 100%; min-width: 0; height: auto; position: static; box-shadow: none; }
            .sidebar.collapsed { display: none; }
        }
    </style>
</head>
<body>
    <aside class="sidebar" id="sidebar">
        <button class="sidebar-toggle" id="sidebarToggle" title="Collapse sidebar">‹</button>
        <div class="sidebar-body">
            <div class="sidebar-header">
                <h2>Pipeline</h2>
                <div class="subtitle" id="sidebarSubtitle">—</div>
            </div>
            <nav class="pipeline" id="pipeline"></nav>
        </div>
    </aside>
    <div class="main">
        <div class="container">
            <header>
                <h1 id="title">🚀 Marmite Dashboard</h1>
                <div class="meta" id="meta"><span class="live-dot"></span>Loading…</div>
                <div id="haltBanner"></div>
                <div id="currentTask"></div>
                <div class="summary-grid" id="summary"></div>
                <div id="configPanel"></div>
            </header>
            <div id="content"></div>
            <div id="patternsWrap"></div>
            <footer id="footer"></footer>
        </div>
    </div>
    <script>
      const fmtDur = (ms) => {
        if (ms == null) return '—';
        if (ms < 1000) return ms.toFixed(0) + 'ms';
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

      const STATUS_LABEL = { in_progress: 'In Progress', completed: 'Completed', failed: 'Failed', halted: 'Halted', unknown: 'Unknown' };
      const STATUS_CLASS = { in_progress: 'warning', completed: 'success', failed: 'danger', halted: 'halted', unknown: '' };
      const HALT_LABEL = { awaiting_pr_review: 'Awaiting PR Review' };

      const storyState = (s) => s.passed === true ? 'passed' : s.passed === false ? 'failed' : 'pending';

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
        return '<div class="phase">'
          + '<div class="phase-name">' + phaseLabel + '</div>'
          + '<div class="phase-metrics">'
          + metrics.map(([k, v]) => '<div class="metric"><div class="metric-label">' + k + '</div><div class="metric-value">' + v + '</div></div>').join('')
          + '</div>' + qa + '</div>';
      };

      const OPEN_DETAILS_KEY = 'marmite-dashboard-open-details';
      const getOpenDetails = () => {
        try { return new Set(JSON.parse(localStorage.getItem(OPEN_DETAILS_KEY) || '[]')); }
        catch { return new Set(); }
      };
      const setOpenDetails = (set) => {
        localStorage.setItem(OPEN_DETAILS_KEY, JSON.stringify([...set]));
      };

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
          const items = s.acceptanceCriteria.map((c) =>
            '<li>' + escape(c) + '</li>'
          ).join('');
          sections.push(
            '<div class="story-details-section">'
            + '<div class="story-details-label">Acceptance Criteria</div>'
            + '<ul class="story-details-criteria">' + items + '</ul>'
            + '</div>'
          );
        }
        const isOpen = getOpenDetails().has(s.storyId);
        return '<details class="story-details" data-story-details="' + escape(s.storyId) + '"'
          + (isOpen ? ' open' : '') + '>'
          + '<summary>Story details</summary>'
          + '<div class="story-details-body">' + sections.join('') + '</div>'
          + '</details>';
      };

      const OPEN_RESULTS_KEY = 'marmite-dashboard-open-results';
      const getOpenResults = () => {
        try { return new Set(JSON.parse(localStorage.getItem(OPEN_RESULTS_KEY) || '[]')); }
        catch { return new Set(); }
      };
      const setOpenResults = (set) => {
        localStorage.setItem(OPEN_RESULTS_KEY, JSON.stringify([...set]));
      };

      const renderCommitStat = (cs) => {
        // Defensive: the harness only emits commitStats for workflows that
        // commit per-story, but older event files or alternate workflows may
        // surface partial commit metadata (e.g. SHA only, no diffstat).
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
          if (f.binary) {
            return '<div class="diff-row">'
              + '<span class="diff-file" title="' + escape(file) + '">' + escape(file) + '</span>'
              + '<span class="diff-binary">binary</span>'
              + '</div>';
          }
          const total = added + deleted;
          const widthPct = (total / maxLineChanges) * 100;
          const addPct = total === 0 ? 0 : (added / total) * 100;
          const delPct = 100 - addPct;
          return '<div class="diff-row">'
            + '<span class="diff-file" title="' + escape(file) + '">' + escape(file) + '</span>'
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

      const renderStoryResults = (s) => {
        // Each workflow produces a different subset of these signals:
        // one-shot may skip per-story commits entirely, pr-on-checkpoint
        // groups them into a PR, tdd splits them across phases. Render
        // whichever sections actually have data — never assume all are set.
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
            : '<div style="font-size:12px; color:#6b7280;">'
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
        const isOpen = storyId ? getOpenResults().has(storyId) : false;
        return '<details class="story-results" data-results-details="' + escape(storyId) + '"'
          + (isOpen ? ' open' : '') + '>'
          + '<summary>Run results' + summaryMeta + '</summary>'
          + '<div class="story-results-body">' + sections.join('') + '</div>'
          + '</details>';
      };

      const renderStory = (s) => {
        const state = storyState(s);
        let badge;
        if (s.passed === true) {
          badge = '<span class="badge pass">✓ Pass' + (s.attempts > 1 ? ' (' + s.attempts + ' attempts)' : '') + '</span>';
        } else if (s.passed === false) {
          badge = '<span class="badge fail">✗ Fail</span>';
        } else if (s.phases.length > 0) {
          badge = '<span class="badge pending">… In Progress</span>';
        } else {
          badge = '<span class="badge idle">Queued</span>';
        }
        const epic = s.epic ? '<div class="story-epic">' + escape(s.epic) + '</div>' : '';
        const details = renderStoryDetails(s);
        const results = renderStoryResults(s);
        return '<div class="story-card" id="story-' + escape(s.storyId) + '">'
          + '<div class="story-header ' + state + '">'
          + '<div><div class="story-id">' + escape(s.storyId) + '</div>'
          + '<div class="story-title">' + escape(s.title) + '</div>'
          + epic
          + '</div>' + badge + '</div>'
          + details + results
          + '</div>';
      };

      const renderCurrentTask = (ct) => {
        if (!ct) return '';
        const kindCls = ct.kind === 'janitor' ? 'janitor' : '';
        const kindLabel = ct.kind === 'janitor' ? 'Janitor in progress' : 'Story in progress';
        const phaseBits = [];
        if (ct.phase) {
          const phaseTxt = ct.phase + (ct.attempt && ct.attempt > 1 ? ' · attempt ' + ct.attempt : '');
          phaseBits.push('<span class="current-task-phase">' + escape(phaseTxt) + '</span>');
        }
        if (ct.phaseDurationMs != null) {
          const running = ct.isPhaseActive ? 'running ' : 'last phase ';
          phaseBits.push('<span>' + running + 'for <strong>' + escape(fmtDur(ct.phaseDurationMs)) + '</strong></span>');
        }
        if (ct.iteration != null) {
          phaseBits.push('<span>iteration <strong>' + ct.iteration + '</strong></span>');
        }
        if (ct.priority != null) {
          phaseBits.push('<span>priority <strong>' + ct.priority + '</strong></span>');
        }

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

        const guidance = ct.guidance
          ? '<div class="current-task-section">'
            + '<div class="current-task-section-label">Guidance</div>'
            + '<div class="current-task-section-body">' + escape(ct.guidance) + '</div>'
            + '</div>'
          : '';

        const reasoning = ct.reasoning
          ? '<div class="current-task-section">'
            + '<div class="current-task-section-label">Reasoning</div>'
            + '<div class="current-task-section-body">' + escape(ct.reasoning) + '</div>'
            + '</div>'
          : '';

        const notes = ct.notes
          ? '<div class="current-task-section">'
            + '<div class="current-task-section-label">Notes</div>'
            + '<div class="current-task-section-body">' + escape(ct.notes) + '</div>'
            + '</div>'
          : '';

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

        return '<div class="current-task ' + kindCls + '" href="#story-' + escape(ct.storyId) + '">'
          + '<div class="current-task-spinner"></div>'
          + '<div class="current-task-body">'
          + '<div class="current-task-label">' + escape(kindLabel) + verdictBadge + '</div>'
          + '<div class="current-task-title"><a href="#story-' + escape(ct.storyId) + '" style="color:inherit;text-decoration:none;">'
          + escape(ct.title) + '</a></div>'
          + '<div class="current-task-id">' + escape(ct.storyId) + '</div>'
          + '<div class="current-task-meta">' + phaseBits.join('') + '</div>'
          + description
          + criteria
          + sensors
          + guidance
          + reasoning
          + notes
          + verifierSummary
          + halt
          + '</div></div>';
      };

      const findStory = (d, storyId) => {
        if (!storyId || !d.stories) return null;
        return d.stories.find((s) => s.storyId === storyId) || null;
      };

      const renderHaltBanner = (d) => {
        if (!d.halt) return '';
        // Different workflows emit different halt shapes. one-shot never halts.
        // pr-on-checkpoint halts with PR+branch. Future workflows may halt for
        // other reasons (manual_review, budget_exceeded, …) with no PR data,
        // so every halt field is optional.
        const reason = typeof d.halt.reason === 'string' ? d.halt.reason : 'halted';
        const label = HALT_LABEL[reason] || reason.replace(/_/g, ' ');
        const bits = [];
        if (d.halt.prNum) {
          if (d.halt.prUrl) {
            bits.push('<a href="' + escape(d.halt.prUrl) + '" target="_blank" rel="noopener">'
              + 'PR #' + d.halt.prNum + ' ↗</a>');
          } else {
            bits.push('<span>PR <strong>#' + d.halt.prNum + '</strong></span>');
          }
        }
        if (d.halt.branch) {
          bits.push('<span>branch <strong>' + escape(d.halt.branch) + '</strong></span>');
        }
        if (d.halt.iteration != null) {
          bits.push('<span>iteration <strong>' + d.halt.iteration + '</strong></span>');
        }
        if (d.halt.at) {
          bits.push('<span>since <strong>' + escape(new Date(d.halt.at).toLocaleString()) + '</strong></span>');
        }
        const action = reason === 'awaiting_pr_review'
          ? 'Once the PR is merged, re-run <code>marmite cook</code> to resume.'
          : 'Resolve the halt condition, then re-run <code>marmite cook</code> to resume.';

        const haltedStory = findStory(d, d.halt.haltedStoryId);
        const haltedRow = haltedStory
          ? '<div class="halt-banner-story">'
            + '<span class="halt-banner-story-label">'
            +   (reason === 'awaiting_pr_review' ? 'In review' : 'Halted on')
            + '</span>'
            + '<a class="halt-banner-story-link" href="#story-' + escape(haltedStory.storyId) + '">'
            +   '<strong>' + escape(haltedStory.storyId) + '</strong> · ' + escape(haltedStory.title || haltedStory.storyId)
            + '</a>'
            + '</div>'
          : '';

        const nextUp = d.halt.nextUp;
        const nextRow = nextUp && typeof nextUp.storyId === 'string'
          ? '<div class="halt-banner-next">'
            + '<span class="halt-banner-next-label">Next up</span>'
            + '<a class="halt-banner-next-link" href="#story-' + escape(nextUp.storyId) + '">'
            +   '<strong>' + escape(nextUp.storyId) + '</strong> · ' + escape(nextUp.title || nextUp.storyId)
            + '</a>'
            + (nextUp.epic
                ? '<span class="halt-banner-next-epic">' + escape(nextUp.epic) + '</span>'
                : '')
            + '</div>'
          : '';

        return '<div class="halt-banner">'
          + '<div class="halt-banner-icon">⏸️</div>'
          + '<div class="halt-banner-body">'
          + '<div class="halt-banner-label">Run halted</div>'
          + '<div class="halt-banner-title">' + escape(label) + '</div>'
          + '<div class="halt-banner-meta">' + bits.join('') + '</div>'
          + haltedRow
          + nextRow
          + '<div style="margin-top:8px; font-size:12px; color:#4b5563;">' + action + '</div>'
          + '</div></div>';
      };

      const renderConfigPanel = (d) => {
        if (!d.config) return '';
        const c = d.config;
        const rows = [];
        if (c.workflow) {
          rows.push(['Workflow', '<span class="config-workflow-badge">' + escape(c.workflow) + '</span>']);
        }
        if (c.baseBranch) rows.push(['Base branch', '<code>' + escape(c.baseBranch) + '</code>']);
        if (c.app) rows.push(['App', '<code>' + escape(c.app) + '</code>']);
        if (d.githubSlug) {
          rows.push([
            'Repo',
            '<a href="https://github.com/' + escape(d.githubSlug) + '" target="_blank" rel="noopener">'
            + escape(d.githubSlug) + ' ↗</a>',
          ]);
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
          rows.push([
            'Sensors',
            c.sensors.map((s) => '<span class="config-tag">' + escape(s.name) + ' · ' + escape(s.type) + '</span>').join(''),
          ]);
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

      const renderSummary = (d) => {
        const cards = [
          { cls: 'success', title: 'Stories Passed', value: d.storiesPassed + '/' + d.storiesTotal },
          { cls: '',        title: 'Total Cost',    value: fmtCost(d.totalCostUsd) },
          { cls: '',        title: 'Run Duration',  value: fmtDur(d.durationMs) },
          { cls: STATUS_CLASS[d.status] || '', title: 'Status', value: STATUS_LABEL[d.status] || d.status },
        ];
        return cards.map((c) => '<div class="summary-card ' + c.cls + '"><h3>' + c.title + '</h3><div class="value">' + c.value + '</div></div>').join('');
      };

      const COLLAPSED_EPICS_KEY = 'marmite-dashboard-collapsed-epics';
      const getCollapsedEpics = () => {
        try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_EPICS_KEY) || '[]')); }
        catch { return new Set(); }
      };
      const setCollapsedEpics = (set) => {
        localStorage.setItem(COLLAPSED_EPICS_KEY, JSON.stringify([...set]));
      };

      const pipelineItem = (s) => {
        let iconCls, iconChar;
        if (s.passed === true) { iconCls = 'pass'; iconChar = '✓'; }
        else if (s.passed === false) { iconCls = 'fail'; iconChar = '✗'; }
        else if (s.phases.length > 0) { iconCls = 'active-run'; iconChar = '•'; }
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
        if (!d.epics || !d.epics.length) {
          return '<div style="padding: 0 20px; color: #999; font-size: 13px;">No stories yet.</div>';
        }
        const collapsed = getCollapsedEpics();
        return d.epics.map((g) => {
          const isCollapsed = collapsed.has(g.slug);
          const countCls = g.storiesPassed === g.storiesTotal && g.storiesTotal > 0 ? 'complete' : '';
          return '<div class="epic-group ' + (isCollapsed ? 'collapsed' : '') + '" data-epic="' + escape(g.slug) + '">'
            + '<div class="epic-group-header" data-toggle-epic="' + escape(g.slug) + '">'
            + '<span class="epic-caret">▾</span>'
            + '<span class="epic-label" title="' + escape(g.label) + '">' + escape(g.label) + '</span>'
            + '<span class="epic-count ' + countCls + '">' + g.storiesPassed + '/' + g.storiesTotal + '</span>'
            + '</div>'
            + '<div class="epic-items">' + g.stories.map(pipelineItem).join('') + '</div>'
            + '</div>';
        }).join('');
      };

      const renderEpicMain = (d) => {
        if (!d.epics || !d.epics.length) return '';
        const collapsed = getCollapsedEpics();
        return d.epics.map((g) => {
          const isCollapsed = collapsed.has(g.slug);
          const pct = g.storiesTotal === 0 ? 0 : (g.storiesPassed / g.storiesTotal) * 100;
          return '<div class="epic-main epic-group ' + (isCollapsed ? 'collapsed' : '') + '" data-epic-main="' + escape(g.slug) + '">'
            + '<div class="epic-main-header" data-toggle-epic="' + escape(g.slug) + '">'
            + '<div><div class="epic-main-title">' + escape(g.label) + '</div>'
            + '<div class="epic-progress"><div class="epic-progress-bar" style="width:' + pct.toFixed(1) + '%"></div></div></div>'
            + '<div style="display:flex; align-items:center; gap:12px;">'
            + '<span class="epic-main-meta">' + g.storiesPassed + ' / ' + g.storiesTotal + ' passed</span>'
            + '<span class="epic-caret">▾</span></div>'
            + '</div>'
            + '<div class="epic-main-grid"><div class="stories-grid">' + g.stories.map(renderStory).join('') + '</div></div>'
            + '</div>';
        }).join('');
      };

      const renderPatterns = (patterns) => {
        if (!patterns || !patterns.length) return '';
        return '<div class="section-title">Patterns learned</div><div class="patterns">'
          + patterns.map((p) =>
              '<div class="pattern">'
              + '<span class="pattern-name">' + escape(p.name) + '</span>'
              + (p.addedInStory ? '<span class="pattern-tag">added in ' + escape(p.addedInStory) + '</span>' : '')
              + '<div class="pattern-desc">' + escape(p.description) + '</div>'
              + '</div>'
            ).join('')
          + '</div>';
      };

      // ── Sidebar toggle ─────────────────────────────────────────
      const sidebar = document.getElementById('sidebar');
      const toggle = document.getElementById('sidebarToggle');
      const COLLAPSED_KEY = 'marmite-dashboard-sidebar-collapsed';
      if (localStorage.getItem(COLLAPSED_KEY) === '1') {
        sidebar.classList.add('collapsed');
        toggle.textContent = '›';
      }
      toggle.addEventListener('click', () => {
        const collapsed = sidebar.classList.toggle('collapsed');
        toggle.textContent = collapsed ? '›' : '‹';
        localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
      });

      // Story details + results toggle — persisted so the 3s re-render
      // doesn't snap an expanded section shut.
      document.addEventListener('toggle', (ev) => {
        const el = ev.target;
        if (!(el instanceof HTMLDetailsElement)) return;
        const detailsId = el.getAttribute('data-story-details');
        if (detailsId) {
          const open = getOpenDetails();
          if (el.open) open.add(detailsId); else open.delete(detailsId);
          setOpenDetails(open);
          return;
        }
        const resultsId = el.getAttribute('data-results-details');
        if (resultsId) {
          const open = getOpenResults();
          if (el.open) open.add(resultsId); else open.delete(resultsId);
          setOpenResults(open);
        }
      }, true);

      // Epic toggle — collapses sidebar group AND main section in lockstep.
      document.addEventListener('click', (ev) => {
        const header = ev.target.closest && ev.target.closest('[data-toggle-epic]');
        if (!header) return;
        const slug = header.getAttribute('data-toggle-epic');
        const collapsedSet = getCollapsedEpics();
        if (collapsedSet.has(slug)) collapsedSet.delete(slug);
        else collapsedSet.add(slug);
        setCollapsedEpics(collapsedSet);
        document.querySelectorAll('[data-epic="' + slug + '"], [data-epic-main="' + slug + '"]').forEach((el) => {
          el.classList.toggle('collapsed', collapsedSet.has(slug));
        });
      });

      // Defense in depth: a single render error shouldn't take down the
      // whole page. Per-section try/catch keeps other panels visible so the
      // user can still see status when one workflow-specific field is off.
      const safe = (label, fn) => {
        try { return fn(); }
        catch (e) {
          console.error('[marmite-dashboard] ' + label + ':', e);
          return '<div style="background:#fee2e2;color:#991b1b;padding:10px 14px;border-radius:8px;font-size:12px;margin:6px 0;">'
            + 'Failed to render ' + escape(label) + ': ' + escape((e && e.message) || String(e))
            + '</div>';
        }
      };

      const renderInto = (id, html) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
      };

      const safeRender = (d) => {
        const status = (d && typeof d.status === 'string') ? d.status : 'unknown';
        const live = status === 'in_progress' ? '<span class="live-dot"></span>' : '';
        const project = d && typeof d.project === 'string' ? d.project : null;
        document.getElementById('title').textContent = '🚀 ' + (project || 'Marmite Dashboard');
        const workflowBit = d && d.config && d.config.workflow
          ? ' · Workflow: <code>' + escape(d.config.workflow) + '</code>'
          : '';
        document.getElementById('meta').innerHTML = live
          + 'Run ID: <code>' + escape((d && d.runId) || 'n/a') + '</code>'
          + workflowBit
          + ' · Events file: <code>' + escape((d && d.source) || 'n/a') + '</code>'
          + ' · Events: ' + ((d && d.totalEvents) || 0)
          + (d && d.iteration != null ? ' · Iteration ' + d.iteration : '');
        renderInto('haltBanner',  safe('halt banner',  () => renderHaltBanner(d)));
        renderInto('currentTask', safe('current task', () => renderCurrentTask(d && d.currentTask)));
        renderInto('summary',     safe('summary',      () => renderSummary(d)));
        renderInto('configPanel', safe('config panel', () => renderConfigPanel(d)));
        renderInto('content', safe('stories', () =>
          (d && Array.isArray(d.stories) && d.stories.length)
            ? renderEpicMain(d)
            : '<div class="empty">No stories yet — waiting for events.</div>'
        ));
        renderInto('patternsWrap', safe('patterns', () => renderPatterns(d && d.patterns)));
        renderInto('pipeline',     safe('pipeline', () => renderPipeline(d)));
        const subtitleEl = document.getElementById('sidebarSubtitle');
        if (subtitleEl) {
          const passed = (d && d.storiesPassed) || 0;
          const total = (d && d.storiesTotal) || 0;
          subtitleEl.textContent = passed + ' / ' + total + ' passed' + (project ? ' · ' + project : '');
        }
        const started = d && d.startedAt ? new Date(d.startedAt).toLocaleString() : 'unknown';
        document.getElementById('footer').innerHTML =
          'Source: ' + escape((d && d.source) || 'n/a')
          + ' · Started ' + escape(started)
          + ' · Status: ' + (STATUS_LABEL[status] || status);
      };

      let timer = null;
      const tick = async () => {
        try {
          const r = await fetch('/api/dashboard', { cache: 'no-store' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const data = await r.json();
          try { safeRender(data); }
          catch (e) {
            console.error('[marmite-dashboard] fatal render:', e);
            document.getElementById('meta').innerHTML =
              '<span style="color:#ef4444">Render error: ' + escape((e && e.message) || String(e)) + '</span>';
          }
        } catch (e) {
          document.getElementById('meta').innerHTML = '<span style="color:#ef4444">Error: ' + escape(e.message) + '</span>';
        }
      };
      tick();
      timer = setInterval(tick, 3000);
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
