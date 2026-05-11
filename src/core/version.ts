import { resolve } from "path";
import { readFileSync } from "fs";
import { FRAMEWORK_PATHS } from "./paths.ts";

let cached: string | null = null;

// Read the marmite version from the package.json shipped alongside the CLI.
// Cached because doctor + usage may both ask, and reading is sync.
export function getVersion(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(resolve(FRAMEWORK_PATHS.packageRoot, "package.json"), "utf-8"));
    cached = typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    cached = "unknown";
  }
  return cached ?? "unknown";
}
