import { FRAMEWORK_PATHS } from "../../core/paths.ts";
import { runWizard } from "../wizard.ts";

// `marmite init` — interactive setup wizard. Loads src/skills/marmite-init/SKILL.md
// and runs it as an SDK session in the user's cwd. The skill is responsible for
// inspecting the project, asking questions, and writing marmite.json + copying
// templates/ into the project. PRD generation lives in `marmite to-prd`.
export async function runInit(): Promise<void> {
  const preamble =
    "You are running as the `marmite init` setup wizard for the user's current working directory. " +
    "Follow the instructions below exactly. Use Bash/Read/Write/Edit tools to inspect and modify files. " +
    "Ask the user ONE question at a time and STOP after each question to wait for their reply. " +
    "After they answer, continue to the next step. The session is multi-turn — do not try to answer " +
    "all questions in a single response.\n\n" +
    `MARMITE_TEMPLATES=${FRAMEWORK_PATHS.templates}\n` +
    "(Absolute path to the marmite package's templates tree. The 'install templates' step copies " +
    "this tree into the user's project, preserving structure:\n" +
    "  $MARMITE_TEMPLATES/workflows/<chosen>/prompts/*.md → ./.marmite/prompts/\n" +
    "  $MARMITE_TEMPLATES/skills/<name>/                  → ./.claude/skills/<name>/\n" +
    "The workflow choice is part of the wizard interview. Skip files that already exist in the " +
    "target — they may be user-customized.)\n\n";

  await runWizard({
    skillName: "marmite-init",
    command: "marmite init",
    preamble,
    banner: printInitBanner,
  });
}

function printInitBanner(): void {
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
