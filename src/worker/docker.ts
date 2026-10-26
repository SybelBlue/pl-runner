import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runCommand, runInteractiveProcess } from "../system/process.js";
import { resolvePath, systemTmpDir, withoutVirtualEnv } from "../system/path.js";
import type { DockerImageTag, DockerOptions, Logger } from "../core/types.js";
import type { LaunchControl } from "./run.js";

const DOCKER_IMAGE_REPOSITORY = "prairielearn/prairielearn";
export const DEFAULT_DOCKER_IMAGE_TAG: DockerImageTag = "us-prod-live";
const SUPPORTED_DOCKER_IMAGE_TAGS: DockerImageTag[] = ["us-prod-live", "latest"];

export type DockerImageInfo = {
  tag: DockerImageTag;
  updatedAt: string | null;
};

export async function dockerImageInfo(internetAvailable: boolean): Promise<DockerImageInfo[]> {
  if (!internetAvailable) return SUPPORTED_DOCKER_IMAGE_TAGS.map((tag) => ({ tag, updatedAt: null }));
  return Promise.all(SUPPORTED_DOCKER_IMAGE_TAGS.map(async (tag) => ({
    tag,
    updatedAt: await dockerTagUpdatedAt(tag),
  })));
}

export function normalizeDockerOptions(options: Partial<Omit<DockerOptions, "image">> & { image?: string }): DockerOptions {
  return {
    course_path: resolvePath(options.course_path ?? "."),
    image: requireDockerImageTag(options.image),
    port: options.port ?? 3000,
    tmp_dir: resolvePath(options.tmp_dir ?? systemTmpDir()),
    local_only: options.local_only ?? false,
    quiet: options.quiet ?? false,
  };
}

export function normalizeDockerImageTag(tag: string | undefined): DockerImageTag {
  if (tag && SUPPORTED_DOCKER_IMAGE_TAGS.includes(tag as DockerImageTag)) return tag as DockerImageTag;
  return DEFAULT_DOCKER_IMAGE_TAG;
}

function requireDockerImageTag(tag: string | undefined): DockerImageTag {
  if (tag === undefined) return DEFAULT_DOCKER_IMAGE_TAG;
  if (SUPPORTED_DOCKER_IMAGE_TAGS.includes(tag as DockerImageTag)) return tag as DockerImageTag;
  throw new Error(`unsupported Docker image tag: ${tag}. Supported tags: ${SUPPORTED_DOCKER_IMAGE_TAGS.join(", ")}`);
}

export async function launchDocker(
  options: DockerOptions,
  logger: Logger,
  control: LaunchControl = {},
): Promise<number> {
  control.onState?.("preparing");
  const coursePath = resolvePath(options.course_path);
  const tmpDir = resolvePath(options.tmp_dir);

  if (!(await isDirectory(coursePath))) {
    logger.error(`${coursePath} is not a directory.`);
    control.onFailure?.("INVALID_CONFIG", `${coursePath} is not a directory`);
    return 1;
  }
  if (!(await isDirectory(tmpDir))) {
    logger.error(`${tmpDir} is not a directory.`);
    control.onFailure?.("INVALID_CONFIG", `${tmpDir} is not a directory`);
    return 1;
  }

  const version = await runCommand("docker", ["--version"]);
  if (version.status !== 0) {
    logger.error("docker is not installed.");
    return 1;
  }
  const info = await runCommand("docker", ["info"]);
  if (info.status !== 0) {
    logger.error("Docker is installed, but the Docker daemon is not running.");
    if (!control.startDockerDaemon) {
      control.onFailure?.("DOCKER_DAEMON_UNAVAILABLE", "Docker daemon is not running");
      return 1;
    }
    const startStatus = await startDockerDaemon(options.quiet, logger, process.platform, control);
    if (startStatus !== 0) return startStatus;
    if (!(await waitForDockerDaemon(options.quiet))) {
      logger.warn("Docker daemon is still unavailable. Try again once Docker finishes starting.");
      await pauseBeforeExit(options.quiet);
      return 1;
    }
  }
  if (control.shouldStop?.()) return 130;

  const preLaunchImageIds = await prairielearnImageIds();
  const jobsDir = await fs.mkdtemp(path.join(tmpDir, "pl-jobs-dir."));
  try {
    const args = dockerRunArgs({ ...options, course_path: coursePath, tmp_dir: tmpDir }, jobsDir);
    logger.info("--- docker run ---");
    control.onState?.("starting");
    const status = await runInteractiveProcess("docker", args, {
      quiet: options.quiet,
      env: withoutVirtualEnv(),
      handleSignals: false,
      onSpawn: (pid) => {
        control.onSpawn?.(pid);
        control.onState?.("running");
      },
      onExitRequest: control.onProcess,
      onOutput: (source, chunk) => control.onOutput?.(source, chunk, "server"),
    });
    logger.info("--- docker run ---");
    (status !== 0 ? logger.warn : logger.info)(`docker run exited with ${status}`);
    await cleanupFormerPrairieLearnImages(preLaunchImageIds, options.quiet, logger, control);
    return status;
  } finally {
    await fs.rm(jobsDir, { recursive: true, force: true });
  }
}

export function dockerRunArgs(options: DockerOptions, jobsDir: string): string[] {
  return [
    "run",
    "--rm",
    `--pull=${options.local_only ? "never" : "always"}`,
    "-p",
    `${options.port}:3000`,
    "-v",
    `${resolvePath(options.course_path)}:/course`,
    "-v",
    `${jobsDir}:/jobs`,
    "-e",
    `HOST_JOBS_DIR=${jobsDir}`,
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "--add-host=host.docker.internal:172.17.0.1",
    `${DOCKER_IMAGE_REPOSITORY}:${options.image}`,
  ];
}

export function dockerDaemonStartCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "open -a Docker";
  if (platform === "win32") return "Start-Process 'Docker Desktop'";
  return "sudo systemctl start docker";
}

export function shellCommand(command: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "win32") return { command: "powershell.exe", args: ["-NoProfile", "-Command", command] };
  return { command: "sh", args: ["-lc", command] };
}

export async function startDockerDaemon(
  quiet: boolean,
  logger: Logger,
  platform: NodeJS.Platform = process.platform,
  control: LaunchControl = {},
): Promise<number> {
  const command = dockerDaemonStartCommand(platform);
  const shell = shellCommand(command);
  logger.info(`running: ${command}`);
  return runInteractiveProcess(shell.command, shell.args, {
    quiet,
    env: withoutVirtualEnv(),
    handleSignals: false,
    onSpawn: control.onSpawn,
    onExitRequest: control.onProcess,
    onOutput: (source, chunk) => control.onOutput?.(source, chunk, "docker-daemon"),
  });
}

async function waitForDockerDaemon(quiet: boolean, timeoutMs = 30000, intervalMs = 1000): Promise<boolean> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!quiet) {
      const remaining = Math.ceil((timeoutMs - attempt * intervalMs) / 1000);
      process.stderr.write(`\rprairielearn: waiting for Docker daemon (${remaining}s)...`);
    }
    await sleep(intervalMs);
    const info = await runCommand("docker", ["info"]);
    if (info.status === 0) {
      if (!quiet) process.stderr.write("\n");
      return true;
    }
  }
  if (!quiet) process.stderr.write("\n");
  return false;
}

export function formerPrairieLearnDanglingImageIds(before: string[], current: string[], untagged: string[]): string[] {
  const currentIds = new Set(current);
  const untaggedIds = new Set(untagged);
  return [...new Set(before)].filter((id) => !currentIds.has(id) && untaggedIds.has(id));
}

async function cleanupFormerPrairieLearnImages(
  beforeImageIds: string[],
  quiet: boolean,
  logger: Logger,
  control: LaunchControl,
): Promise<void> {
  const currentImageIds = await prairielearnImageIds();
  const untaggedImageIds = await untaggedDockerImageIds(beforeImageIds);
  const cleanupIds = formerPrairieLearnDanglingImageIds(beforeImageIds, currentImageIds, untaggedImageIds);
  if (cleanupIds.length === 0) return;

  logger.info("cleaning old PrairieLearn docker images...");
  const status = await runInteractiveProcess("docker", ["image", "rm", ...cleanupIds], {
    quiet,
    env: withoutVirtualEnv(),
    handleSignals: false,
    onSpawn: control.onSpawn,
    onExitRequest: control.onProcess,
    onOutput: (source, chunk) => control.onOutput?.(source, chunk, "cleanup"),
  });
  if (status !== 0) logger.warn(`docker image rm exited with ${status}`);
}

async function pauseBeforeExit(quiet: boolean, durationMs = 3000): Promise<void> {
  if (quiet) {
    await sleep(durationMs);
    return;
  }

  const seconds = Math.ceil(durationMs / 1000);
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    process.stderr.write(`\rprairielearn: exiting in ${remaining}s...`);
    await sleep(1000);
  }
  process.stderr.write("\n");
}

async function prairielearnImageIds(): Promise<string[]> {
  const result = await runCommand("docker", ["image", "ls", DOCKER_IMAGE_REPOSITORY, "--format", "{{.ID}}"]);
  if (result.status !== 0) return [];
  return uniqueNonEmptyLines(result.stdout);
}

async function untaggedDockerImageIds(ids: string[]): Promise<string[]> {
  const results = await Promise.all([...new Set(ids)].map(async (id) => [id, await imageIsUntagged(id)] as const));
  return results.filter(([, untagged]) => untagged).map(([id]) => id);
}

async function imageIsUntagged(id: string): Promise<boolean> {
  const result = await runCommand("docker", ["image", "inspect", id, "--format", "{{json .RepoTags}}"]);
  if (result.status !== 0) return false;
  try {
    const tags = JSON.parse(result.stdout.trim()) as unknown;
    return !Array.isArray(tags) || tags.length === 0 || tags.every((tag) => tag === "<none>:<none>");
  } catch {
    return false;
  }
}

async function dockerTagUpdatedAt(tag: DockerImageTag): Promise<string | null> {
  try {
    const response = await fetch(`https://hub.docker.com/v2/repositories/${DOCKER_IMAGE_REPOSITORY}/tags/${tag}`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    const body = await response.json() as { last_updated?: unknown };
    if (typeof body.last_updated !== "string") return null;
    const updated = new Date(body.last_updated);
    return Number.isNaN(updated.getTime()) ? null : updated.toISOString();
  } catch {
    return null;
  }
}

function uniqueNonEmptyLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

async function isDirectory(input: string): Promise<boolean> {
  try {
    return (await fs.stat(input)).isDirectory();
  } catch {
    return false;
  }
}
