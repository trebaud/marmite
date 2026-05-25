import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runEmitEvent } from "../src/cli/commands/emit-event.ts";
import { setUserRoot, PATHS } from "../src/core/paths.ts";

// `runEmitEvent` reads PATHS.events (anchored to userRoot) and calls `die` (→
// process.exit) on bad input. We point userRoot at a temp dir per test and
// patch process.exit so test failures throw instead of killing the runner.

let tmp: string;
let origExit: typeof process.exit;
let origError: typeof console.error;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "marmite-emit-event-"));
  mkdirSync(join(tmp, ".marmite"), { recursive: true });
  setUserRoot(tmp);

  origExit = process.exit;
  origError = console.error;
  (process as any).exit = (code?: number) => {
    throw new Error(`__exit__:${code ?? 0}`);
  };
  console.error = () => {};
});

afterEach(() => {
  process.exit = origExit;
  console.error = origError;
  rmSync(tmp, { recursive: true, force: true });
});

function readEvents(): Array<Record<string, unknown>> {
  try {
    const raw = readFileSync(PATHS.events, "utf-8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function emit(...flags: string[]): Promise<void> {
  // Mirror process.argv: [runtime, script, "emit-event", kind, ...flags]
  await runEmitEvent(["bun", "marmite", "emit-event", ...flags]);
}

describe("emit-event janitor-triggered", () => {
  test("emits a single-trigger janitor_triggered event", async () => {
    await emit(
      "janitor-triggered",
      "--janitor-id", "JANITOR-2026-05-25-0001",
      "--sensor", "eslint",
      "--finding-count", "23",
      "--threshold", "20",
    );
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("janitor_triggered");
    expect(events[0]!.janitorId).toBe("JANITOR-2026-05-25-0001");
    expect(events[0]!.triggers).toEqual([
      { sensor: "eslint", findingCount: 23, threshold: 20 },
    ]);
  });

  test("missing flags → exit 1", async () => {
    await expect(emit("janitor-triggered")).rejects.toThrow(/__exit__/);
  });
});

describe("emit-event janitor-fix-applied", () => {
  test("emits with commit sha", async () => {
    await emit(
      "janitor-fix-applied",
      "--janitor-id", "JANITOR-2026-05-25-0001",
      "--finding", "eslint no-unused-vars",
      "--commit-sha", "abc1234",
    );
    const events = readEvents();
    expect(events[0]!.kind).toBe("janitor_fix_applied");
    expect(events[0]!.commitSha).toBe("abc1234");
  });

  test("commit sha is optional", async () => {
    await emit(
      "janitor-fix-applied",
      "--janitor-id", "JANITOR-2026-05-25-0001",
      "--finding", "tsc 2322",
    );
    const events = readEvents();
    expect(events[0]!.commitSha).toBeUndefined();
  });
});

describe("emit-event janitor-fix-deferred", () => {
  test("requires reason", async () => {
    await expect(
      emit(
        "janitor-fix-deferred",
        "--janitor-id", "JANITOR-2026-05-25-0001",
        "--finding", "drift cyclic-dep",
      ),
    ).rejects.toThrow(/__exit__/);
  });

  test("emits when all fields present", async () => {
    await emit(
      "janitor-fix-deferred",
      "--janitor-id", "JANITOR-2026-05-25-0001",
      "--finding", "drift cyclic-dep",
      "--reason", "broke contract test",
    );
    const events = readEvents();
    expect(events[0]!.kind).toBe("janitor_fix_deferred");
    expect(events[0]!.reason).toBe("broke contract test");
  });
});

describe("emit-event janitor-done", () => {
  test("emits with counts", async () => {
    await emit(
      "janitor-done",
      "--janitor-id", "JANITOR-2026-05-25-0001",
      "--applied", "3",
      "--deferred", "1",
    );
    const events = readEvents();
    expect(events[0]!.kind).toBe("janitor_done");
    expect(events[0]!.applied).toBe(3);
    expect(events[0]!.deferred).toBe(1);
  });
});

describe("emit-event unknown kind", () => {
  test("unknown subcommand exits", async () => {
    await expect(emit("not-a-real-event")).rejects.toThrow(/__exit__/);
  });
});
