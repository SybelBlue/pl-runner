import { confirm } from "./prompt.js";
import { hasInternet } from "./internet.js";
import { createBranchWorktree } from "./worktree.js";
import { git, validateProjectPath } from "./git.js";
import { resolvePath, withoutVirtualEnv } from "./path.js";
import { runInteractiveProcess } from "./process.js";
import { startUpstreamWatch } from "./watch.js";
import type { GitConfig, Logger, RunOptions } from "./types.js";

export async function normalizeRunConfig(options: RunOptions, interactive: boolean, logger: Logger): Promise<GitConfig | null> {
  const rawPath = options.path ?? process.env.PRAIRIELEARN_PATH;
  if (!rawPath) {
    if (!interactive) logger.error("pass --path or set PRAIRIELEARN_PATH");
    return null;
  }
  const internet_available = options.internet_available ?? (await hasInternet());
  const config: GitConfig = {
    mode: "git",
    path: resolvePath(rawPath),
    branch: options.branch ?? null,
    force_rebuild: options.force_rebuild,
    local_only: options.local_only,
    no_watch_upstream: options.no_watch_upstream,
    internet_available,
    quiet: options.quiet,
  };
  applyOfflineDefaults(config, logger);
  return config;
}

export function applyOfflineDefaults(config: GitConfig, logger: Logger): void {
  if (config.internet_available) return;
  if (!config.local_only) logger.warn("offline: disabling pulling and using local checkout only.");
  if (!config.no_watch_upstream) logger.warn("offline: disabling upstream watching.");
  if (config.force_rebuild) logger.warn("offline: disabling dependency rebuild.");
  config.local_only = true;
  config.no_watch_upstream = true;
  config.force_rebuild = false;
}

export async function launchRun(config: GitConfig, logger: Logger, interactive = false): Promise<number> {
  if (!(await validateProjectPath(config.path, logger))) return 1;

  let launchPath = config.path;
  let cleanup: (() => Promise<void>) | undefined;
  let branchWorktree = false;

  try {
    if (config.branch) {
      const worktree = await createBranchWorktree(
        config.path,
        config.branch,
        config.internet_available,
        config.local_only,
        logger,
      );
      launchPath = worktree.path;
      cleanup = worktree.cleanup;
      branchWorktree = true;
    }

    if (!config.local_only) {
      const pull = await git(launchPath, ["pull"]);
      if (pull.status !== 0) {
        logger.warn(`git pull exited with ${pull.status}`);
        const shouldContinue = interactive ? await confirm("Continue anyway", false) : false;
        if (!shouldContinue) return pull.status;
      }
    }

    let rebuild = config.force_rebuild || (branchWorktree && config.internet_available);
    while (true) {
      if (rebuild) {
        const deps = await runMakeDeps(launchPath, config.quiet, logger);
        if (deps !== 0) return deps;
      }

      logger.info("launching prairielearn...");
      logger.info("--- make dev ---");

      let terminateMake: ((signal?: NodeJS.Signals) => void) | undefined;
      const watcher =
        !config.local_only && !config.no_watch_upstream
          ? await startUpstreamWatch(launchPath, logger, (signal) => terminateMake?.(signal))
          : null;

      const status = await runInteractiveProcess("make", ["-C", launchPath, "dev"], {
        quiet: config.quiet,
        env: { ...withoutVirtualEnv(), FORCE_COLOR: "1" },
        onExitRequest: (terminate) => {
          terminateMake = terminate;
        },
      });
      watcher?.stop();

      if (watcher?.didRestart()) {
        rebuild = true;
        continue;
      }
      logger.info(`make dev exited with ${status}`);
      return status;
    }
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    if (cleanup) await cleanup();
  }
}

async function runMakeDeps(projectPath: string, quiet: boolean, logger: Logger): Promise<number> {
  logger.info("--- make deps ---");
  const status = await runInteractiveProcess("make", ["-C", projectPath, "deps"], {
    quiet,
    env: withoutVirtualEnv(),
  });
  if (status !== 0) logger.warn(`make deps exited with ${status}`);
  return status;
}
