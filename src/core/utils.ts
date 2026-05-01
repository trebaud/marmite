import { rename, unlink } from "fs/promises";
import { resolve } from "path";
import { spawnSync } from "child_process";
import type { Reporter } from "./reporter.ts";

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function formatDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type ReadState<T> =
  | { kind: "present"; value: T }
  | { kind: "missing" }
  | { kind: "malformed"; error: Error; raw?: string };

export async function readJson<T = unknown>(path: string): Promise<ReadState<T>> {
  if (!(await fileExists(path))) return { kind: "missing" };
  let raw = "";
  try {
    raw = await Bun.file(path).text();
  } catch (err) {
    return { kind: "malformed", error: err instanceof Error ? err : new Error(String(err)) };
  }
  if (raw.trim() === "") return { kind: "missing" };
  try {
    return { kind: "present", value: JSON.parse(raw) as T };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return { kind: "malformed", error: e, raw };
  }
}

export async function readTextState(path: string): Promise<ReadState<string>> {
  if (!(await fileExists(path))) return { kind: "missing" };
  try {
    return { kind: "present", value: await Bun.file(path).text() };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return { kind: "malformed", error: e };
  }
}

export async function readJsonField(path: string, field: string): Promise<string> {
  const r = await readJson<Record<string, unknown>>(path);
  if (r.kind !== "present") return "";
  const v = r.value?.[field];
  return typeof v === "string" ? v : "";
}

export async function readText(path: string): Promise<string> {
  const r = await readTextState(path);
  return r.kind === "present" ? r.value : "";
}

export async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

export async function writeAtomic(
  path: string,
  content: string | ArrayBuffer | Uint8Array,
): Promise<void> {
  const abs = resolve(path);
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  try {
    await Bun.write(tmp, content);
    await rename(tmp, abs);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {}
    throw err;
  }
}

export async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

export type ErrorCategory = "transient" | "fatal" | "aborted" | "timeout";

export function classifyError(err: unknown): { category: ErrorCategory; message: string; code?: string } {
  if (err == null) return { category: "fatal", message: "unknown error" };
  const e = err as { name?: string; code?: string; status?: number; message?: string };
  const message = e.message ?? String(err);
  const code = e.code ?? (e.status != null ? String(e.status) : undefined);

  if (e.name === "AbortError" || message.includes("aborted")) {
    return { category: "aborted", message, code };
  }
  if (message.toLowerCase().includes("timeout") || code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return { category: "timeout", message, code };
  }
  if (
    e.status === 429 ||
    e.status === 408 ||
    (typeof e.status === "number" && e.status >= 500 && e.status < 600) ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE"
  ) {
    return { category: "transient", message, code };
  }
  return { category: "fatal", message, code };
}

export function gitEnsureBranch(cwd: string, branchName: string, reporter: Reporter): void {
  const current = spawnSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" });
  if (current.stdout?.trim() === branchName) {
    reporter.branchSetup(branchName, "already_on");
    return;
  }
  const exists = spawnSync("git", ["show-ref", "--verify", `refs/heads/${branchName}`], { cwd });
  if (exists.status === 0) {
    const r = spawnSync("git", ["checkout", branchName], { cwd, stdio: "inherit" });
    if (r.status !== 0) { reporter.error(`git checkout ${branchName}`, `exit ${r.status ?? "?"}`, "git"); return; }
    reporter.branchSetup(branchName, "switched");
  } else {
    const r = spawnSync("git", ["checkout", "-b", branchName], { cwd, stdio: "inherit" });
    if (r.status !== 0) { reporter.error(`git checkout -b ${branchName}`, `exit ${r.status ?? "?"}`, "git"); return; }
    reporter.branchSetup(branchName, "created");
  }
}

export function gitCommit(cwd: string, path: string, message: string, reporter: Reporter): void {
  const add = spawnSync("git", ["add", path], { cwd, stdio: "inherit" });
  if (add.status !== 0) {
    reporter.error(`git add ${path}`, `exit ${add.status}`, "git");
    return;
  }
  const commit = spawnSync("git", ["commit", "-m", message], { cwd, stdio: "inherit" });
  if (commit.status !== 0) {
    reporter.error(`git commit for ${path}`, `exit ${commit.status}`, "git");
  }
}
