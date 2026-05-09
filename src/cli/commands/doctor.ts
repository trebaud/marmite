import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { FRAMEWORK_PATHS, PATHS, setUserRoot, resolvePrompt, type PromptName } from "../../core/paths.ts";
import { MarmiteConfigSchema, formatConfigError, type MarmiteConfig } from "../../core/config.ts";
import { stripJsonc } from "../config.ts";

// `marmite doctor` — preflight checker. Validates that the user's project is
// shaped the way the harness and agent prompts expect: config parses, prompt
// files exist, contract-fenced regions in the user's prompts still match the
// shipped templates for the configured workflow, sensor config files referenced
// in marmite.json resolve, and `.marmite/` artifacts are tracked (not gitignored).

type Severity = "ok" | "warn" | "fail";
interface Finding {
  severity: Severity;
  message: string;
  detail?: string;
}

const ROLES: PromptName[] = ["orchestrator", "builder", "verifier"];

export async function runDoctor(argv: string[]): Promise<void> {
  const args = argv.slice(3);
  if (args[0] === "-h" || args[0] === "--help") {
    console.log(`Usage: marmite doctor

Runs a battery of preflight checks against the current marmite project.
Exit code is non-zero if any check fails (warnings are tolerated).`);
    process.exit(0);
  }

  const projectRoot = process.cwd();
  setUserRoot(projectRoot);

  const findings: Finding[] = [];

  // 1. marmite.json exists and parses
  const configPath = resolve(projectRoot, "marmite.json");
  let config: MarmiteConfig | undefined;
  if (!existsSync(configPath)) {
    findings.push({
      severity: "fail",
      message: "marmite.json not found",
      detail: `expected at ${configPath} — run \`marmite init\``,
    });
  } else {
    try {
      const raw = JSON.parse(stripJsonc(readFileSync(configPath, "utf-8")));
      const parsed = MarmiteConfigSchema.safeParse(raw);
      if (parsed.success) {
        config = parsed.data;
        findings.push({ severity: "ok", message: "marmite.json parses" });
      } else {
        findings.push({
          severity: "fail",
          message: "marmite.json failed schema validation",
          detail: formatConfigError(parsed.error),
        });
      }
    } catch (err) {
      findings.push({
        severity: "fail",
        message: "marmite.json is not valid JSON",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. Workflow name resolves to a shipped template
  const workflow = config?.workflow;
  let workflowDir: string | undefined;
  if (config !== undefined) {
    if (!workflow) {
      findings.push({
        severity: "warn",
        message: "marmite.json has no `workflow` field",
        detail: "doctor cannot verify prompt fences without a configured workflow",
      });
    } else {
      const candidate = resolve(FRAMEWORK_PATHS.templates, "workflows", workflow);
      if (isDir(candidate)) {
        workflowDir = candidate;
        findings.push({ severity: "ok", message: `workflow "${workflow}" resolves to a shipped template` });
      } else {
        findings.push({
          severity: "fail",
          message: `workflow "${workflow}" is not a shipped template`,
          detail: `expected ${candidate} to exist — typo or removed workflow?`,
        });
      }
    }
  }

  // 3. App directory exists
  if (config !== undefined) {
    const appRel = config.app ?? "./app";
    const appAbs = resolve(projectRoot, appRel);
    if (isDir(appAbs)) {
      findings.push({ severity: "ok", message: `app directory ${appRel} exists` });
    } else {
      findings.push({
        severity: "fail",
        message: `app directory ${appRel} does not exist`,
        detail: `marmite.json points app → ${appAbs}, which is not a directory`,
      });
    }
  }

  // 4. .marmite/ layout — directory and prompt files
  const marmiteDir = resolve(projectRoot, ".marmite");
  if (!isDir(marmiteDir)) {
    findings.push({
      severity: "fail",
      message: ".marmite/ directory missing",
      detail: `expected at ${marmiteDir} — run \`marmite init\``,
    });
  } else {
    findings.push({ severity: "ok", message: ".marmite/ directory present" });
    for (const role of ROLES) {
      const p = resolvePrompt(role);
      if (existsSync(p)) {
        findings.push({ severity: "ok", message: `.marmite/prompts/${role}-prompt.md present` });
      } else {
        findings.push({
          severity: "fail",
          message: `.marmite/prompts/${role}-prompt.md missing`,
          detail: `run \`marmite init\` to reinstall prompts`,
        });
      }
    }
  }

  // 5. Contract fences — for each role, every fenced region in the user's prompt
  // must match the shipped template's fenced region (same count, same body).
  if (workflowDir) {
    for (const role of ROLES) {
      const userPath = resolvePrompt(role);
      const shippedPath = resolve(workflowDir, "prompts", `${role}-prompt.md`);
      if (!existsSync(userPath) || !existsSync(shippedPath)) continue;
      const userFences = extractFences(readFileSync(userPath, "utf-8"));
      const shippedFences = extractFences(readFileSync(shippedPath, "utf-8"));
      const where = `.marmite/prompts/${role}-prompt.md`;
      if (userFences.length !== shippedFences.length) {
        findings.push({
          severity: "fail",
          message: `${where}: contract fence count drift`,
          detail: `expected ${shippedFences.length} fenced region(s), found ${userFences.length} — a load-bearing block was removed or duplicated`,
        });
        continue;
      }
      let allMatch = true;
      for (let i = 0; i < shippedFences.length; i++) {
        if (userFences[i]!.body !== shippedFences[i]!.body) {
          allMatch = false;
          findings.push({
            severity: "fail",
            message: `${where}: contract fence #${i + 1} drifted from shipped template`,
            detail: `reason: ${shippedFences[i]!.reason}\nedit the prose around the fence rather than the fenced block, or run \`marmite init\` to reinstall`,
          });
        }
      }
      if (allMatch && shippedFences.length > 0) {
        findings.push({ severity: "ok", message: `${where}: ${shippedFences.length} contract fence(s) match` });
      }
    }
  }

  // 6. .gitignore must NOT exclude any .marmite/ artifacts (team shares full history)
  const gitignorePath = resolve(projectRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    const lines = readFileSync(gitignorePath, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    const offenders = lines.filter((l) => /(^|\/)\.marmite($|\/)/.test(l) || /\.marmite\/.+/.test(l));
    if (offenders.length === 0) {
      findings.push({ severity: "ok", message: ".gitignore does not exclude any .marmite/ artifacts" });
    } else {
      findings.push({
        severity: "fail",
        message: ".gitignore is excluding .marmite/ artifacts",
        detail: `offending pattern(s): ${offenders.join(", ")} — everything in .marmite/ must be tracked`,
      });
    }
  }
  // (no .gitignore at all is fine — nothing is being excluded)

  // 7. Sensor configPath files exist
  if (config?.sensors && config.sensors.length > 0) {
    for (const sensor of config.sensors) {
      if (!sensor.configPath) continue;
      const abs = resolve(projectRoot, sensor.configPath);
      if (existsSync(abs)) {
        findings.push({ severity: "ok", message: `sensor "${sensor.name}" configPath resolves (${sensor.configPath})` });
      } else {
        findings.push({
          severity: "fail",
          message: `sensor "${sensor.name}" configPath does not exist`,
          detail: `${sensor.configPath} → ${abs} — the orchestrator surfaces this as a setup gap; create the config or remove the entry`,
        });
      }
    }
  } else if (config !== undefined) {
    findings.push({
      severity: "warn",
      message: "no sensors declared in marmite.json",
      detail: "the run will proceed without lint/drift/test/security signals",
    });
  }

  // 8. PRD exists (warn — `marmite to-prd` may not have run yet)
  if (!existsSync(PATHS.prd)) {
    findings.push({
      severity: "warn",
      message: ".marmite/prd.json missing",
      detail: `run \`marmite to-prd <PRD.md>\` before \`marmite cook\``,
    });
  } else {
    findings.push({ severity: "ok", message: ".marmite/prd.json present" });
  }

  // ── Render ──
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const f of findings) counts[f.severity]++;
  for (const f of findings) {
    const tag = f.severity === "ok" ? "[ok]  " : f.severity === "warn" ? "[warn]" : "[fail]";
    console.log(`${tag} ${f.message}`);
    if (f.detail) {
      for (const line of f.detail.split("\n")) console.log(`       ${line}`);
    }
  }
  console.log("");
  console.log(`${counts.ok} ok, ${counts.warn} warn, ${counts.fail} fail`);
  process.exit(counts.fail > 0 ? 1 : 0);
}

interface Fence {
  reason: string;
  body: string;
}

const FENCE_RE =
  /<!--\s*marmite:contract start\s*[—-]\s*([^]*?)-->\s*\n([\s\S]*?)\n\s*<!--\s*marmite:contract end\s*-->/g;

export function extractFences(src: string): Fence[] {
  const out: Fence[] = [];
  for (const m of src.matchAll(FENCE_RE)) {
    out.push({ reason: m[1]!.trim(), body: m[2]! });
  }
  return out;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
