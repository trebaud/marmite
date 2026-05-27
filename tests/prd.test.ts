import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  pickNextStory,
  readPrd,
  allStoriesPassingOrError,
  markStoryPassing,
  orderedEpics,
  epicComplete,
  approvalExistsFor,
  blockingEpic,
  type PrdStory,
  type TimelineEntry,
} from "../src/core/prd.ts";
import type { Reporter } from "../src/core/reporter.ts";
import { silentReporter } from "../src/core/reporter.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "marmite-prd-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("pickNextStory", () => {
  test("returns null when no stories", () => {
    expect(pickNextStory([])).toBeNull();
  });

  test("returns null when all stories pass", () => {
    expect(
      pickNextStory([
        { id: "a", title: "A", priority: 1, passes: true, epic: "" },
        { id: "b", title: "B", priority: 2, passes: true, epic: "" },
      ]),
    ).toBeNull();
  });

  test("ignores stories with empty id", () => {
    const r = pickNextStory([
      { id: "", title: "skip", priority: 1, passes: false, epic: "" },
      { id: "real", title: "ok", priority: 2, passes: false, epic: "" },
    ]);
    expect(r?.id).toBe("real");
  });

  test("picks lowest priority first", () => {
    const r = pickNextStory([
      { id: "b", title: "B", priority: 2, passes: false, epic: "" },
      { id: "a", title: "A", priority: 1, passes: false, epic: "" },
      { id: "c", title: "C", priority: 3, passes: false, epic: "" },
    ]);
    expect(r?.id).toBe("a");
  });

  test("breaks ties by id (lex order)", () => {
    const r = pickNextStory([
      { id: "z", title: "Z", priority: 1, passes: false, epic: "" },
      { id: "a", title: "A", priority: 1, passes: false, epic: "" },
    ]);
    expect(r?.id).toBe("a");
  });

  test("skips passing stories", () => {
    const r = pickNextStory([
      { id: "a", title: "A", priority: 1, passes: true, epic: "" },
      { id: "b", title: "B", priority: 2, passes: false, epic: "" },
    ]);
    expect(r?.id).toBe("b");
  });
});

describe("readPrd", () => {
  test("missing file → parse_error", async () => {
    const r = await readPrd(join(tmp, "nope.json"));
    expect(r.kind).toBe("parse_error");
    expect(r.stories).toEqual([]);
  });

  test("malformed JSON → parse_error", async () => {
    const p = join(tmp, "prd.json");
    writeFileSync(p, "{not json");
    const r = await readPrd(p);
    expect(r.kind).toBe("parse_error");
  });

  test("userStories not array → parse_error", async () => {
    const p = join(tmp, "prd.json");
    writeFileSync(p, JSON.stringify({ userStories: "nope" }));
    const r = await readPrd(p);
    expect(r.kind).toBe("parse_error");
  });

  test("valid PRD → ok with defaults applied", async () => {
    const p = join(tmp, "prd.json");
    writeFileSync(
      p,
      JSON.stringify({
        userStories: [
          { id: "s1", title: "first", priority: 1 },
          { id: "s2" }, // omits everything else
        ],
      }),
    );
    const r = await readPrd(p);
    expect(r.kind).toBe("ok");
    expect(r.stories).toHaveLength(2);
    expect(r.stories[0]?.passes).toBe(false);
    expect(r.stories[1]?.title).toBe(""); // default
    expect(r.stories[1]?.priority).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("allStoriesPassingOrError", () => {
  test("error when file missing", async () => {
    const r = await allStoriesPassingOrError(join(tmp, "missing.json"));
    expect(r.kind).toBe("error");
  });

  test("not_done when stories are empty", async () => {
    const p = join(tmp, "prd.json");
    writeFileSync(p, JSON.stringify({ userStories: [] }));
    expect((await allStoriesPassingOrError(p)).kind).toBe("not_done");
  });

  test("done when all stories pass", async () => {
    const p = join(tmp, "prd.json");
    writeFileSync(
      p,
      JSON.stringify({ userStories: [{ id: "a", passes: true }, { id: "b", passes: true }] }),
    );
    expect((await allStoriesPassingOrError(p)).kind).toBe("done");
  });

  test("not_done when any open", async () => {
    const p = join(tmp, "prd.json");
    writeFileSync(
      p,
      JSON.stringify({ userStories: [{ id: "a", passes: true }, { id: "b", passes: false }] }),
    );
    expect((await allStoriesPassingOrError(p)).kind).toBe("not_done");
  });
});

describe("markStoryPassing", () => {
  // Minimal Reporter that swallows everything — markStoryPassing only uses .error
  const reporter: Reporter = silentReporter;

  test("flips matching story's passes to true and persists", async () => {
    const p = join(tmp, "prd.json");
    writeFileSync(
      p,
      JSON.stringify({ userStories: [{ id: "a", passes: false }, { id: "b", passes: false }] }),
    );
    const ok = await markStoryPassing({ prdPath: p } as any, "b", reporter);
    expect(ok).toBe(true);
    const updated = JSON.parse(readFileSync(p, "utf-8"));
    expect(updated.userStories[0].passes).toBe(false);
    expect(updated.userStories[1].passes).toBe(true);
  });

  test("returns false when story not found", async () => {
    const p = join(tmp, "prd.json");
    writeFileSync(p, JSON.stringify({ userStories: [{ id: "a", passes: false }] }));
    const ok = await markStoryPassing({ prdPath: p } as any, "missing", reporter);
    expect(ok).toBe(false);
  });

  test("returns false when PRD missing", async () => {
    const ok = await markStoryPassing({ prdPath: join(tmp, "no.json") } as any, "x", reporter);
    expect(ok).toBe(false);
  });
});

describe("epic checkpoint gate", () => {
  const story = (id: string, epic: string, priority: number, passes: boolean): PrdStory => ({
    id,
    title: id,
    priority,
    passes,
    epic,
  });
  // Two epics, contiguous by priority: auth (1,2) then billing (3,4).
  const twoEpics = (authPass: boolean, billingPass: boolean): PrdStory[] => [
    story("US-001", "auth", 1, authPass),
    story("US-002", "auth", 2, authPass),
    story("US-003", "billing", 3, billingPass),
    story("US-004", "billing", 4, billingPass),
  ];
  const approval = (epic: string): TimelineEntry => ({ kind: "approval", epic, ts: "t" });

  test("orderedEpics sorts by lowest story priority", () => {
    expect(orderedEpics(twoEpics(false, false))).toEqual(["auth", "billing"]);
  });

  test("epicComplete reflects story passes", () => {
    const stories = twoEpics(true, false);
    expect(epicComplete(stories, "auth")).toBe(true);
    expect(epicComplete(stories, "billing")).toBe(false);
  });

  test("approvalExistsFor finds approval entries only", () => {
    const tl: TimelineEntry[] = [
      { kind: "story", storyId: "US-001", ts: "t", summary: "", commitShas: [] },
      approval("auth"),
    ];
    expect(approvalExistsFor(tl, "auth")).toBe(true);
    expect(approvalExistsFor(tl, "billing")).toBe(false);
  });

  test("no block while still inside the first epic", () => {
    expect(blockingEpic(twoEpics(false, false), [])).toBeNull();
  });

  test("blocks at the boundary once the first epic is complete and unapproved", () => {
    expect(blockingEpic(twoEpics(true, false), [])).toEqual({ epic: "auth" });
  });

  test("does not block once the completed epic is approved", () => {
    expect(blockingEpic(twoEpics(true, false), [approval("auth")])).toBeNull();
  });

  test("no block when the PRD is complete", () => {
    expect(blockingEpic(twoEpics(true, true), [])).toBeNull();
  });

  test("ungrouped stories (no epic) never block", () => {
    const flat = [story("a", "", 1, true), story("b", "", 2, false)];
    expect(blockingEpic(flat, [])).toBeNull();
  });
});
