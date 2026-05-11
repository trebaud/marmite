import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildFixPrompt,
  readVerificationResultFile,
  readCurrentTaskDecision,
} from "../src/core/protocol.ts";
import { setUserRoot, PATHS } from "../src/core/paths.ts";

// The protocol module reads from PATHS.currentTask, which is anchored to
// userRoot. We point userRoot at a fresh tmpdir per-test so reads are isolated.
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "marmite-protocol-"));
  mkdirSync(join(tmp, ".marmite"), { recursive: true });
  setUserRoot(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeCurrentTask(value: unknown): void {
  writeFileSync(PATHS.currentTask, JSON.stringify(value));
}

describe("buildFixPrompt", () => {
  test("contains the verification summary verbatim", () => {
    const p = buildFixPrompt("Login form is misaligned.");
    expect(p).toContain("Login form is misaligned.");
  });

  test("trims surrounding whitespace from the summary", () => {
    const p = buildFixPrompt("   spaced out\n  ");
    expect(p).toContain("spaced out");
    expect(p).not.toContain("   spaced out");
  });

  test("instructs the builder not to start a new story", () => {
    const p = buildFixPrompt("anything");
    expect(p.toLowerCase()).toContain("do not start a new story");
  });
});

describe("readVerificationResultFile", () => {
  test("missing file → missing", async () => {
    const r = await readVerificationResultFile();
    expect(r.kind).toBe("missing");
  });

  test("no verdict yet → missing (expected between orchestrate and verify)", async () => {
    writeCurrentTask({ storyId: "s1" });
    const r = await readVerificationResultFile();
    expect(r.kind).toBe("missing");
  });

  test("pass verdict → present", async () => {
    writeCurrentTask({ storyId: "s1", verdict: "pass" });
    const r = await readVerificationResultFile();
    expect(r.kind).toBe("present");
    if (r.kind === "present") {
      expect(r.value.verdict).toBe("pass");
      expect(r.value.storyId).toBe("s1");
    }
  });

  test("fail_retry without summary → malformed", async () => {
    writeCurrentTask({ storyId: "s1", verdict: "fail_retry", summary: "" });
    const r = await readVerificationResultFile();
    expect(r.kind).toBe("malformed");
  });

  test("fail_retry with summary → present", async () => {
    writeCurrentTask({
      storyId: "s1",
      verdict: "fail_retry",
      summary: "QA #2 failed",
      qaResults: [{ criterion: "x", passed: true }],
    });
    const r = await readVerificationResultFile();
    expect(r.kind).toBe("present");
    if (r.kind === "present") {
      expect(r.value.verdict).toBe("fail_retry");
      expect(r.value.qaResults).toHaveLength(1);
    }
  });

  test("missing storyId → malformed", async () => {
    writeCurrentTask({ verdict: "pass" });
    const r = await readVerificationResultFile();
    expect(r.kind).toBe("malformed");
  });

  test("malformed JSON file → malformed", async () => {
    writeFileSync(PATHS.currentTask, "{not json");
    const r = await readVerificationResultFile();
    expect(r.kind).toBe("malformed");
  });

  test("unknown verdict value → malformed", async () => {
    writeCurrentTask({ storyId: "s1", verdict: "weird", summary: "x" });
    const r = await readVerificationResultFile();
    expect(r.kind).toBe("malformed");
  });
});

describe("readCurrentTaskDecision", () => {
  test("missing file → missing", async () => {
    const r = await readCurrentTaskDecision();
    expect(r.kind).toBe("missing");
  });

  test("minimal decision parses with default empty ranSensors", async () => {
    writeCurrentTask({ storyId: "s1" });
    const r = await readCurrentTaskDecision();
    expect(r.kind).toBe("present");
    if (r.kind === "present") {
      expect(r.value.storyId).toBe("s1");
      expect(r.value.ranSensors).toEqual([]);
    }
  });

  test("ranSensors strings round-trip", async () => {
    writeCurrentTask({ storyId: "s1", ranSensors: ["eslint", "tsc"] });
    const r = await readCurrentTaskDecision();
    if (r.kind === "present") expect(r.value.ranSensors).toEqual(["eslint", "tsc"]);
  });

  test("halt.awaiting_pr parses", async () => {
    writeCurrentTask({
      storyId: "s1",
      halt: { kind: "awaiting_pr", prNum: 42, branch: "feature/x" },
    });
    const r = await readCurrentTaskDecision();
    expect(r.kind).toBe("present");
    if (r.kind === "present" && r.value.halt) {
      expect(r.value.halt.kind).toBe("awaiting_pr");
      expect(r.value.halt.prNum).toBe(42);
      expect(r.value.halt.branch).toBe("feature/x");
    }
  });

  test("halt.kind with unknown value → malformed", async () => {
    writeCurrentTask({ storyId: "s1", halt: { kind: "nope", prNum: 1 } });
    const r = await readCurrentTaskDecision();
    expect(r.kind).toBe("malformed");
  });

  test("halt.prNum non-positive → malformed", async () => {
    writeCurrentTask({ storyId: "s1", halt: { kind: "awaiting_pr", prNum: 0 } });
    const r = await readCurrentTaskDecision();
    expect(r.kind).toBe("malformed");
  });

  test("missing storyId → malformed", async () => {
    writeCurrentTask({ ranSensors: [] });
    const r = await readCurrentTaskDecision();
    expect(r.kind).toBe("malformed");
  });
});
