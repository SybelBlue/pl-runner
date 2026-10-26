import { hasInternet } from "../system/internet.js";
import { createBranchWorktree } from "./worktree.js";
import { git, validateProjectPath } from "../system/git.js";
import { resolvePath, withoutVirtualEnv } from "../system/path.js";
import { runInteractiveProcess } from "../system/process.js";
import { ensureIsolatedDatabase, writeEffectivePrairieLearnConfig } from "./prairielearn-config.js";
import { startUpstreamWatch } from "./watch.js";
import type { CommandResult, GitConfig, Logger, RunOptions } from "../core/types.js";

export type LaunchControl = {
  allowPullFailure?: boolean;
  startDockerDaemon?: boolean;
  shouldStop?: () => boolean;
  onState?: (state: "preparing" | "starting" | "running") => void;
  onProcess?: (terminate: (signal?: NodeJS.Signals) => void) => void;
  onSpawn?: (pid: number | undefined) => void;
  onOutput?: (source: "stdout" | "stderr", chunk: string, phase: string) => void;
  onFailure?: (code: string, message: string) => void;
};

export type LaunchRuntime = {
  instanceId: string;
  runDir: string;
  env?: NodeJS.ProcessEnv;
};

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
    port: options.port ?? 3000,
    isolated_database: options.isolated_database,
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

export async function launchRun(
  config: GitConfig,
  logger: Logger,
  _interactive = false,
  control: LaunchControl = {},
  runtime?: LaunchRuntime,
): Promise<number> {
  control.onState?.("preparing");
  if (!(await validateProjectPath(config.path, logger))) {
    control.onFailure?.("INVALID_CONFIG", "PrairieLearn path is not a valid Git checkout");
    return 1;
  }

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

    if (control.shouldStop?.()) return 130;

    if (!config.local_only) {
      const pull = await git(launchPath, ["pull"]);
      if (pull.status !== 0) {
        logGitPullFailure(pull, launchPath, logger);
        if (!control.allowPullFailure) {
          control.onFailure?.("PULL_FAILED", `git pull exited with ${pull.status}`);
          return pull.status;
        }
        logger.warn("continuing with the local checkout after git pull failed.");
      }
    }

    if (control.shouldStop?.()) return 130;

    let launchEnv = withoutVirtualEnv(runtime?.env);
    if (runtime) {
      const effective = await writeEffectivePrairieLearnConfig({
        launchPath,
        runDir: runtime.runDir,
        instanceId: runtime.instanceId,
        port: config.port,
        isolatedDatabase: config.isolated_database,
        env: runtime.env,
      });
      launchEnv = { ...launchEnv, PL_CONFIG_PATH: effective.path };
      if (effective.databaseName) {
        logger.info("starting PrairieLearn support services for isolated database setup...");
        const supportStatus = await runInteractiveProcess("make", ["-C", launchPath, "start-support"], {
          quiet: config.quiet,
          env: launchEnv,
          handleSignals: false,
          onSpawn: control.onSpawn,
          onExitRequest: control.onProcess,
          onOutput: (source, chunk) => control.onOutput?.(source, chunk, "database"),
        });
        if (supportStatus !== 0) {
          const message = `PrairieLearn support services exited with ${supportStatus}`;
          control.onFailure?.("DATABASE_PREPARATION_FAILED", message);
          logger.error(message);
          return supportStatus;
        }
        try {
          await ensureIsolatedDatabase(effective.databaseName, logger);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          control.onFailure?.("DATABASE_PREPARATION_FAILED", message);
          logger.error(message);
          return 1;
        }
      }
    }

    let rebuild = config.force_rebuild || (branchWorktree && config.internet_available);
    while (true) {
      if (rebuild) {
        const deps = await runMakeDeps(launchPath, config.quiet, logger, control);
        if (deps !== 0) return deps;
      }

      if (control.shouldStop?.()) return 130;

      logger.info("launching prairielearn...");
      logger.info("--- make dev ---");

      let terminateMake: ((signal?: NodeJS.Signals) => void) | undefined;
      const watcher =
        !config.local_only && !config.no_watch_upstream
          ? await startUpstreamWatch(launchPath, logger, (signal) => terminateMake?.(signal))
          : null;

      control.onState?.("starting");
      const status = await runInteractiveProcess("make", ["-C", launchPath, "dev"], {
        quiet: config.quiet,
        env: { ...launchEnv, FORCE_COLOR: "1" },
        handleSignals: false,
        onSpawn: (pid) => {
          control.onSpawn?.(pid);
          control.onState?.("running");
        },
        onOutput: (source, chunk) => control.onOutput?.(source, chunk, "server"),
        onExitRequest: (terminate) => {
          terminateMake = terminate;
          control.onProcess?.(terminate);
        },
      });
      watcher?.stop();

      if (watcher?.didRestart()) {
        rebuild = true;
        control.onState?.("preparing");
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

function logGitPullFailure(result: CommandResult, cwd: string, logger: Logger): void {
  logger.warn(`git pull exited with ${result.status}`);
  logger.warn(`command: git pull`);
  logger.warn(`directory: ${cwd}`);
  logCommandOutput("stderr", result.stderr, logger);
  logCommandOutput("stdout", result.stdout, logger);
}

function logCommandOutput(label: string, output: string, logger: Logger): void {
  const trimmed = output.trim();
  if (!trimmed) return;
  logger.warn(`${label}:`);
  for (const line of truncateLines(trimmed).split(/\r?\n/)) {
    logger.warn(`  ${line}`);
  }
}

function truncateLines(value: string, maxLines = 20): string {
  const lines = value.split(/\r?\n/);
  if (lines.length <= maxLines) return value;
  const omitted = lines.length - maxLines;
  return [...lines.slice(0, maxLines), `... ${omitted} more line${omitted === 1 ? "" : "s"} omitted`].join("\n");
}

async function runMakeDeps(
  projectPath: string,
  quiet: boolean,
  logger: Logger,
  control: LaunchControl,
): Promise<number> {
  logger.info("--- make deps ---");
  const status = await runInteractiveProcess("make", ["-C", projectPath, "deps"], {
    quiet,
    env: { ...withoutVirtualEnv(), FORCE_COLOR: "1" },
    handleSignals: false,
    onSpawn: control.onSpawn,
    onExitRequest: control.onProcess,
    onOutput: (source, chunk) => control.onOutput?.(source, chunk, "dependencies"),
  });
  if (status !== 0) logger.warn(`make deps exited with ${status}`);
  return status;
}
