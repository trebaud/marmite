import { existsSync } from "fs";
import { resolve } from "path";
import { createInterface } from "readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { FRAMEWORK_PATHS } from "../core/paths.ts";

// Shared driver for `marmite init` and `marmite to-prd`. Loads an internal
// skill's SKILL.md, opens an interactive SDK session in the user's cwd, and
// streams assistant text + spinners to the terminal until the conversation
// ends or the user aborts.
export interface SkillSessionOptions {
  // Name of the directory under src/skills/ holding SKILL.md.
  skillName: string;
  // Command label used in error messages and in the abort hint
  // (e.g. "marmite init", "marmite to-prd").
  command: string;
  // Free-form text prepended to SKILL.md when seeding the session.
  preamble: string;
  // Banner printed before the session starts.
  banner?: () => void;
  // Model used for the session. Defaults to claude-sonnet-4-6.
  model?: string;
}

export async function runSkillSession(opts: SkillSessionOptions): Promise<void> {
  const skillFile = resolve(FRAMEWORK_PATHS.internalSkills, opts.skillName, "SKILL.md");
  if (!existsSync(skillFile)) {
    console.error(`Error: ${opts.skillName} skill not found at ${skillFile}`);
    console.error("This usually means the marmite package is corrupt — try reinstalling.");
    process.exit(2);
  }

  const skillContent = await Bun.file(skillFile).text();
  if (opts.banner) opts.banner();

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let rlClosed = false;
  rl.on("close", () => { rlClosed = true; });
  function readLine(): Promise<string | null> {
    if (rlClosed) return Promise.resolve(null);
    return new Promise((res) => {
      const onLine = (line: string) => {
        rl.off("close", onClose);
        res(line);
      };
      const onClose = () => {
        rl.off("line", onLine);
        res(null);
      };
      rl.once("line", onLine);
      rl.once("close", onClose);
    });
  }

  let resolveTurn: () => void = () => {};
  let turnDone: Promise<void> = new Promise<void>((r) => { resolveTurn = r; });
  function beginTurn(): void {
    turnDone = new Promise<void>((r) => { resolveTurn = r; });
  }

  async function* userStream(): AsyncGenerator<SDKUserMessage> {
    startSpinner();
    yield {
      type: "user",
      message: { role: "user", content: opts.preamble + skillContent },
      parent_tool_use_id: null,
    };
    while (true) {
      await turnDone;
      stopSpinner();
      process.stdout.write(`\n\x1b[90m──────────────────────────────\x1b[0m\n\x1b[1;32m▶\x1b[0m `);
      const line = await readLine();
      if (line === null) return;
      process.stdout.write("\n");
      beginTurn();
      startSpinner();
      yield {
        type: "user",
        message: { role: "user", content: line },
        parent_tool_use_id: null,
      };
    }
  }

  const abort = new AbortController();
  let aborted = false;
  const onAbort = () => {
    if (aborted) process.exit(130);
    aborted = true;
    abort.abort();
    resolveTurn();
    stopSpinner();
    process.stdout.write(`\n\x1b[33m✗ aborted — no files written. Run \`${opts.command}\` to start over.\x1b[0m\n`);
    setTimeout(() => process.exit(130), 150);
  };
  process.on("SIGINT", onAbort);
  process.on("SIGTERM", onAbort);

  const q = query({
    prompt: userStream(),
    options: {
      cwd: process.cwd(),
      model: opts.model ?? "claude-haiku-4-5",
      settingSources: ["project"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      abortController: abort,
      stderr: (data: string) => {
        if (aborted) return;
        const line = data.trim();
        if (line) process.stderr.write(`\x1b[90m${line}\x1b[0m\n`);
      },
    },
  });

  try {
    for await (const message of q) {
      if (message.type === "assistant") {
        const blocks = (message as any).message?.content ?? [];
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            stopSpinner();
            process.stdout.write(renderMarkdown(block.text));
          } else if (block.type === "tool_use") {
            startSpinner();
          }
        }
      } else if (message.type === "result") {
        stopSpinner();
        resolveTurn();
      }
    }
  } catch (err) {
    if (aborted) return;
    stopSpinner();
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n\x1b[31m✗ ${opts.command} failed:\x1b[0m ${msg}\n`);
    process.exit(1);
  } finally {
    stopSpinner();
    rl.close();
  }

  process.stdout.write("\n");
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;

function startSpinner(): void {
  if (spinnerTimer) return;
  spinnerFrame = 0;
  drawSpinner();
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    drawSpinner();
  }, 80);
}

function drawSpinner(): void {
  process.stdout.write(`\r\x1b[K\x1b[90m${SPINNER_FRAMES[spinnerFrame]} thinking…\x1b[0m`);
}

function stopSpinner(): void {
  if (!spinnerTimer) return;
  clearInterval(spinnerTimer);
  spinnerTimer = null;
  process.stdout.write("\r\x1b[K");
}

function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(`\x1b[90m▎\x1b[0m \x1b[36m${raw}\x1b[0m`);
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = raw.match(/^(#{1,6})\s+(.*)$/))) {
      const level = m[1]!.length;
      const title = m[2]!;
      const visibleLen = title.replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/`([^`\n]+)`/g, " $1 ").length;
      const rule = "━".repeat(Math.max(8, Math.min(visibleLen, 64)));
      const rendered = renderInline(title);
      if (level === 1) {
        out.push("");
        out.push(`\x1b[1;95m${rendered}\x1b[0m`);
        out.push(`\x1b[95m${rule}\x1b[0m`);
      } else if (level === 2) {
        out.push("");
        out.push(`\x1b[1;36m▌ ${rendered}\x1b[0m`);
        out.push(`\x1b[36m${rule}\x1b[0m`);
      } else {
        out.push(`\x1b[1;34m${rendered}\x1b[0m`);
      }
      continue;
    }
    if (/^---+\s*$/.test(raw)) {
      out.push("\x1b[90m──────────────────────────────\x1b[0m");
      continue;
    }
    if ((m = raw.match(/^(\s*)>\s?(.*)$/))) {
      out.push(`${m[1]}\x1b[90m│\x1b[0m ${renderInline(m[2]!)}`);
      continue;
    }
    if ((m = raw.match(/^(\s*)[-*]\s+(.*)$/))) {
      out.push(`${m[1]}\x1b[36m▸\x1b[0m ${renderInline(m[2]!)}`);
      continue;
    }
    if ((m = raw.match(/^(\s*)(\d+)\.\s+(.*)$/))) {
      out.push(`${m[1]}\x1b[36m${m[2]}.\x1b[0m ${renderInline(m[3]!)}`);
      continue;
    }
    out.push(renderInline(raw));
  }
  return out.join("\n");
}

function renderInline(s: string): string {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, "\x1b[1;36m$1\x1b[0m")
    .replace(/`([^`\n]+)`/g, "\x1b[100;97m $1 \x1b[0m");
}
