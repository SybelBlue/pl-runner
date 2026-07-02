import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./process.js";
import type { Logger } from "./types.js";

export async function validateProjectPath(projectPath: string, logger: Logger): Promise<boolean> {
  try {
    const stat = await fs.stat(projectPath);
    if (!stat.isDirectory()) {
      logger.error(`${projectPath} is not a directory.`);
      return false;
    }
  } catch {
    logger.error(`${projectPath} does not exist.`);
    return false;
  }

  const inside = await git(projectPath, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    logger.error("Project path does not appear to be a git repository.");
    return false;
  }

  const remotes = await git(projectPath, ["remote", "-v"]);
  if (!remotes.stdout.includes("PrairieLearn/PrairieLearn.git")) {
    logger.warn("Project path does not appear to have a PrairieLearn/PrairieLearn.git remote.");
  }

  try {
    await fs.access(path.join(projectPath, "Makefile"));
  } catch {
    logger.warn("Project path does not contain a Makefile.");
  }

  return true;
}

export async function git(cwd: string, args: string[]) {
  return runCommand("git", args, { cwd });
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const result = await git(cwd, ["branch", "--show-current"]);
  const branch = result.stdout.trim();
  return result.status === 0 && branch ? branch : null;
}

export async function repoRoot(cwd: string): Promise<string> {
  const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.status !== 0) throw new Error(result.stderr.trim() || "could not find git root");
  return result.stdout.trim();
}

export async function localBranches(cwd: string): Promise<string[]> {
  const result = await git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("prairielearn/tmp/"));
}

export async function remoteOnlyBranches(cwd: string): Promise<string[]> {
  const result = await git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]);
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== "origin/HEAD")
    .map((line) => line.replace(/^origin\//, ""))
    .filter((line) => line && !line.startsWith("prairielearn/tmp/"));
}

export async function upstreamRef(cwd: string): Promise<{ remote: string; merge: string; tracking: string } | null> {
  const branch = await currentBranch(cwd);
  if (!branch) return null;
  const remote = await git(cwd, ["config", "--get", `branch.${branch}.remote`]);
  const merge = await git(cwd, ["config", "--get", `branch.${branch}.merge`]);
  if (remote.status === 0 && merge.status === 0 && remote.stdout.trim() && merge.stdout.trim()) {
    const remoteName = remote.stdout.trim();
    const mergeRef = merge.stdout.trim();
    return { remote: remoteName, merge: mergeRef, tracking: `${remoteName}/${mergeRef.replace(/^refs\/heads\//, "")}` };
  }

  const tracking = await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (tracking.status !== 0 || !tracking.stdout.trim()) return null;
  const [remoteName] = tracking.stdout.trim().split("/", 1);
  return { remote: remoteName, merge: tracking.stdout.trim().replace(`${remoteName}/`, "refs/heads/"), tracking: tracking.stdout.trim() };
}

export async function revision(cwd: string, ref: string): Promise<string | null> {
  const result = await git(cwd, ["rev-parse", ref]);
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function commitAgeSeconds(cwd: string, ref: string): Promise<number | null> {
  const result = await git(cwd, ["log", "-1", "--format=%ct", ref]);
  const timestamp = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
}
