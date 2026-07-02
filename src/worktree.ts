import fs from "node:fs/promises";
import path from "node:path";
import { formatRelativeTime } from "./format.js";
import { git, repoRoot } from "./git.js";
import type { Logger } from "./types.js";

export type WorktreeInfo = {
  path: string;
  tempBranch: string;
  cleanup: () => Promise<void>;
};

export function branchSlug(ref: string): string {
  return ref.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "ref";
}

export async function createBranchWorktree(
  sourcePath: string,
  branch: string,
  online: boolean,
  localOnly: boolean,
  logger: Logger,
): Promise<WorktreeInfo> {
  const root = await repoRoot(sourcePath);
  const slug = branchSlug(branch);
  const worktreePath = await fs.mkdtemp(path.join("/private/tmp", `prairielearn-${slug}.`));
  const tempBranch = `prairielearn/tmp/${slug}-${path.basename(worktreePath)}`;

  if (online && !localOnly) {
    await git(root, ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  }

  const startRef = await pickStartRef(root, branch);
  const add = await git(root, ["worktree", "add", "-b", tempBranch, worktreePath, startRef]);
  if (add.status !== 0) {
    await fs.rm(worktreePath, { force: true, recursive: true });
    throw new Error(add.stderr.trim() || `could not create worktree for ${branch}`);
  }

  if (startRef === `origin/${branch}`) {
    await git(worktreePath, ["branch", "--set-upstream-to", `origin/${branch}`, tempBranch]);
  }

  await copyQuestionConversionDist(root, worktreePath);

  return {
    path: worktreePath,
    tempBranch,
    cleanup: async () => {
      logger.info("cleaning worktree...");
      await git(root, ["worktree", "remove", "--force", worktreePath]);
      logger.info("cleaning temp branch...");
      await git(root, ["branch", "-D", tempBranch]);
    },
  };
}

async function pickStartRef(root: string, branch: string): Promise<string> {
  for (const ref of [`origin/${branch}`, branch]) {
    const result = await git(root, ["rev-parse", "--verify", ref]);
    if (result.status === 0) return ref;
  }
  const commitish = await git(root, ["rev-parse", "--verify", branch]);
  if (commitish.status === 0) return branch;
  throw new Error(`could not resolve branch/ref ${branch}`);
}

async function copyQuestionConversionDist(sourceRoot: string, targetRoot: string): Promise<void> {
  const relative = path.join("packages", "question-conversion", "dist");
  const source = path.join(sourceRoot, relative);
  const targetPackage = path.join(targetRoot, "packages", "question-conversion");
  try {
    const [sourceStat, targetPackageStat] = await Promise.all([fs.stat(source), fs.stat(targetPackage)]);
    if (!sourceStat.isDirectory() || !targetPackageStat.isDirectory()) return;
    await fs.cp(source, path.join(targetPackage, "dist"), { recursive: true, force: true });
  } catch {
    // Optional cache copy.
  }
}

export { formatRelativeTime };
