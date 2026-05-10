import type { HarnessConfig, RunStats } from "./types.ts";
import type { Reporter } from "./reporter.ts";
import { silentReporter } from "./reporter.ts";
import { PATHS, resolvePrompt } from "./paths.ts";
import { emitEvent, initEventLog, tailEvents } from "./events.ts";
import { fileExists, gitCommit, gitEnsureBranch, readJsonField, sleep, writeAtomic } from "./utils.ts";
import { detectAndAnnounceFeedback, forceClearFeedbackIfPresent } from "./feedback.ts";
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

export async function run(config: HarnessConfig, reporter: Reporter = silentReporter): Promise<void> {
  initEventLog(PATHS.events);
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

  const branchName = await readJsonField(config.prdPath, "branchName");
  if (branchName) gitEnsureBranch(PATHS.projectRoot, branchName, reporter);
  if (!(await fileExists(PATHS.progress))) {
    await writeAtomic(
      PATHS.progress,
      `# Harness Progress Log\nStarted: ${new Date().toString()}\n---\n`,
    );
  }

  // Validate prompt + PRD files up front. Prompts are installed by `marmite init`
  // into `.marmite/prompts/`; if any are missing the user likely skipped init or
  // deleted them — fail fast with a hint.
  for (const p of [resolvePrompt("orchestrator"), resolvePrompt("builder"), resolvePrompt("verifier")]) {
    if (!(await fileExists(p))) {
      reporter.error(`prompt file missing — run \`marmite init\` to install agent prompts`, p, "fatal");
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

  for (let i = 1; i <= config.maxIterations; i++) {
    if (runAbort.signal.aborted) break;
    const iterationStartedAtMs = Date.now();

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

    // Pre-check: any story left? If not, exit successfully.
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

    // ── Phase 0: Orchestrate ──
    const feedbackWasDetected = await detectAndAnnounceFeedback(i, reporter);

    await emitEvent("phase_start", { phase: "orchestrate", iteration: i, storyId: nextStory.id });
    reporter.phaseStart("orchestrate", { iteration: i, storyId: nextStory.id });

    // Tail events.jsonl during the orchestrate session so sensor_start /
    // sensor_end events emitted by the agent (via `marmite emit-event`)
    // show up in the logger in real time.
    const tailAbort = new AbortController();
    tailEvents(PATHS.events, (evt) => {
      if (evt.kind === "sensor_start") reporter.sensorStart(evt.sensor, evt.sensorType);
      else if (evt.kind === "sensor_end") reporter.sensorEnd(evt.sensor, evt.sensorType, evt.durationMs, evt.exitCode);
    }, tailAbort.signal);

    const orchestratorPrompt = await readPromptFile(resolvePrompt("orchestrator"));
    const orchestrate = await runQueryWithRetry(
      config,
      orchestratorPrompt,
      config.orchestrateTimeoutMs,
      undefined,
      runAbort.signal,
      reporter,
      config.orchestratorModel,
      "orchestrator",
    );
    tailAbort.abort();
    recordSession(runStats, orchestrate, "orchestrate", i, nextStory.id, reporter);
    await emitEvent("phase_end", { phase: "orchestrate", iteration: i, outcome: orchestrate.outcome });

    await forceClearFeedbackIfPresent(i, reporter, feedbackWasDetected);

    if (runAbort.signal.aborted) break;

    // Read orchestrator decision from current-task.json — determine actual story selected.
    const decisionParsed = await readCurrentTaskDecision();
    let currentStory = nextStory;
    let storySource: "orchestrator" | "fallback" = "fallback";

    if (decisionParsed.kind === "present") {
      const decision = decisionParsed.value;
      // Workflow-driven halt (e.g. pr-on-checkpoint waiting for PR merge). The
      // orchestrator agent writes this; the harness exits 0 so the next
      // `marmite cook` invocation resumes from the same current-task.json.
      if (decision.halt) {
        reporter.info(
          `\nHalting: workflow requested ${decision.halt.kind}` +
            (decision.halt.kind === "awaiting_pr" ? ` for PR #${decision.halt.prNum}` : "") +
            `. Re-run \`marmite cook\` once the gate clears.`,
        );
        await emitEvent("run_halt", {
          iteration: i,
          reason: decision.halt.kind,
          prNum: decision.halt.kind === "awaiting_pr" ? decision.halt.prNum : undefined,
          branch: decision.halt.branch,
        });
        runStats.iterationsCompleted = i - 1;
        reporter.finalReport(runStats);
        process.exit(0);
      }
      const decidedStory = prdState.stories.find((s) => s.id === decision.storyId);
      if (decidedStory) {
        currentStory = decidedStory;
        storySource = "orchestrator";
      } else {
        reporter.error(
          `orchestrator picked unknown story '${decision.storyId}', falling back to priority order`,
          undefined,
          "orchestrate",
        );
      }
      if (decision.ranSensors.length > 0) {
        await emitEvent("sensors_ran", { iteration: i, storyId: currentStory.id, sensors: decision.ranSensors });
      }
    } else if (decisionParsed.kind === "malformed") {
      reporter.error(`current-task.json malformed after orchestrate`, decisionParsed.error, "orchestrate");
    } else {
      reporter.info("  current-task.json not found after orchestrate — using priority-order story selection.");
    }

    await emitEvent("story_selected", { iteration: i, storyId: currentStory.id, title: currentStory.title, source: storySource });
    reporter.iterationStart(i, config.maxIterations, currentStory.id, currentStory.title);
    await emitEvent("iteration_start", { iteration: i, storyId: currentStory.id, title: currentStory.title });

    // ── Phase 1: Build ──
    await emitEvent("phase_start", { phase: "build", iteration: i, storyId: currentStory.id });
    reporter.phaseStart("build", { iteration: i, storyId: currentStory.id });

    const builderPrompt = await readPromptFile(resolvePrompt("builder"));
    const build = await runQueryWithRetry(
      config,
      builderPrompt,
      config.buildTimeoutMs,
      undefined,
      runAbort.signal,
      reporter,
      config.builderModel,
      "builder",
    );
    recordSession(runStats, build, "build", i, currentStory.id, reporter);
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
        reporter.budgetExceeded(currentStory.id, iterationCost(runStats, i), config.costBudgetUsdPerStory);
        failReason = "budget_exceeded";
        break;
      }

      await emitEvent("phase_start", { phase: "verify", iteration: i, attempt: fix + 1 });
      reporter.phaseStart("verify", { iteration: i, storyId: currentStory.id, attempt: fix + 1 });

      const verifierPrompt = await readPromptFile(resolvePrompt("verifier"));
      const verify = await runQueryWithRetry(
        config,
        verifierPrompt,
        config.verifyTimeoutMs,
        undefined,
        runAbort.signal,
        reporter,
        config.verifierModel,
        "verifier",
      );
      recordSession(runStats, verify, "verify", i, currentStory.id, reporter, fix + 1);
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
        storyId: currentStory.id,
        attempt: fixAttempts,
        maxAttempts: config.maxFixAttempts,
      });

      const fixPrompt = buildFixPrompt(v.summary);
      const fixResult = await runQueryWithRetry(
        config,
        fixPrompt,
        config.fixTimeoutMs,
        lastBuildSessionId,
        runAbort.signal,
        reporter,
        config.builderModel,
        "fixer",
      );
      recordSession(runStats, fixResult, "fix", i, currentStory.id, reporter, fix + 1);
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
      const marked = await markStoryPassing(config, currentStory.id, reporter);
      if (marked) {
        gitCommit(PATHS.projectRoot, config.prdPath, `verify: ${currentStory.id} - passed verification`, reporter);
      }
      finalizeStoryOutcome(runStats, currentStory.id, i, true);
    } else {
      finalizeStoryOutcome(runStats, currentStory.id, i, false, failReason);
    }

    reporter.iterationEnd({
      iteration: i,
      storyId: currentStory.id,
      storyTitle: currentStory.title,
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

  if (terminated) reporter.aborted();
  else reporter.maxReached(config.maxIterations);
  await emitEvent("run_end", { reason: terminated ? "signal" : "max_iterations" });
  reporter.finalReport(runStats);
  process.exit(terminated ? 130 : 1);
}
