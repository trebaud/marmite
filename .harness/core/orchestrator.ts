import type { HarnessConfig, RunStats } from "./types.ts";
import {
  emitEvent,
  initEventLog,
  logBudgetExceeded,
  logComplete,
  logError,
  logFinalReport,
  logIterationStart,
  logMaxReached,
  logResume,
  logStart,
} from "./logger.ts";
import { fileExists, gitCommit, gitEnsureBranch, readJsonField, sleep } from "./utils.ts";
import { archivePreviousRun, initProgress, trackBranch } from "./archive.ts";
import {
  STATE_VERSION,
  clearStateIfBranchChanged,
  loadState,
  persistState,
} from "./state.ts";
import {
  allStoriesPassingOrError,
  markStoryPassing,
  pickNextStory,
  readPrd,
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

export async function run(config: HarnessConfig): Promise<void> {
  initEventLog(config.eventsPath);
  await emitEvent("run_start", {
    maxIterations: config.maxIterations,
    model: config.model,
    builderModel: config.builderModel,
    verifierModel: config.verifierModel,
    costBudgetUsdPerStory: config.costBudgetUsdPerStory,
    costBudgetUsdTotal: config.costBudgetUsdTotal,
    buildTimeoutMs: config.buildTimeoutMs,
    verifyTimeoutMs: config.verifyTimeoutMs,
  });

  await archivePreviousRun(config);
  await trackBranch(config);
  const branchName = await readJsonField(config.prdPath, "branchName");
  if (branchName) gitEnsureBranch(config.projectRoot, branchName);
  await initProgress(config);
  await clearStateIfBranchChanged(config);

  // Validate prompt + PRD files up front.
  for (const p of [config.orchestratorMdPath, config.builderMdPath, config.verifierMdPath]) {
    if (!(await fileExists(p))) {
      console.error(`Error: prompt file missing: ${p}`);
      process.exit(2);
    }
  }
  const initialPrd = await readPrd(config.prdPath);
  if (initialPrd.kind === "parse_error") {
    console.error(`Error: prd.json parse failure: ${initialPrd.error}`);
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
    console.log("\n\nReceived termination signal. Aborting in-flight sessions...\n");
    runAbort.abort();
    emitEvent("run_abort", { reason: "signal" });
    setTimeout(() => {
      logFinalReport(runStats);
      process.exit(130);
    }, 500);
  };
  process.on("SIGINT", onTerminate);
  process.on("SIGTERM", onTerminate);

  logStart(config.maxIterations);

  // ── Resume support ──
  let startIteration = 1;
  if (config.resumeIfAvailable) {
    const state = await loadState(config);
    if (state) {
      const currentBranch = await readJsonField(config.prdPath, "branchName");
      if (state.branchName === currentBranch) {
        logResume(state);
        startIteration = state.iteration + 1;
        await emitEvent("run_resume", { iteration: state.iteration, storyId: state.storyId });
      }
    }
  }

  for (let i = startIteration; i <= config.maxIterations; i++) {
    if (runAbort.signal.aborted) break;

    // Total cost gate
    if (config.costBudgetUsdTotal > 0 && totalCost(runStats) >= config.costBudgetUsdTotal) {
      const spent = totalCost(runStats);
      console.log(`Total cost budget reached: spent=$${spent.toFixed(4)} budget=$${config.costBudgetUsdTotal.toFixed(2)} — halting run.`);
      await emitEvent("run_done", { reason: "total_budget_exceeded", spent, budget: config.costBudgetUsdTotal });
      logFinalReport(runStats);
      process.exit(0);
    }

    // Pre-check: any story left? If not, exit successfully.
    const prdState = await readPrd(config.prdPath);
    if (prdState.kind === "parse_error") {
      logError(`prd.json became unreadable mid-run`, prdState.error, "fatal");
      break;
    }
    const nextStory = pickNextStory(prdState.stories);
    if (!nextStory) {
      logComplete(i - 1, config.maxIterations);
      await emitEvent("run_done", { reason: "all_stories_passing" });
      logFinalReport(runStats);
      process.exit(0);
    }

    // ── Phase 0: Orchestrate ──
    await emitEvent("phase_start", { phase: "orchestrate", iteration: i, storyId: nextStory.id });

    const orchestratorPrompt = await readPromptFile(config.orchestratorMdPath);
    const orchestrate = await runQueryWithRetry(
      config,
      orchestratorPrompt,
      config.orchestrateTimeoutMs,
      undefined,
      runAbort.signal,
      config.orchestratorModel,
      "orchestrator",
    );
    recordSession(runStats, orchestrate, "orchestrate", i, nextStory.id);
    await emitEvent("phase_end", { phase: "orchestrate", iteration: i, outcome: orchestrate.outcome });

    if (runAbort.signal.aborted) break;

    // Read orchestrator decision from current-task.json — determine actual story selected.
    const decisionParsed = await readCurrentTaskDecision(config);
    let currentStory = nextStory;

    if (decisionParsed.kind === "present") {
      const decision = decisionParsed.value;
      const decidedStory = prdState.stories.find((s) => s.id === decision.storyId);
      if (decidedStory) {
        currentStory = decidedStory;
      } else {
        logError(
          `orchestrator picked unknown story '${decision.storyId}', falling back to priority order`,
          undefined,
          "orchestrate",
        );
      }
      if (decision.ranSensors.length > 0) {
        await emitEvent("sensors_ran", { iteration: i, storyId: currentStory.id, sensors: decision.ranSensors });
      }
    } else if (decisionParsed.kind === "malformed") {
      logError(`current-task.json malformed after orchestrate`, decisionParsed.error, "orchestrate");
    } else {
      console.log("  current-task.json not found after orchestrate — using priority-order story selection.");
    }

    logIterationStart(i, config.maxIterations, currentStory.id);
    await emitEvent("iteration_start", { iteration: i, storyId: currentStory.id, title: currentStory.title });

    // ── Phase 1: Build ──
    await persistState(config, {
      version: STATE_VERSION,
      branchName: (await readJsonField(config.prdPath, "branchName")) || "",
      iteration: i,
      storyId: currentStory.id,
      buildSessionId: "",
      fixAttempts: 0,
      lastPhase: "build",
      updatedAt: new Date().toISOString(),
    });

    console.log("  Phase: BUILD");
    console.log("===============================================================");
    await emitEvent("phase_start", { phase: "build", iteration: i, storyId: currentStory.id });

    const builderPrompt = await readPromptFile(config.builderMdPath);
    const build = await runQueryWithRetry(
      config,
      builderPrompt,
      config.buildTimeoutMs,
      undefined,
      runAbort.signal,
      config.builderModel,
      "builder",
    );
    recordSession(runStats, build, "build", i, currentStory.id);
    await emitEvent("phase_end", { phase: "build", iteration: i, outcome: build.outcome });

    if (runAbort.signal.aborted) break;

    if (build.outcome === "fatal_error") {
      finalizeStoryOutcome(runStats, currentStory.id, i, false, `build_fatal:${build.errorMessage?.slice(0, 60) ?? ""}`);
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
        logBudgetExceeded(currentStory.id, iterationCost(runStats, i), config.costBudgetUsdPerStory);
        failReason = "budget_exceeded";
        break;
      }

      console.log("");
      console.log("---------------------------------------------------------------");
      console.log(`  Phase: VERIFY (iteration ${i}, attempt ${fix + 1})`);
      console.log("---------------------------------------------------------------");
      await emitEvent("phase_start", { phase: "verify", iteration: i, attempt: fix + 1 });

      const verifierPrompt = await readPromptFile(config.verifierMdPath);
      const verify = await runQueryWithRetry(
        config,
        verifierPrompt,
        config.verifyTimeoutMs,
        undefined,
        runAbort.signal,
        config.verifierModel,
        "verifier",
      );
      recordSession(runStats, verify, "verify", i, currentStory.id, fix + 1);
      await emitEvent("phase_end", { phase: "verify", iteration: i, attempt: fix + 1, outcome: verify.outcome });

      // Distinguish verifier crash from legitimate "no fixes will help" verdict.
      if (verify.outcome !== "success") {
        if (fix < config.maxFixAttempts && !runAbort.signal.aborted) {
          logError(
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

      const parsed = await readVerificationResultFile(config);
      if (parsed.kind === "missing") {
        console.log("  No verdict in current-task.json — verifier did not write results.");
        failReason = "missing_results";
        break;
      }
      if (parsed.kind === "malformed") {
        logError(`current-task.json verdict malformed`, parsed.error, "verify");
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
        console.log("  Verifier verdict=fail_abort — not retrying.");
        failReason = "fail_abort";
        break;
      }
      // fail_retry
      if (fix >= config.maxFixAttempts) {
        failReason = "max_attempts";
        break;
      }
      if (!lastBuildSessionId) {
        console.log("  No build session to resume. Stopping fix loop.");
        failReason = "no_session";
        break;
      }

      fixAttempts++;
      console.log("");
      console.log("---------------------------------------------------------------");
      console.log(`  Phase: FIX (iteration ${i}, fix ${fixAttempts} of ${config.maxFixAttempts})`);
      console.log("---------------------------------------------------------------");
      await emitEvent("phase_start", { phase: "fix", iteration: i, attempt: fixAttempts });

      await persistState(config, {
        version: STATE_VERSION,
        branchName: (await readJsonField(config.prdPath, "branchName")) || "",
        iteration: i,
        storyId: currentStory.id,
        buildSessionId: lastBuildSessionId,
        fixAttempts,
        lastPhase: "fix",
        updatedAt: new Date().toISOString(),
      });

      const fixPrompt = buildFixPrompt(v.summary);
      const fixResult = await runQueryWithRetry(
        config,
        fixPrompt,
        config.fixTimeoutMs,
        lastBuildSessionId,
        runAbort.signal,
        config.builderModel,
        "fixer",
      );
      recordSession(runStats, fixResult, "fix", i, currentStory.id, fix + 1);
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
      const marked = await markStoryPassing(config, currentStory.id);
      if (marked) {
        gitCommit(config.projectRoot, config.prdPath, `verify: ${currentStory.id} - passed verification`);
      }
      finalizeStoryOutcome(runStats, currentStory.id, i, true);
      console.log(`Story ${currentStory.id} passed verification at iteration ${i}.`);
    } else {
      finalizeStoryOutcome(runStats, currentStory.id, i, false, failReason);
      console.log(`Story ${currentStory.id} did NOT pass (${failReason ?? "unknown"}) after ${fixAttempts} fix attempt(s). Moving on.`);
    }

    await persistState(config, {
      version: STATE_VERSION,
      branchName: (await readJsonField(config.prdPath, "branchName")) || "",
      iteration: i,
      storyId: currentStory.id,
      buildSessionId: lastBuildSessionId,
      fixAttempts,
      lastPhase: "idle",
      updatedAt: new Date().toISOString(),
    });

    // Exit early if PRD is now complete.
    const done = await allStoriesPassingOrError(config.prdPath);
    if (done.kind === "done") {
      logComplete(i, config.maxIterations);
      await emitEvent("run_done", { reason: "all_stories_passing", iteration: i });
      logFinalReport(runStats);
      process.exit(0);
    }
    if (done.kind === "error") {
      logError(`prd.json became unreadable after iteration ${i}`, done.message, "fatal");
      break;
    }

    await sleep(2000);
  }

  logMaxReached(config.maxIterations);
  await emitEvent("run_end", { reason: terminated ? "signal" : "max_iterations" });
  logFinalReport(runStats);
  process.exit(terminated ? 130 : 1);
}
