import { dockerConfigFromOptions, launchDocker } from "./docker.js";
import { currentBranch, localBranches, remoteOnlyBranches, validateProjectPath } from "./git.js";
import { hasInternet } from "./internet.js";
import { ask, confirm, endPrompt, PromptCanceled, select, showNote, startPrompt, withSpinner } from "./prompt.js";
import { previewDockerCommand, previewRunCommand } from "./preview.js";
import { applyOfflineDefaults, launchRun, normalizeRunConfig } from "./run.js";
import { loadSavedConfig, saveConfig } from "./state.js";
import type { DockerConfig, Logger, RunOptions, SavedConfig } from "./types.js";
import { resolvePath, systemTmpDir } from "./path.js";

type LauncherMode = "defaults" | "previous" | "custom" | "docker";

type Preflight = {
  saved: SavedConfig | null;
  internet_available: boolean;
  configuredPath: string | null;
  currentBranch: string | null;
};

export async function launchInteractive(baseRun: RunOptions, logger: Logger): Promise<number> {
  try {
    startPrompt("PrairieLearn launcher", baseRun.quiet);
    const preflight = await loadPreflight(baseRun, logger);
    const mode = await select(
      "What do you want to launch?",
      launcherChoices(preflight, baseRun),
      recommendedLauncherMode(preflight),
    );

    if (mode === "defaults") return runDefaults({ ...baseRun, internet_available: preflight.internet_available }, logger);
    if (mode === "previous") return runPrevious(preflight.saved, baseRun.quiet, logger);
    if (mode === "custom") return runCustom({ ...baseRun, internet_available: preflight.internet_available }, logger);
    return runDockerInteractive(baseRun.quiet, logger);
  } catch (error) {
    if (error instanceof PromptCanceled) return 130;
    throw error;
  }
}

async function loadPreflight(baseRun: RunOptions, logger: Logger): Promise<Preflight> {
  const [saved, internet_available] = await Promise.all([
    loadSavedConfig(),
    withSpinner("Checking network", () => hasInternet(), baseRun.quiet),
  ]);
  const configuredPath = baseRun.path ?? process.env.PRAIRIELEARN_PATH ?? null;
  const current = configuredPath ? await currentBranch(resolvePath(configuredPath)) : null;

  const details = [
    `network: ${internet_available ? "online" : "offline"}`,
    configuredPath ? `project: ${resolvePath(configuredPath)}` : "project: not configured",
    current ? `branch: ${current}` : null,
    saved ? `previous: ${previewSaved(saved)}` : null,
  ].filter(Boolean);
  showNote(details.join("\n"), "Detected", baseRun.quiet);

  if (!internet_available) logger.debug("network unavailable during launcher preflight");
  return { saved, internet_available, configuredPath, currentBranch: current };
}

export function recommendedLauncherMode(preflight: Pick<Preflight, "saved" | "configuredPath">): LauncherMode {
  if (preflight.saved) return "previous";
  if (preflight.configuredPath) return "defaults";
  return "docker";
}

export function launcherChoices(
  preflight: Pick<Preflight, "saved" | "configuredPath" | "currentBranch">,
  baseRun: RunOptions,
): Array<{ name: string; value: LauncherMode; hint?: string; disabled?: boolean }> {
  const dockerPreview = previewDockerCommand({
    course_path: ".",
    port: "3000:3000",
    tmp_dir: systemTmpDir(),
    local_only: false,
    quiet: baseRun.quiet,
  });

  return [
    {
      name: "Run previous config",
      value: "previous",
      hint: preflight.saved ? previewSaved(preflight.saved) : "No saved config yet",
      disabled: !preflight.saved,
    },
    {
      name: preflight.currentBranch ? `Run configured checkout (${preflight.currentBranch})` : "Run configured checkout",
      value: "defaults",
      hint: preflight.configuredPath ? previewRunCommand(baseRun) : "Needs --path or PRAIRIELEARN_PATH",
      disabled: !preflight.configuredPath,
    },
    { name: "Configure git checkout", value: "custom", hint: "Choose path, branch, rebuild, and watch options" },
    { name: "Run with Docker", value: "docker", hint: dockerPreview },
  ];
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
    endPrompt("Canceled.", config.quiet);
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
      endPrompt("Canceled.", config.quiet);
      return 0;
    }
    await saveConfig(config, logger);
    return launchRun(config, logger, true);
  }
  showDockerConfig(config);
  if (!(await confirm("Run this command now", true))) {
    endPrompt("Canceled.", config.quiet);
    return 0;
  }
  await saveConfig(config, logger);
  return launchDocker(config, logger);
}

async function runCustom(baseRun: RunOptions, logger: Logger): Promise<number> {
  const projectPath = resolvePath(await ask("Project path", baseRun.path ?? process.env.PRAIRIELEARN_PATH));
  if (!(await validateProjectPath(projectPath, logger))) return 1;
  const internet_available = baseRun.internet_available ?? (await hasInternet());

  const current = await currentBranch(projectPath);
  const local = await localBranches(projectPath);
  const remote = internet_available ? await remoteOnlyBranches(projectPath) : [];
  const branch = await askBranch(current, local, remote, internet_available, logger);
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
    endPrompt("Canceled.", config.quiet);
    return 0;
  }
  await saveConfig(config, logger);
  return launchRun(config, logger, true);
}

async function askBranch(
  current: string | null,
  local: string[],
  remote: string[],
  internet_available: boolean,
  logger: Logger,
): Promise<string | null> {
  const branchChoices = uniqueBranches(current, local, remote);
  if (branchChoices.length === 0) {
    const branch = await ask("Launch specific branch", "current");
    return branch === "current" ? null : branch.replace(/^origin\//, "");
  }

  const selected = await select(
    "Branch",
    [
      { name: current ? `Current branch (${current})` : "Current branch", value: "__current", hint: "Use the checkout as-is" },
      ...branchChoices.map((branch) => ({
        name: branch,
        value: branch,
        hint: local.includes(branch) ? "local" : "origin",
      })),
      { name: "Type another branch", value: "__custom", hint: internet_available ? "Fetchable branch or ref" : "Must exist locally" },
    ],
    "__current",
  );

  if (selected === "__current") return null;
  if (selected !== "__custom") return selected;

  const branch = (await ask("Branch or ref", current ?? "main")).replace(/^origin\//, "");
  if (!internet_available && local.length > 0 && !local.includes(branch)) {
    logger.warn("offline: branch must be available locally.");
    return askBranch(current, local, remote, internet_available, logger);
  }
  return branch;
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
    endPrompt("Canceled.", config.quiet);
    return 0;
  }
  await saveConfig(config, logger);
  return launchDocker(config, logger);
}

function previewSaved(config: SavedConfig): string {
  return config.mode === "git" ? previewRunCommand(config) : previewDockerCommand(config);
}

function showRunConfig(config: RunOptions & { path: string; internet_available?: boolean }): void {
  showNote(
    [
      `mode: git`,
      `path: ${config.path}`,
      `branch: ${config.branch ?? "current"}`,
      `force rebuild: ${config.force_rebuild}`,
      `local only: ${config.local_only}`,
      `watch upstream: ${!config.no_watch_upstream}`,
      `network: ${config.internet_available === false ? "offline" : "online"}`,
      "",
      previewRunCommand(config),
    ].join("\n"),
    "Ready",
    config.quiet,
  );
}

function showDockerConfig(config: DockerConfig): void {
  showNote(
    [
      `mode: docker`,
      `course: ${config.course_path}`,
      `port: ${config.port}`,
      `jobs directory: ${config.tmp_dir}`,
      `local image only: ${config.local_only}`,
      "",
      previewDockerCommand(config),
    ].join("\n"),
    "Ready",
    config.quiet,
  );
}

function uniqueBranches(current: string | null, local: string[], remote: string[]): string[] {
  const branches = [...local, ...remote].filter((branch) => branch !== current);
  return [...new Set(branches)].sort((a, b) => a.localeCompare(b));
}
