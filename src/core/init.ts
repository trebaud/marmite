import { existsSync } from "fs";
import { createInterface } from "readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { FRAMEWORK_PATHS } from "./paths.ts";

// `marmite init` shim. Runs the marmite-init skill as an interactive agent session
// using the same SDK as the cook loop. The wizard text lives in SKILL.md;
// this function wires stdin/stdout and starts the session.
export async function runInit(): Promise<void> {
  const skillFile = `${FRAMEWORK_PATHS.marmiteInitSkill}/SKILL.md`;
  if (!existsSync(skillFile)) {
    console.error(`Error: marmite-init skill not found at ${skillFile}`);
    console.error("This usually means the marmite package is corrupt — try reinstalling.");
    process.exit(2);
  }

  const skillContent = await Bun.file(skillFile).text();
  const preamble =
    "You are running as the `marmite init` setup wizard for the user's current working directory. " +
    "Follow the instructions below exactly. Use Bash/Read/Write/Edit tools to inspect and modify files. " +
    "Ask the user ONE question at a time and STOP after each question to wait for their reply. " +
    "After they answer, continue to the next step. The session is multi-turn — do not try to answer " +
    "all questions in a single response.\n\n";

  printBanner();

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let rlClosed = false;
  rl.on("close", () => {
    rlClosed = true;
  });
  function readLine(): Promise<string | null> {
    if (rlClosed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const onLine = (line: string) => {
        rl.off("close", onClose);
        resolve(line);
      };
      const onClose = () => {
        rl.off("line", onLine);
        resolve(null);
      };
      rl.once("line", onLine);
      rl.once("close", onClose);
    });
  }

  async function* userStream(): AsyncGenerator<SDKUserMessage> {
    startSpinner();
    yield {
      type: "user",
      message: { role: "user", content: preamble + skillContent },
      parent_tool_use_id: null,
    };
    while (true) {
      process.stdout.write(`\n\n\x1b[1;32m▶ your answer:\x1b[0m `);
      const line = await readLine();
      if (line === null) return;
      process.stdout.write("\n");
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
    if (aborted) {
      // Second Ctrl+C — force-exit immediately.
      process.exit(130);
    }
    aborted = true;
    abort.abort();
    stopSpinner();
    process.stdout.write("\n\x1b[33m✗ aborted — no files written. Run `marmite init` to start over.\x1b[0m\n");
    // Give the SDK a beat to clean up, then exit.
    setTimeout(() => process.exit(130), 150);
  };
  process.on("SIGINT", onAbort);
  process.on("SIGTERM", onAbort);

  const q = query({
    prompt: userStream(),
    options: {
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
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
      }
    }
  } catch (err) {
    if (aborted) return;
    stopSpinner();
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n\x1b[31m✗ marmite init failed:\x1b[0m ${msg}\n`);
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
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "\x1b[1;36m$1\x1b[0m")
    .replace(/`([^`\n]+)`/g, "\x1b[36m$1\x1b[0m")
    .replace(/^---+\s*$/gm, "\x1b[90m──────────────────────────────\x1b[0m");
}

function printBanner(): void {
  const art = [
    "  ███╗   ███╗  █████╗  ██████╗  ███╗   ███╗ ██╗ ████████╗ ███████╗",
    "  ████╗ ████║ ██╔══██╗ ██╔══██╗ ████╗ ████║ ██║ ╚══██╔══╝ ██╔════╝",
    "  ██╔████╔██║ ███████║ ██████╔╝ ██╔████╔██║ ██║    ██║    █████╗  ",
    "  ██║╚██╔╝██║ ██╔══██║ ██╔══██╗ ██║╚██╔╝██║ ██║    ██║    ██╔══╝  ",
    "  ██║ ╚═╝ ██║ ██║  ██║ ██║  ██║ ██║ ╚═╝ ██║ ██║    ██║    ███████╗",
    "  ╚═╝     ╚═╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝ ╚═╝     ╚═╝ ╚═╝    ╚═╝    ╚══════╝",
  ];
  const dim = "\x1b[90m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  process.stdout.write("\n");
  for (const line of art) process.stdout.write(`${bold}${line}${reset}\n`);
  process.stdout.write("\n");
  process.stdout.write(`${dim}  AI-driven setup wizard${reset}\n`);
  process.stdout.write(
    `${dim}  I'll inspect your project, ask a few questions, then write your config.${reset}\n`
  );
  process.stdout.write(`${dim}  Press Ctrl+C anytime to abort.${reset}\n\n`);
}
