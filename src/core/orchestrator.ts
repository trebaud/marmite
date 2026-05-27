import type { HarnessConfig, RunStats } from "./types.ts";
import type { Reporter } from "./reporter.ts";
import { silentReporter } from "./reporter.ts";
import { PATHS, resolvePrompt, packagedPrompt, DEFAULT_WORKFLOW } from "./paths.ts";
import { emitEvent, initEventLog, setCurrentIteration, setRunId } from "./events.ts";
import { fileExists, gitCommit, gitUserName, sleep, writeAtomicJson } from "./utils.ts";
import { detectAndAnnounceFeedback, forceClearFeedbackIfPresent } from "./feedback.ts";
import {
  allStoriesPassingOrError,
  appendApproval,
  blockingEpic,
  markStoryPassing,
  pickNextStory,
  readPrd,
  readProgress,
} from "./prd.ts";
import {
  buildFixPrompt,
  readCurrentTaskDecision,
  readVerificationResultFile,
} from "./protocol.ts";
import { readPromptFile, runQueryWithRetry } from "./session.ts";
import {
  finalizeStoryOutcome,
  iterationCost,
  recordSession,
  totalCost,
} from "./stats.ts";

export async function run(config: HarnessConfig, reporter: Reporter = silentReporter): Promise<void> {
  initEventLog(PATHS.events);

  // Stamp every event in this run with a UUID, exposed to agent subprocesses
  // via env (MARMITE_RUN_ID) so any tooling they spawn can correlate.
  const runId = crypto.randomUUID();
  setRunId(runId);
  process.env.MARMITE_RUN_ID = runId;

  await emitEvent("run_start", {
    runId,
    maxIterations: config.maxIterations,
    model: config.model,
    builderModel: config.builderModel,
    verifierModel: config.verifierModel,
    costBudgetUsdPerStory: config.costBudgetUsdPerStory,
    costBudgetUsdTotal: config.costBudgetUsdTotal,
    buildTimeoutMs: config.buildTimeoutMs,
    verifyTimeoutMs: config.verifyTimeoutMs,
  });

  if (!(await fileExists(PATHS.progress))) {
    await writeAtomicJson(PATHS.progress, { patterns: [], timeline: [] });
  }

  // Validate prompt + PRD files up front. Agent prompts ship with the package
  // under the configured workflow; `.marmite/prompts/` only holds optional
  // overrides. If the packaged prompt is missing, the `workflow` in marmite.json
  // is a typo or names a removed workflow — fail fast with a hint.
  const workflow = config.workflow ?? DEFAULT_WORKFLOW;
  for (const role of ["orchestrator", "builder", "verifier"] as const) {
    if (!(await fileExists(packagedPrompt(workflow, role)))) {
      reporter.error(
        `workflow "${workflow}" has no ${role} prompt — check the \`workflow\` field in marmite.json`,
        packagedPrompt(workflow, role),
        "fatal",
      );
      process.exit(2);
    }
  }
  const initialPrd = await readPrd(config.prdPath);
  if (initialPrd.kind === "parse_error") {
    reporter.error(`prd.json parse failure`, initialPrd.error, "fatal");
    process.exit(2);
  }

  const runStats: RunStats = {
    startedAt: new Date(),
    sessions: [],
    storyOutcomes: [],
    iterationsCompleted: 0,
    storiesPassed: 0,
    storiesFailed: 0,
  };

  const runAbort = new AbortController();
  let terminated = false;
  const onTerminate = () => {
    if (terminated) return;
    terminated = true;
    reporter.info("\n\nReceived termination signal. Aborting in-flight sessions...\n");
    runAbort.abort();
    emitEvent("run_abort", { reason: "signal" });
    setTimeout(() => {
      reporter.finalReport(runStats);
      process.exit(130);
    }, 500);
  };
  process.on("SIGINT", onTerminate);
  process.on("SIGTERM", onTerminate);

  reporter.start(config.maxIterations);

  const warnedBudgetThresholds = new Set<number>();

  // `marmite cook --approve` clears the epic checkpoint the run is currently
  // stopped at, then builds the next epic. Approval is an append-only entry in
  // the progress timeline, derived from the immutable state (prd passes +
  // existing approvals) and committed so collaborators share it. It crosses
  // exactly the one pending checkpoint; the agent halts again at the next epic.
  if (config.approve && config.workflow === "epic-checkpoint") {
    const prdNow = await readPrd(config.prdPath);
    const progressNow = await readProgress();
    const block = prdNow.kind === "ok" ? blockingEpic(prdNow.stories, progressNow.timeline) : null;
    if (block) {
      await appendApproval(block.epic, gitUserName(PATHS.projectRoot));
      gitCommit(PATHS.projectRoot, PATHS.progress, `approve: epic ${block.epic}`, reporter);
      reporter.info(`Approved epic '${block.epic}'.`);
    } else {
      reporter.info("--approve: no epic checkpoint is pending; nothing to approve.");
    }
  }

  for (let i = 1; i <= config.maxIterations; i++) {
    if (runAbort.signal.aborted) break;
    const iterationStartedAtMs = Date.now();
    setCurrentIteration(i);
    process.env.MARMITE_ITERATION = String(i);

    // Budget warning thresholds (50%, 80%) — emit once each before the hard stop.
    if (config.costBudgetUsdTotal > 0) {
      const spent = totalCost(runStats);
      for (const threshold of [0.5, 0.8]) {
        if (!warnedBudgetThresholds.has(threshold) && spent >= config.costBudgetUsdTotal * threshold) {
          warnedBudgetThresholds.add(threshold);
          await emitEvent("budget_warning", { threshold, spent, budget: config.costBudgetUsdTotal });
        }
      }
    }

    // Total cost gate
    if (config.costBudgetUsdTotal > 0 && totalCost(runStats) >= config.costBudgetUsdTotal) {
      const spent = totalCost(runStats);
      reporter.info(`Total cost budget reached: spent=$${spent.toFixed(4)} budget=$${config.costBudgetUsdTotal.toFixed(2)} — halting run.`);
      await emitEvent("run_done", { reason: "total_budget_exceeded", spent, budget: config.costBudgetUsdTotal });
      reporter.finalReport(runStats);
      process.exit(0);
    }

    // Pre-check: anything left to do?
    const prdState = await readPrd(config.prdPath);
    if (prdState.kind === "parse_error") {
      reporter.error(`prd.json became unreadable mid-run`, prdState.error, "fatal");
      break;
    }
    const nextStory = pickNextStory(prdState.stories);
    if (!nextStory) {
      reporter.complete(i - 1, config.maxIterations);
      await emitEvent("run_done", { reason: "all_stories_passing" });
      reporter.finalReport(runStats);
      process.exit(0);
    }

    // Opening picture for the orchestrate phase. The agent gets the final say
    // via current-task.json.
    const initialTask = { id: nextStory.id, title: nextStory.title };

    // ── Phase 0: Orchestrate ──
    const feedbackWasDetected = await detectAndAnnounceFeedback(i, reporter);

    await emitEvent("phase_start", { phase: "orchestrate", iteration: i, storyId: initialTask.id });
    reporter.phaseStart("orchestrate", { iteration: i, storyId: initialTask.id });

    const orchestratorPrompt = await readPromptFile(resolvePrompt("orchestrator", workflow));
    const orchestrate = await runQueryWithRetry(orchestratorPrompt, config, {
      phase: "orchestrate",
      reporter,
      parentSignal: runAbort.signal,
      agentLabel: `orchestrator n=${i}`,
    });
    recordSession(runStats, orchestrate, "orchestrate", i, initialTask.id, reporter);
    await emitEvent("phase_end", { phase: "orchestrate", iteration: i, outcome: orchestrate.outcome });

    await forceClearFeedbackIfPresent(i, reporter, feedbackWasDetected);

    if (runAbort.signal.aborted) break;

    // Read orchestrator decision from current-task.json — determine actual story selected.
    const decisionParsed = await readCurrentTaskDecision();
    let currentTaskId = initialTask.id;
    let currentTaskTitle = initialTask.title;
    let storySource: "orchestrator" | "fallback" = "fallback";

    if (decisionParsed.kind === "present") {
      const decision = decisionParsed.value;
      // Epic checkpoint: the agent reached the end of an unapproved epic and
      // asked to stop. The harness exits 0; `marmite cook --approve` resumes.
      if (decision.halt) {
        reporter.info(
          `\nEpic '${decision.halt.epic}' complete — awaiting approval.\n` +
            `  → Review the work, then re-run \`marmite cook --approve\` to build the next epic.`,
        );
        await emitEvent("run_halt", { iteration: i, reason: "epic_checkpoint", epic: decision.halt.epic });
        runStats.iterationsCompleted = i - 1;
        reporter.finalReport(runStats);
        process.exit(0);
      }
      const decidedStory = prdState.stories.find((s) => s.id === decision.storyId);
      if (decidedStory) {
        currentTaskId = decidedStory.id;
        currentTaskTitle = decidedStory.title;
        storySource = "orchestrator";
      } else {
        reporter.error(
          `orchestrator picked unknown story '${decision.storyId}', falling back to priority order`,
          undefined,
          "orchestrate",
        );
      }
    } else if (decisionParsed.kind === "malformed") {
      reporter.error(`current-task.json malformed after orchestrate`, decisionParsed.error, "orchestrate");
    } else {
      reporter.info("  current-task.json not found after orchestrate — using priority-order story selection.");
    }

    await emitEvent("story_selected", { iteration: i, storyId: currentTaskId, title: currentTaskTitle, source: storySource });
    reporter.iterationStart(i, config.maxIterations, currentTaskId, currentTaskTitle);
    await emitEvent("iteration_start", { iteration: i, storyId: currentTaskId, title: currentTaskTitle });

    // ── Phase 1: Build ──
    await emitEvent("phase_start", { phase: "build", iteration: i, storyId: currentTaskId });
    reporter.phaseStart("build", { iteration: i, storyId: currentTaskId });

    const builderPrompt = await readPromptFile(resolvePrompt("builder", workflow));
    const build = await runQueryWithRetry(builderPrompt, config, {
      phase: "build",
      reporter,
      parentSignal: runAbort.signal,
      agentLabel: `builder n=${i}`,
    });
    recordSession(runStats, build, "build", i, currentTaskId, reporter);
    await emitEvent("phase_end", { phase: "build", iteration: i, outcome: build.outcome });

    if (runAbort.signal.aborted) break;

    if (build.outcome === "fatal_error") {
      finalizeStoryOutcome(runStats, currentTaskId, i, false, `build_fatal:${build.errorMessage?.slice(0, 60) ?? ""}`);
      runStats.iterationsCompleted = i;
      await sleep(1000);
      continue;
    }

    await sleep(1000);

    // ── Phase 2: Verify + fix loop ──
    let passed = false;
    let failReason: string | undefined;
    let fixAttempts = 0;
    let lastBuildSessionId = build.sessionId;

    for (let fix = 0; fix <= config.maxFixAttempts; fix++) {
      if (runAbort.signal.aborted) break;

      // Cost budget check
      if (config.costBudgetUsdPerStory > 0 && iterationCost(runStats, i) > config.costBudgetUsdPerStory) {
        reporter.budgetExceeded(currentTaskId, iterationCost(runStats, i), config.costBudgetUsdPerStory);
        failReason = "budget_exceeded";
        break;
      }

      await emitEvent("phase_start", { phase: "verify", iteration: i, attempt: fix + 1 });
      reporter.phaseStart("verify", { iteration: i, storyId: currentTaskId, attempt: fix + 1 });

      const verifierPrompt = await readPromptFile(resolvePrompt("verifier", workflow));
      const verify = await runQueryWithRetry(verifierPrompt, config, {
        phase: "verify",
        reporter,
        parentSignal: runAbort.signal,
        agentLabel: `verifier n=${i}.${fix + 1}`,
      });
      recordSession(runStats, verify, "verify", i, currentTaskId, reporter, fix + 1);
      await emitEvent("phase_end", { phase: "verify", iteration: i, attempt: fix + 1, outcome: verify.outcome });

      // Distinguish verifier crash from legitimate "no fixes will help" verdict.
      if (verify.outcome !== "success") {
        if (fix < config.maxFixAttempts && !runAbort.signal.aborted) {
          reporter.error(
            `verify session did not succeed (${verify.outcome}), treating as transient; continuing`,
            verify.errorMessage,
            "verify",
          );
          await sleep(2000);
          continue;
        }
        failReason = `verify_${verify.outcome}`;
        break;
      }

      const parsed = await readVerificationResultFile();
      if (parsed.kind === "missing") {
        reporter.info("  No verdict in current-task.json — verifier did not write results.");
        failReason = "missing_results";
        break;
      }
      if (parsed.kind === "malformed") {
        reporter.error(`current-task.json verdict malformed`, parsed.error, "verify");
        failReason = "malformed_results";
        break;
      }

      const v = parsed.value;
      await emitEvent("verification_verdict", {
        iteration: i,
        storyId: v.storyId,
        verdict: v.verdict,
        qaPass: v.qaResults.filter((q) => q.passed).length,
        qaFail: v.qaResults.filter((q) => !q.passed).length,
      });

      if (v.verdict === "pass") {
        passed = true;
        break;
      }
      if (v.verdict === "fail_abort") {
        reporter.info("  Verifier verdict=fail_abort — not retrying.");
        failReason = "fail_abort";
        break;
      }
      // fail_retry
      if (fix >= config.maxFixAttempts) {
        failReason = "max_attempts";
        break;
      }
      if (!lastBuildSessionId) {
        reporter.info("  No build session to resume. Stopping fix loop.");
        failReason = "no_session";
        break;
      }

      fixAttempts++;
      await emitEvent("phase_start", { phase: "fix", iteration: i, attempt: fixAttempts });
      reporter.phaseStart("fix", {
        iteration: i,
        storyId: currentTaskId,
        attempt: fixAttempts,
        maxAttempts: config.maxFixAttempts,
      });

      const fixPrompt = buildFixPrompt(v.summary);
      const fixResult = await runQueryWithRetry(fixPrompt, config, {
        phase: "fix",
        reporter,
        parentSignal: runAbort.signal,
        resumeId: lastBuildSessionId,
        agentLabel: `fixer n=${i}.${fixAttempts}`,
      });
      recordSession(runStats, fixResult, "fix", i, currentTaskId, reporter, fix + 1);
      await emitEvent("phase_end", { phase: "fix", iteration: i, attempt: fixAttempts, outcome: fixResult.outcome });

      if (fixResult.sessionId) lastBuildSessionId = fixResult.sessionId;
      if (fixResult.outcome === "fatal_error") {
        failReason = "fix_fatal";
        break;
      }
      await sleep(2000);
    }

    // ── Finalize iteration ──
    runStats.iterationsCompleted = i;
    if (passed) {
      const marked = await markStoryPassing(config, currentTaskId, reporter);
      if (marked) {
        gitCommit(PATHS.projectRoot, config.prdPath, `verify: ${currentTaskId} - passed verification`, reporter);
      }
      finalizeStoryOutcome(runStats, currentTaskId, i, true);
    } else {
      finalizeStoryOutcome(runStats, currentTaskId, i, false, failReason);
    }

    reporter.iterationEnd({
      iteration: i,
      storyId: currentTaskId,
      storyTitle: currentTaskTitle,
      passed,
      reason: failReason,
      durationMs: Date.now() - iterationStartedAtMs,
      costUsd: iterationCost(runStats, i),
      fixAttempts,
    });

    // Exit early if PRD is now complete.
    const done = await allStoriesPassingOrError(config.prdPath);
    if (done.kind === "done") {
      reporter.complete(i, config.maxIterations);
      await emitEvent("run_done", { reason: "all_stories_passing", iteration: i });
      reporter.finalReport(runStats);
      process.exit(0);
    }
    if (done.kind === "error") {
      reporter.error(`prd.json became unreadable after iteration ${i}`, done.message, "fatal");
      break;
    }

    await sleep(2000);
  }

  setCurrentIteration(null);

  if (terminated) reporter.aborted();
  else reporter.maxReached(config.maxIterations);
  await emitEvent("run_end", { reason: terminated ? "signal" : "max_iterations" });
  reporter.finalReport(runStats);
  process.exit(terminated ? 130 : 1);
}
