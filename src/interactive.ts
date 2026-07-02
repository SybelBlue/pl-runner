import { dockerConfigFromOptions, launchDocker } from "./docker.js";
import { currentBranch, localBranches, remoteOnlyBranches, validateProjectPath } from "./git.js";
import { hasInternet } from "./internet.js";
import { ask, confirm, PromptCanceled, select } from "./prompt.js";
import { previewDockerCommand, previewRunCommand } from "./preview.js";
import { applyOfflineDefaults, launchRun, normalizeRunConfig } from "./run.js";
import { loadSavedConfig, saveConfig } from "./state.js";
import type { DockerConfig, Logger, RunOptions, SavedConfig } from "./types.js";
import { resolvePath, systemTmpDir } from "./path.js";

export async function launchInteractive(baseRun: RunOptions, logger: Logger): Promise<number> {
  try {
    const saved = await loadSavedConfig();
    console.log("PrairieLearn Interactive Launcher");
    const mode = await select(
      "Mode",
      [
        { name: `run with defaults (${previewRunCommand(baseRun)})`, value: "defaults" },
        { name: saved ? `run previous config (${previewSaved(saved)})` : "run previous config", value: "previous" },
        { name: "custom config...", value: "custom" },
        {
          name: `run using docker... (${previewDockerCommand({
            course_path: ".",
            port: "3000:3000",
            tmp_dir: systemTmpDir(),
            local_only: false,
            quiet: baseRun.quiet,
          })})`,
          value: "docker",
        },
      ],
      saved ? "previous" : "defaults",
    );

    if (mode === "defaults") return runDefaults(baseRun, logger);
    if (mode === "previous") return runPrevious(saved, baseRun.quiet, logger);
    if (mode === "custom") return runCustom(baseRun, logger);
    return runDockerInteractive(baseRun.quiet, logger);
  } catch (error) {
    if (error instanceof PromptCanceled) return 130;
    throw error;
  }
}

async function runDefaults(baseRun: RunOptions, logger: Logger): Promise<number> {
  let config = await normalizeRunConfig(baseRun, true, logger);
  if (!config) {
    const projectPath = await ask("Project path", process.env.PRAIRIELEARN_PATH);
    config = await normalizeRunConfig({ ...baseRun, path: projectPath }, true, logger);
  }
  if (!config) return 1;
  showRunConfig(config);
  if (!(await confirm("Run this command now", true))) {
    console.log("Canceled.");
    return 0;
  }
  await saveConfig(config, logger);
  return launchRun(config, logger, true);
}

async function runPrevious(saved: SavedConfig | null, quiet: boolean, logger: Logger): Promise<number> {
  if (!saved) {
    logger.warn("no previous config exists.");
    return 0;
  }
  const config = { ...saved, quiet };
  if (config.mode === "git") {
    config.internet_available = await hasInternet();
    if (!config.path) config.path = await ask("Project path", process.env.PRAIRIELEARN_PATH);
    applyOfflineDefaults(config, logger);
    showRunConfig(config);
    if (!(await confirm("Run this command now", true))) {
      console.log("Canceled.");
      return 0;
    }
    await saveConfig(config, logger);
    return launchRun(config, logger, true);
  }
  showDockerConfig(config);
  if (!(await confirm("Run this command now", true))) {
    console.log("Canceled.");
    return 0;
  }
  await saveConfig(config, logger);
  return launchDocker(config, logger);
}

async function runCustom(baseRun: RunOptions, logger: Logger): Promise<number> {
  const projectPath = resolvePath(await ask("Project path", baseRun.path ?? process.env.PRAIRIELEARN_PATH));
  await validateProjectPath(projectPath, logger);
  const internet_available = await hasInternet();

  let branch: string | null = null;
  const current = await currentBranch(projectPath);
  const local = await localBranches(projectPath);
  const remote = internet_available ? await remoteOnlyBranches(projectPath) : [];
  const defaultBranch = current ? `current (${current})` : "current";
  const branchAnswer = await ask(
    "Launch specific branch",
    defaultBranch,
  );
  if (branchAnswer && branchAnswer !== defaultBranch && branchAnswer !== "current") {
    if (!internet_available && local.length > 0 && !local.includes(branchAnswer)) {
      logger.warn("offline: branch must be available locally.");
      return runCustom(baseRun, logger);
    }
    branch = branchAnswer.replace(/^origin\//, "");
  }
  if (remote.length > 0) logger.debug(`available remote branches: ${remote.join(", ")}`);

  const config = {
    mode: "git" as const,
    path: projectPath,
    branch,
    force_rebuild: await confirm("Rebuild all dependencies", baseRun.force_rebuild),
    local_only: await confirm("Use local checkout only", baseRun.local_only),
    no_watch_upstream: baseRun.no_watch_upstream,
    internet_available,
    quiet: baseRun.quiet,
  };
  if (!config.local_only) {
    const watch = await confirm("Watch upstream and restart when it changes", !baseRun.no_watch_upstream);
    config.no_watch_upstream = !watch;
  }
  applyOfflineDefaults(config, logger);
  showRunConfig(config);
  if (!(await confirm("Run this command now", true))) {
    console.log("Canceled.");
    return 0;
  }
  await saveConfig(config, logger);
  return launchRun(config, logger, true);
}

async function runDockerInteractive(quiet: boolean, logger: Logger): Promise<number> {
  const course_path = await ask("Course directory", ".");
  const port = await ask("Port mapping", "3000:3000");
  const tmpAnswer = await ask("Jobs directory", "(make temp)");
  const tmp_dir = tmpAnswer === "(make temp)" ? systemTmpDir() : tmpAnswer;
  const local_only = await confirm("Use local Docker image only", false);
  const config: DockerConfig = await dockerConfigFromOptions({ course_path, port, tmp_dir, local_only, quiet });
  showDockerConfig(config);
  if (!(await confirm("Run this command now", true))) {
    console.log("Canceled.");
    return 0;
  }
  await saveConfig(config, logger);
  return launchDocker(config, logger);
}

function previewSaved(config: SavedConfig): string {
  return config.mode === "git" ? previewRunCommand(config) : previewDockerCommand(config);
}

function showRunConfig(config: RunOptions & { path: string; internet_available?: boolean }): void {
  console.table({
    mode: "git",
    path: config.path,
    branch: config.branch ?? "",
    force_rebuild: config.force_rebuild,
    local_only: config.local_only,
    no_watch_upstream: config.no_watch_upstream,
    internet_available: config.internet_available,
    quiet: config.quiet,
  });
  console.log(previewRunCommand(config));
}

function showDockerConfig(config: DockerConfig): void {
  console.table({
    mode: "docker",
    course_path: config.course_path,
    port: config.port,
    tmp_dir: config.tmp_dir,
    local_only: config.local_only,
    quiet: config.quiet,
  });
  console.log(previewDockerCommand(config));
}
