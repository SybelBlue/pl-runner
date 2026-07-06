import {
  DEFAULT_DOCKER_IMAGE_TAG,
  DOCKER_IMAGE_REPOSITORY,
  SUPPORTED_DOCKER_IMAGE_TAGS,
  dockerConfigFromOptions,
  launchDocker,
} from "./docker.js";
import {
  checkPreflightDependencies,
  formatDependencyStatus,
  missingDependencies,
  type PreflightDependencies,
} from "./deps.js";
import { boldBright, formatRelativeTime } from "./format.js";
import { currentBranch, localBranches, remoteOnlyBranches, validateProjectPath } from "./git.js";
import { hasInternet } from "./internet.js";
import {
  ask,
  askDirectory,
  autocomplete,
  confirm,
  endPrompt,
  PromptCanceled,
  select,
  showNote,
  startPrompt,
  withSpinner,
} from "./prompt.js";
import { previewDockerCommand, previewRunCommand } from "./preview.js";
import { applyOfflineDefaults, launchRun, normalizeRunConfig } from "./run.js";
import { loadSavedConfig, saveConfig } from "./state.js";
import type { DockerConfig, DockerImageTag, Logger, RunOptions, SavedConfig } from "./types.js";
import { resolvePath, systemTmpDir } from "./path.js";

type LauncherMode = "defaults" | "previous" | "custom" | "docker";

type Preflight = {
  saved: SavedConfig | null;
  internet_available: boolean;
  configuredPath: string | null;
  currentBranch: string | null;
  deps: PreflightDependencies;
};

export async function launchInteractive(baseRun: RunOptions, logger: Logger): Promise<number> {
  try {
    startPrompt("PrairieLearn launcher", baseRun.quiet);
    const preflight = await loadPreflight(baseRun, logger);
    const choices = launcherChoices(preflight, baseRun);
    if (!choices.some((choice) => !choice.disabled)) {
      logger.error("No launch mode is available until missing command dependencies are installed.");
      return 1;
    }
    const mode = await select(
      "What do you want to launch?",
      choices,
      recommendedLauncherMode(preflight),
    );

    if (mode === "defaults") return runDefaults({ ...baseRun, internet_available: preflight.internet_available }, logger);
    if (mode === "previous") return runPrevious(preflight.saved, baseRun.quiet, logger);
    if (mode === "custom") return runCustom({ ...baseRun, internet_available: preflight.internet_available }, logger);
    return runDockerInteractive(preflight.internet_available, baseRun.quiet, logger);
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
  const deps = await withSpinner("Checking command dependencies", () => checkPreflightDependencies(), baseRun.quiet);
  const configuredPath = baseRun.path ?? process.env.PRAIRIELEARN_PATH ?? null;
  const current = configuredPath && deps.git ? await currentBranch(resolvePath(configuredPath)) : null;

  const details = [
    `network: ${internet_available ? "online" : "offline"}`,
    `commands: ${formatDependencyStatus(deps)}`,
    configuredPath ? `project: ${resolvePath(configuredPath)}` : "project: not configured",
    current ? `branch: ${current}` : null,
    saved ? `previous: ${previewSaved(saved)}` : null,
  ].filter(Boolean);
  showNote(details.join("\n"), "Detected", baseRun.quiet);

  if (!internet_available) logger.debug("network unavailable during launcher preflight");
  const missing = missingDependencies(deps, ["git", "docker", "pnpm", "uv"]);
  if (missing.length > 0) logger.warn(`missing command dependencies: ${missing.join(", ")}`);
  return { saved, internet_available, configuredPath, currentBranch: current, deps };
}

export function recommendedLauncherMode(preflight: Pick<Preflight, "saved" | "configuredPath" | "deps">): LauncherMode {
  if (preflight.saved && savedConfigDependenciesAvailable(preflight.saved, preflight.deps)) return "previous";
  if (preflight.configuredPath && gitRunDependenciesAvailable(preflight.deps)) return "defaults";
  if (dockerDependenciesAvailable(preflight.deps)) return "docker";
  return "custom";
}

export function launcherChoices(
  preflight: Pick<Preflight, "saved" | "configuredPath" | "currentBranch" | "deps">,
  baseRun: RunOptions,
): Array<{ name: string; value: LauncherMode; hint?: string; disabled?: boolean }> {
  const dockerPreview = previewDockerCommand({
    course_path: ".",
    port: "3000:3000",
    image: DEFAULT_DOCKER_IMAGE_TAG,
    tmp_dir: systemTmpDir(),
    local_only: false,
    quiet: baseRun.quiet,
  });

  const gitMissing = missingDependencies(preflight.deps, ["git", "pnpm", "uv"]);
  const dockerMissing = missingDependencies(preflight.deps, ["docker"]);
  const savedMissing = preflight.saved ? missingForSavedConfig(preflight.saved, preflight.deps) : [];

  return [
    {
      name: "Run previous config",
      value: "previous",
      hint: preflight.saved ? missingHint(savedMissing) ?? previewSaved(preflight.saved) : "No saved config yet",
      disabled: !preflight.saved || savedMissing.length > 0,
    },
    {
      name: preflight.currentBranch ? `Run default configuration on current branch (${preflight.currentBranch})` : "Run default configuration",
      value: "defaults",
      hint: missingHint(gitMissing) ?? (preflight.configuredPath ? previewRunCommand(baseRun) : "Needs --path or PRAIRIELEARN_PATH"),
      disabled: !preflight.configuredPath || gitMissing.length > 0,
    },
    {
      name: "Configure git checkout",
      value: "custom",
      hint: missingHint(gitMissing) ?? "Choose path, branch, rebuild, and watch options",
      disabled: gitMissing.length > 0,
    },
    {
      name: "Run with Docker",
      value: "docker",
      hint: missingHint(dockerMissing) ?? dockerPreview,
      disabled: dockerMissing.length > 0,
    },
  ];
}

function gitRunDependenciesAvailable(deps: PreflightDependencies): boolean {
  return missingDependencies(deps, ["git", "pnpm", "uv"]).length === 0;
}

function dockerDependenciesAvailable(deps: PreflightDependencies): boolean {
  return missingDependencies(deps, ["docker"]).length === 0;
}

function savedConfigDependenciesAvailable(config: SavedConfig, deps: PreflightDependencies): boolean {
  return missingForSavedConfig(config, deps).length === 0;
}

function missingForSavedConfig(config: SavedConfig, deps: PreflightDependencies) {
  return config.mode === "git" ? missingDependencies(deps, ["git", "pnpm", "uv"]) : missingDependencies(deps, ["docker"]);
}

function missingHint(commands: string[]): string | undefined {
  return commands.length > 0 ? `Missing: ${commands.join(", ")}` : undefined;
}

async function runDefaults(baseRun: RunOptions, logger: Logger): Promise<number> {
  let config = await normalizeRunConfig(baseRun, true, logger);
  if (!config) {
    const projectPath = await askDirectory("Project path", process.env.PRAIRIELEARN_PATH);
    config = await normalizeRunConfig({ ...baseRun, path: projectPath }, true, logger);
  }
  if (!config) return 1;
  showRunConfig(config);
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
    if (!config.path) config.path = await askDirectory("Project path", process.env.PRAIRIELEARN_PATH);
    applyOfflineDefaults(config, logger);
    showRunConfig(config);
    await saveConfig(config, logger);
    return launchRun(config, logger, true);
  }
  config.image ??= DEFAULT_DOCKER_IMAGE_TAG;
  showDockerConfig(config);
  await saveConfig(config, logger);
  return launchDocker(config, logger);
}

async function runCustom(baseRun: RunOptions, logger: Logger): Promise<number> {
  const projectPath = resolvePath(await askDirectory("Project path", baseRun.path ?? process.env.PRAIRIELEARN_PATH));
  if (!(await validateProjectPath(projectPath, logger))) return 1;
  const internet_available = baseRun.internet_available ?? (await hasInternet());

  const current = await currentBranch(projectPath);
  const local = await localBranches(projectPath);
  const remote = internet_available ? await remoteOnlyBranches(projectPath) : [];
  const branch = await askBranch(current, local, remote, internet_available, logger);

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

  const selected = await autocomplete(
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
    "Type to filter branches",
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

async function runDockerInteractive(internet_available: boolean, quiet: boolean, logger: Logger): Promise<number> {
  const course_path = await askDirectory("Course directory", ".");
  const port = await ask("Port mapping", "3000:3000");
  const image = await select(
    "Docker image",
    await dockerImageChoices(internet_available, quiet, logger),
    DEFAULT_DOCKER_IMAGE_TAG,
  );
  const jobsMode = await select(
    "Jobs directory",
    [
      { name: "Make temporary directory", value: "temp", hint: systemTmpDir() },
      { name: "Choose directory", value: "choose", hint: "Use an existing directory" },
    ],
    "temp",
  );
  const tmp_dir = jobsMode === "temp" ? systemTmpDir() : await askDirectory("Jobs directory", systemTmpDir());
  const local_only = await confirm("Use local Docker image only", false);
  const config: DockerConfig = await dockerConfigFromOptions({ course_path, image, port, tmp_dir, local_only, quiet });
  showDockerConfig(config);
  if (!(await confirm("Run this command now", true))) {
    endPrompt("Canceled.", config.quiet);
    return 0;
  }
  await saveConfig(config, logger);
  return launchDocker(config, logger);
}

async function dockerImageChoices(
  internet_available: boolean,
  quiet: boolean,
  logger: Logger,
): Promise<Array<{ name: string; value: DockerImageTag; hint?: string }>> {
  if (!internet_available) {
    logger.warn("offline: Docker image update hints are unavailable.");
    return SUPPORTED_DOCKER_IMAGE_TAGS.map((tag) => ({ name: tag, value: tag, hint: "last update unknown" }));
  }

  const updated = await withSpinner("Checking Docker image tags", () => dockerTagUpdates(SUPPORTED_DOCKER_IMAGE_TAGS), quiet);
  if (updated.size < SUPPORTED_DOCKER_IMAGE_TAGS.length) {
    logger.warn("could not fetch all Docker image update hints.");
  }
  return SUPPORTED_DOCKER_IMAGE_TAGS.map((tag) => ({
    name: tag,
    value: tag,
    hint: updated.get(tag) ? `updated ${formatRelativeTime((Date.now() - updated.get(tag)!.getTime()) / 1000)}` : "last update unknown",
  }));
}

async function dockerTagUpdates(tags: DockerImageTag[]): Promise<Map<DockerImageTag, Date>> {
  const entries = await Promise.all(tags.map(async (tag) => [tag, await dockerTagUpdatedAt(tag)] as const));
  return new Map(entries.filter((entry): entry is [DockerImageTag, Date] => entry[1] !== null));
}

async function dockerTagUpdatedAt(tag: DockerImageTag): Promise<Date | null> {
  try {
    const response = await fetch(`https://hub.docker.com/v2/repositories/${DOCKER_IMAGE_REPOSITORY}/tags/${tag}`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    const body = await response.json() as { last_updated?: unknown };
    if (typeof body.last_updated !== "string") return null;
    const updated = new Date(body.last_updated);
    return Number.isNaN(updated.getTime()) ? null : updated;
  } catch {
    return null;
  }
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
      boldBright(previewRunCommand(config)),
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
      `image: ${config.image}`,
      `port: ${config.port}`,
      `jobs directory: ${config.tmp_dir}`,
      `local image only: ${config.local_only}`,
      "",
      boldBright(previewDockerCommand(config)),
    ].join("\n"),
    "Ready",
    config.quiet,
  );
}

export function uniqueBranches(current: string | null, local: string[], remote: string[]): string[] {
  const branches = [...local, ...remote].filter((branch) => branch !== current);
  return [...new Set(branches)];
}
