import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appendJanitorEntry,
  nextJanitorId,
  pickNextStory,
  readPrd,
  allStoriesPassingOrError,
  markStoryPassing,
  type JanitorEntry,
  type TimelineEntry,
} from "../src/core/prd.ts";
import { setUserRoot, PATHS } from "../src/core/paths.ts";
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
        { id: "a", title: "A", priority: 1, passes: true },
        { id: "b", title: "B", priority: 2, passes: true },
      ]),
    ).toBeNull();
  });

  test("ignores stories with empty id", () => {
    const r = pickNextStory([
      { id: "", title: "skip", priority: 1, passes: false },
      { id: "real", title: "ok", priority: 2, passes: false },
    ]);
    expect(r?.id).toBe("real");
  });

  test("picks lowest priority first", () => {
    const r = pickNextStory([
      { id: "b", title: "B", priority: 2, passes: false },
      { id: "a", title: "A", priority: 1, passes: false },
      { id: "c", title: "C", priority: 3, passes: false },
    ]);
    expect(r?.id).toBe("a");
  });

  test("breaks ties by id (lex order)", () => {
    const r = pickNextStory([
      { id: "z", title: "Z", priority: 1, passes: false },
      { id: "a", title: "A", priority: 1, passes: false },
    ]);
    expect(r?.id).toBe("a");
  });

  test("skips passing stories", () => {
    const r = pickNextStory([
      { id: "a", title: "A", priority: 1, passes: true },
      { id: "b", title: "B", priority: 2, passes: false },
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

describe("nextJanitorId", () => {
  test("0001 when timeline has no janitor entries for the date", () => {
    expect(nextJanitorId([], "2026-05-25")).toBe("JANITOR-2026-05-25-0001");
  });

  test("ignores story entries and entries for other dates", () => {
    const timeline: TimelineEntry[] = [
      { kind: "story", storyId: "US-1", ts: "...", summary: "", commitShas: [] },
      { kind: "janitor", id: "JANITOR-2026-05-24-0009", ts: "...", passes: true, title: "", triggeredBy: [] },
    ];
    expect(nextJanitorId(timeline, "2026-05-25")).toBe("JANITOR-2026-05-25-0001");
  });

  test("increments past the highest existing suffix for the date", () => {
    const timeline: TimelineEntry[] = [
      { kind: "janitor", id: "JANITOR-2026-05-25-0001", ts: "...", passes: true, title: "", triggeredBy: [] },
      { kind: "janitor", id: "JANITOR-2026-05-25-0003", ts: "...", passes: false, title: "", triggeredBy: [] },
      { kind: "janitor", id: "JANITOR-2026-05-25-0002", ts: "...", passes: true, title: "", triggeredBy: [] },
    ];
    expect(nextJanitorId(timeline, "2026-05-25")).toBe("JANITOR-2026-05-25-0004");
  });

  test("zero-pads the suffix to four digits", () => {
    const timeline: TimelineEntry[] = [
      { kind: "janitor", id: "JANITOR-2026-05-25-0099", ts: "...", passes: true, title: "", triggeredBy: [] },
    ];
    expect(nextJanitorId(timeline, "2026-05-25")).toBe("JANITOR-2026-05-25-0100");
  });
});

describe("appendJanitorEntry", () => {
  // appendJanitorEntry writes to PATHS.progress (anchored to userRoot). Point
  // userRoot at the tmpdir per-test so writes stay isolated.
  beforeEach(() => {
    mkdirSync(join(tmp, ".marmite"), { recursive: true });
    setUserRoot(tmp);
  });

  test("creates progress.json with the entry when the file doesn't exist", async () => {
    const entry: JanitorEntry = {
      kind: "janitor",
      id: "JANITOR-2026-05-25-0001",
      ts: "2026-05-25T12:00:00Z",
      passes: false,
      title: "Maintenance pass",
      triggeredBy: [],
    };
    await appendJanitorEntry(entry);
    const written = JSON.parse(readFileSync(PATHS.progress, "utf-8"));
    expect(written.patterns).toEqual([]);
    expect(written.timeline).toHaveLength(1);
    expect(written.timeline[0].id).toBe("JANITOR-2026-05-25-0001");
  });

  test("appends without disturbing existing patterns or timeline rows", async () => {
    writeFileSync(
      PATHS.progress,
      JSON.stringify({
        patterns: [{ name: "p1", description: "", addedInStory: "US-1" }],
        timeline: [
          { kind: "story", storyId: "US-1", ts: "...", summary: "first", commitShas: [] },
        ],
      }),
    );
    await appendJanitorEntry({
      kind: "janitor",
      id: "JANITOR-2026-05-25-0001",
      ts: "...",
      passes: false,
      title: "x",
      triggeredBy: [],
    });
    const written = JSON.parse(readFileSync(PATHS.progress, "utf-8"));
    expect(written.patterns).toHaveLength(1);
    expect(written.timeline).toHaveLength(2);
    expect(written.timeline[0].kind).toBe("story");
    expect(written.timeline[1].kind).toBe("janitor");
  });
});
