import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  classifyError,
  readJson,
  writeAtomic,
  writeAtomicJson,
  fileExists,
  readJsonField,
  readTextState,
  readText,
} from "../src/core/utils.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "marmite-utils-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("classifyError", () => {
  test("nullish error → fatal", () => {
    expect(classifyError(null)).toEqual({ category: "fatal", message: "unknown error" });
    expect(classifyError(undefined)).toEqual({ category: "fatal", message: "unknown error" });
  });

  test("AbortError → aborted", () => {
    const err = Object.assign(new Error("operation aborted"), { name: "AbortError" });
    expect(classifyError(err).category).toBe("aborted");
  });

  test("name=Error but message contains 'aborted' → aborted", () => {
    expect(classifyError(new Error("request was aborted")).category).toBe("aborted");
  });

  test("ETIMEDOUT code → timeout", () => {
    const err = Object.assign(new Error("nope"), { code: "ETIMEDOUT" });
    expect(classifyError(err).category).toBe("timeout");
  });

  test("'timeout' in message → timeout", () => {
    expect(classifyError(new Error("Connection Timeout!")).category).toBe("timeout");
  });

  test("HTTP 429 → transient", () => {
    expect(classifyError({ status: 429, message: "rate limited" }).category).toBe("transient");
  });

  test("HTTP 5xx → transient", () => {
    expect(classifyError({ status: 503, message: "service unavailable" }).category).toBe("transient");
  });

  test("HTTP 400 → fatal", () => {
    expect(classifyError({ status: 400, message: "bad request" }).category).toBe("fatal");
  });

  test("ECONNRESET → transient", () => {
    const err = Object.assign(new Error("conn reset"), { code: "ECONNRESET" });
    expect(classifyError(err).category).toBe("transient");
  });

  test("unknown shape → fatal", () => {
    expect(classifyError(new Error("kaboom")).category).toBe("fatal");
  });

  test("propagates message and code", () => {
    const err = Object.assign(new Error("oh no"), { code: "EFOO", status: 502 });
    const r = classifyError(err);
    expect(r.message).toBe("oh no");
    expect(r.code).toBe("EFOO");
  });
});

describe("readJson", () => {
  test("missing file → kind 'missing'", async () => {
    const r = await readJson(join(tmp, "nope.json"));
    expect(r.kind).toBe("missing");
  });

  test("empty file → kind 'missing'", async () => {
    const p = join(tmp, "empty.json");
    writeFileSync(p, "   \n  ");
    expect((await readJson(p)).kind).toBe("missing");
  });

  test("valid JSON → kind 'present' with parsed value", async () => {
    const p = join(tmp, "ok.json");
    writeFileSync(p, '{"a":1,"b":"x"}');
    const r = await readJson<{ a: number; b: string }>(p);
    expect(r.kind).toBe("present");
    if (r.kind === "present") {
      expect(r.value.a).toBe(1);
      expect(r.value.b).toBe("x");
    }
  });

  test("malformed JSON → kind 'malformed'", async () => {
    const p = join(tmp, "bad.json");
    writeFileSync(p, "{not json}");
    const r = await readJson(p);
    expect(r.kind).toBe("malformed");
    if (r.kind === "malformed") {
      expect(r.error).toBeInstanceOf(Error);
      expect(r.raw).toBe("{not json}");
    }
  });
});

describe("writeAtomic", () => {
  test("writes file content and leaves no .tmp files behind", async () => {
    const p = join(tmp, "out.txt");
    await writeAtomic(p, "hello");
    expect(readFileSync(p, "utf-8")).toBe("hello");
    const { readdirSync } = await import("fs");
    const stragglers = readdirSync(tmp).filter((f) => f.includes(".tmp-"));
    expect(stragglers).toEqual([]);
  });

  test("overwrites an existing file atomically", async () => {
    const p = join(tmp, "out.txt");
    writeFileSync(p, "old");
    await writeAtomic(p, "new");
    expect(readFileSync(p, "utf-8")).toBe("new");
  });
});

describe("writeAtomicJson", () => {
  test("emits pretty JSON with trailing newline", async () => {
    const p = join(tmp, "j.json");
    await writeAtomicJson(p, { a: 1, nested: { b: 2 } });
    const text = readFileSync(p, "utf-8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({ a: 1, nested: { b: 2 } });
    expect(text).toContain("\n  "); // indented
  });
});

describe("fileExists", () => {
  test("returns true for existing file", async () => {
    const p = join(tmp, "x");
    writeFileSync(p, "");
    expect(await fileExists(p)).toBe(true);
  });

  test("returns false for missing file", async () => {
    expect(await fileExists(join(tmp, "nope"))).toBe(false);
  });
});

describe("readJsonField", () => {
  test("reads a string field", async () => {
    const p = join(tmp, "j.json");
    writeFileSync(p, JSON.stringify({ label: "feature/foo" }));
    expect(await readJsonField(p, "label")).toBe("feature/foo");
  });

  test("returns empty string when field missing", async () => {
    const p = join(tmp, "j.json");
    writeFileSync(p, JSON.stringify({}));
    expect(await readJsonField(p, "label")).toBe("");
  });

  test("returns empty string when field is non-string", async () => {
    const p = join(tmp, "j.json");
    writeFileSync(p, JSON.stringify({ label: 42 }));
    expect(await readJsonField(p, "label")).toBe("");
  });

  test("returns empty string when file missing", async () => {
    expect(await readJsonField(join(tmp, "missing.json"), "x")).toBe("");
  });
});

describe("readTextState / readText", () => {
  test("readTextState returns present + value", async () => {
    const p = join(tmp, "t.txt");
    writeFileSync(p, "hello");
    const r = await readTextState(p);
    expect(r.kind).toBe("present");
    if (r.kind === "present") expect(r.value).toBe("hello");
  });

  test("readText returns '' when missing", async () => {
    expect(await readText(join(tmp, "missing"))).toBe("");
  });
});
