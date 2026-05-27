import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { parseArgs, parseDuration } from "../src/cli/args.ts";

// `parseDuration` and `parseArgs` both call `die()` on bad input, which calls
// `process.exit(1)`. We patch process.exit per-test so failures throw instead.

let exitCalls: number[];
let origExit: typeof process.exit;
let origError: typeof console.error;

beforeEach(() => {
  exitCalls = [];
  origExit = process.exit;
  origError = console.error;
  // Throw on exit so tests catch failure modes synchronously.
  (process as any).exit = (code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error(`__exit__:${code ?? 0}`);
  };
  console.error = () => {};
});

afterEach(() => {
  process.exit = origExit;
  console.error = origError;
});

describe("parseDuration", () => {
  test("undefined → undefined", () => {
    expect(parseDuration("x", undefined)).toBe(undefined);
  });

  test("raw number passes through unchanged", () => {
    expect(parseDuration("x", 12345)).toBe(12345);
  });

  test("'500ms' → 500", () => {
    expect(parseDuration("x", "500ms")).toBe(500);
  });

  test("'90s' → 90_000", () => {
    expect(parseDuration("x", "90s")).toBe(90_000);
  });

  test("'20m' → 1_200_000", () => {
    expect(parseDuration("x", "20m")).toBe(1_200_000);
  });

  test("'1h' → 3_600_000", () => {
    expect(parseDuration("x", "1h")).toBe(3_600_000);
  });

  test("decimal values work ('1.5m' → 90_000)", () => {
    expect(parseDuration("x", "1.5m")).toBe(90_000);
  });

  test("whitespace tolerated", () => {
    expect(parseDuration("x", "  10s ")).toBe(10_000);
  });

  test("invalid suffix → exit", () => {
    expect(() => parseDuration("x", "10z")).toThrow(/__exit__/);
  });

  test("garbage → exit", () => {
    expect(() => parseDuration("x", "soon")).toThrow(/__exit__/);
  });
});

describe("parseArgs", () => {
  // Build a fake argv: ['bun', 'marmite', ...]
  const argv = (...rest: string[]) => ["bun", "marmite", ...rest];

  test("empty argv → empty CliOverrides", () => {
    const { cli, configPath } = parseArgs(argv());
    expect(cli).toEqual({});
    expect(configPath).toBe(undefined);
  });

  test("strips leading `cook` subcommand", () => {
    const { cli } = parseArgs(argv("cook", "-n", "5"));
    expect(cli.maxIterations).toBe(5);
  });

  test("--max-iterations and short form", () => {
    expect(parseArgs(argv("-n", "10")).cli.maxIterations).toBe(10);
    expect(parseArgs(argv("--max-iterations", "10")).cli.maxIterations).toBe(10);
  });

  test("bare positive integer is treated as max-iterations", () => {
    expect(parseArgs(argv("7")).cli.maxIterations).toBe(7);
  });

  test("--config captures path", () => {
    const { configPath } = parseArgs(argv("--config", "./custom.json"));
    expect(configPath).toBe("./custom.json");
  });

  test("--config without value → exit", () => {
    expect(() => parseArgs(argv("--config"))).toThrow(/__exit__/);
  });

  test("--prd resolves to absolute path", () => {
    const { cli } = parseArgs(argv("--prd", "./prd.json"));
    expect(cli.prd?.endsWith("/prd.json")).toBe(true);
    expect(cli.prd?.startsWith("/")).toBe(true);
  });

  test("model overrides flow through", () => {
    const { cli } = parseArgs(
      argv("--model", "m-default", "--builder-model", "m-build", "--verifier-model", "m-verify"),
    );
    expect(cli.model).toBe("m-default");
    expect(cli.builderModel).toBe("m-build");
    expect(cli.verifierModel).toBe("m-verify");
  });

  test("timeouts parsed through parseDuration", () => {
    const { cli } = parseArgs(
      argv("--build-timeout", "1m", "--verify-timeout", "30s", "--fix-timeout", "2m"),
    );
    expect(cli.buildTimeoutMs).toBe(60_000);
    expect(cli.verifyTimeoutMs).toBe(30_000);
    expect(cli.fixTimeoutMs).toBe(120_000);
  });

  test("--cost-budget and --cost-budget-total", () => {
    const { cli } = parseArgs(argv("--cost-budget", "5.50", "--cost-budget-total", "100"));
    expect(cli.perStoryBudget).toBe(5.5);
    expect(cli.totalBudget).toBe(100);
  });

  test("--max-fix-attempts allows 0", () => {
    const { cli } = parseArgs(argv("--max-fix-attempts", "0"));
    expect(cli.maxFixAttempts).toBe(0);
  });

  test("--retries allows 0", () => {
    const { cli } = parseArgs(argv("--retries", "0"));
    expect(cli.transientRetries).toBe(0);
  });

  test("-v and --verbose set verbose", () => {
    expect(parseArgs(argv("-v")).cli.verbose).toBe(true);
    expect(parseArgs(argv("--verbose")).cli.verbose).toBe(true);
  });

  test("unknown flag → exit", () => {
    expect(() => parseArgs(argv("--bogus"))).toThrow(/__exit__/);
  });
});
