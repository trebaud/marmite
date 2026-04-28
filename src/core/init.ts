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
  function readLine(): Promise<string | null> {
    return new Promise((resolve) => {
      rl.once("line", (line) => resolve(line));
      rl.once("close", () => resolve(null));
    });
  }

  async function* userStream(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content: preamble + skillContent },
      parent_tool_use_id: null,
    };
    while (true) {
      process.stdout.write("\n> ");
      const line = await readLine();
      if (line === null) return;
      yield {
        type: "user",
        message: { role: "user", content: line },
        parent_tool_use_id: null,
      };
    }
  }

  const abort = new AbortController();
  process.on("SIGINT", () => abort.abort());
  process.on("SIGTERM", () => abort.abort());

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
            process.stdout.write(block.text);
          } else if (block.type === "tool_use") {
            const name = block.name ?? "tool";
            process.stdout.write(`\n\x1b[90m· ${name}\x1b[0m`);
          }
        }
      }
    }
  } finally {
    rl.close();
  }

  process.stdout.write("\n");
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
