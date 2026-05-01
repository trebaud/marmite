import { existsSync, readFileSync } from "fs";
import { MarmiteConfigSchema, formatConfigError, type MarmiteConfig } from "../core/config.ts";
import { die } from "./args.ts";

// Strip // line comments, /* */ block comments, and trailing commas — JSONC like tsconfig.
export function stripJsonc(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (ch === '"') {
      const start = i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        i++;
      }
      out += src.slice(start, i);
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function loadConfigFile(path: string): MarmiteConfig {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(readFileSync(path, "utf-8")));
  } catch (err) {
    die(`failed to read config file ${path}: ${err instanceof Error ? err.message : String(err)}`, 2);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    die(`config file ${path} must contain a JSON object`, 2);
  }
  const result = MarmiteConfigSchema.safeParse(parsed);
  if (!result.success) {
    die(`config file ${path} failed schema validation: ${formatConfigError(result.error)}`, 2);
  }
  return result.data;
}
