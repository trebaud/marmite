import { describe, test, expect } from "bun:test";
import { extractFences } from "../src/cli/commands/doctor.ts";

describe("extractFences", () => {
  test("returns empty list when no fences present", () => {
    expect(extractFences("# plain prompt\n\nno contract fences here.")).toEqual([]);
  });

  test("captures a single fence with reason and body", () => {
    const src = [
      "preamble",
      "<!-- marmite:contract start — load-bearing rule -->",
      "do not break this protocol",
      "<!-- marmite:contract end -->",
      "trailing prose",
    ].join("\n");
    const out = extractFences(src);
    expect(out).toHaveLength(1);
    expect(out[0]?.reason).toBe("load-bearing rule");
    expect(out[0]?.body).toBe("do not break this protocol");
  });

  test("supports an ASCII dash instead of em-dash", () => {
    const src = [
      "<!-- marmite:contract start - reason here -->",
      "body",
      "<!-- marmite:contract end -->",
    ].join("\n");
    const out = extractFences(src);
    expect(out).toHaveLength(1);
    expect(out[0]?.reason).toBe("reason here");
  });

  test("captures multiple fences in order", () => {
    const src = [
      "<!-- marmite:contract start — first -->",
      "body-1",
      "<!-- marmite:contract end -->",
      "intermission",
      "<!-- marmite:contract start — second -->",
      "body-2-line-1",
      "body-2-line-2",
      "<!-- marmite:contract end -->",
    ].join("\n");
    const out = extractFences(src);
    expect(out.map((f) => f.reason)).toEqual(["first", "second"]);
    expect(out[1]?.body).toBe("body-2-line-1\nbody-2-line-2");
  });

  test("trims surrounding whitespace from reason", () => {
    const src = [
      "<!--   marmite:contract start  —  spaced reason   -->",
      "body",
      "<!-- marmite:contract end -->",
    ].join("\n");
    const out = extractFences(src);
    expect(out[0]?.reason).toBe("spaced reason");
  });

  test("preserves internal whitespace in the body", () => {
    const src = [
      "<!-- marmite:contract start — keep ws -->",
      "  indented line",
      "  another",
      "<!-- marmite:contract end -->",
    ].join("\n");
    const out = extractFences(src);
    expect(out[0]?.body).toBe("  indented line\n  another");
  });
});
