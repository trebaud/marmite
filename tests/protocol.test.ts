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

  test("minimal decision parses with just a storyId", async () => {
    writeCurrentTask({ storyId: "s1" });
    const r = await readCurrentTaskDecision();
    expect(r.kind).toBe("present");
    if (r.kind === "present") {
      expect(r.value.storyId).toBe("s1");
      expect(r.value.storyTitle).toBe("");
    }
  });

  test("storyTitle is carried through when present", async () => {
    writeCurrentTask({ storyId: "s1", storyTitle: "Set up auth" });
    const r = await readCurrentTaskDecision();
    expect(r.kind).toBe("present");
    if (r.kind === "present") {
      expect(r.value.storyTitle).toBe("Set up auth");
    }
  });

  test("epic_checkpoint halt parses", async () => {
    writeCurrentTask({ halt: { kind: "epic_checkpoint", epic: "auth" } });
    const r = await readCurrentTaskDecision();
    expect(r.kind).toBe("present");
    if (r.kind === "present") {
      expect(r.value.halt?.kind).toBe("epic_checkpoint");
      expect(r.value.halt?.epic).toBe("auth");
    }
  });

  test("halt with unknown kind → malformed", async () => {
    writeCurrentTask({ halt: { kind: "awaiting_pr_review", epic: "auth" } });
    const r = await readCurrentTaskDecision();
    expect(r.kind).toBe("malformed");
  });

  test("halt missing epic → malformed", async () => {
    writeCurrentTask({ halt: { kind: "epic_checkpoint" } });
    const r = await readCurrentTaskDecision();
    expect(r.kind).toBe("malformed");
  });

  test("empty handoff parses (harness falls back to priority order)", async () => {
    writeCurrentTask({ storyTitle: "no id here" });
    const r = await readCurrentTaskDecision();
    expect(r.kind).toBe("present");
    if (r.kind === "present") {
      expect(r.value.storyId).toBe("");
      expect(r.value.halt).toBeUndefined();
    }
  });
});
