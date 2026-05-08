import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
import { FRAMEWORK_PATHS, PATHS, setUserRoot } from "../../core/paths.ts";
import { runSkillSession } from "../skill-runner.ts";

// `marmite to-prd <PRD.md>` — converts a markdown PRD into .marmite/prd.json
// using the to-prd skill. After the session, runs validate-prd.ts as a final
// gate; an invalid PRD exits non-zero so the user sees the failure clearly.
export async function runToPrd(argv: string[]): Promise<void> {
  // argv[0]=bun, argv[1]=index.ts, argv[2]="to-prd", argv[3..]=user args.
  const args = argv.slice(3);
  if (args[0] === "-h" || args[0] === "--help") {
    console.log(`Usage: marmite to-prd <path-to-PRD.md>

Converts a markdown PRD into .marmite/prd.json in the current project,
then validates the output. The wizard may ask clarifying questions
about story splits before writing.`);
    process.exit(0);
  }

  const inputArg = args[0];
  if (!inputArg) {
    console.error("Error: marmite to-prd requires a path to a markdown PRD");
    console.error("Usage: marmite to-prd <PRD.md>");
    process.exit(2);
  }
  const inputPath = resolve(inputArg);
  if (!existsSync(inputPath)) {
    console.error(`Error: PRD file not found at ${inputPath}`);
    process.exit(2);
  }

  setUserRoot(process.cwd());
  mkdirSync(resolve(process.cwd(), ".marmite"), { recursive: true });

  const validatePath = resolve(FRAMEWORK_PATHS.internalSkills, "to-prd/validate-prd.ts");
  const outputPath = PATHS.prd;

  const preamble =
    "You are running as the `marmite to-prd` PRD converter for the user's current working directory. " +
    "Follow the instructions below exactly. Use Read/Write/Edit/Bash tools. " +
    "Treat the session as multi-turn: ask the user ONE question at a time when you need confirmation, " +
    "and STOP after each question to wait for their reply.\n\n" +
    `MARMITE_PRD_INPUT=${inputPath}\n` +
    "(Absolute path to the markdown PRD the user wants converted. Read this file first.)\n\n" +
    `MARMITE_PRD_OUTPUT=${outputPath}\n` +
    "(Absolute path where the resulting prd.json must be written. Create the parent directory if needed.)\n\n" +
    `MARMITE_VALIDATE_PRD=${validatePath}\n` +
    "(Absolute path to the validator script. After writing the prd.json, run " +
    "`bun run $MARMITE_VALIDATE_PRD $MARMITE_PRD_OUTPUT`. If validation fails, fix the issues and re-validate " +
    "until the script exits 0 before declaring done.)\n\n";

  await runSkillSession({
    skillName: "to-prd",
    command: "marmite to-prd",
    preamble,
    banner: printToPrdBanner,
  });

  // Defense-in-depth: re-run the validator from the CLI after the session
  // ends. The skill is also told to run it; this catches cases where the
  // agent declared done without validating.
  const result = spawnSync(process.execPath, ["run", validatePath, outputPath], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.stderr.write(
      "\n\x1b[31m✗ .marmite/prd.json failed validation.\x1b[0m " +
      "Re-run `marmite to-prd <PRD.md>` to regenerate.\n",
    );
    process.exit(1);
  }
  process.stdout.write(`\n\x1b[32m✓ wrote ${outputPath}\x1b[0m\n`);
}

function printToPrdBanner(): void {
  const dim = "\x1b[90m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  process.stdout.write("\n");
  process.stdout.write(`${bold}  marmite to-prd${reset}\n`);
  process.stdout.write(`${dim}  Convert a markdown PRD into .marmite/prd.json.${reset}\n`);
  process.stdout.write(`${dim}  Press Ctrl+C anytime to abort.${reset}\n\n`);
}
