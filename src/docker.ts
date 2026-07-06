import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runCommand, runInteractiveProcess } from "./process.js";
import { ask, PromptCanceled } from "./prompt.js";
import { resolvePath, systemTmpDir, withoutVirtualEnv } from "./path.js";
import type { DockerConfig, DockerImageTag, DockerOptions, Logger } from "./types.js";

export const DOCKER_IMAGE_REPOSITORY = "prairielearn/prairielearn";
export const DEFAULT_DOCKER_IMAGE_TAG: DockerImageTag = "us-prod-live";
export const SUPPORTED_DOCKER_IMAGE_TAGS: DockerImageTag[] = ["us-prod-live", "latest"];

export function normalizeDockerOptions(options: Partial<Omit<DockerOptions, "image">> & { image?: string }): DockerOptions {
  return {
    course_path: resolvePath(options.course_path ?? "."),
    image: requireDockerImageTag(options.image),
    port: options.port ?? "3000:3000",
    tmp_dir: resolvePath(options.tmp_dir ?? systemTmpDir()),
    local_only: options.local_only ?? false,
    quiet: options.quiet ?? false,
  };
}

export function normalizeDockerImageTag(tag: string | undefined): DockerImageTag {
  if (tag && SUPPORTED_DOCKER_IMAGE_TAGS.includes(tag as DockerImageTag)) return tag as DockerImageTag;
  return DEFAULT_DOCKER_IMAGE_TAG;
}

export function requireDockerImageTag(tag: string | undefined): DockerImageTag {
  if (tag === undefined) return DEFAULT_DOCKER_IMAGE_TAG;
  if (SUPPORTED_DOCKER_IMAGE_TAGS.includes(tag as DockerImageTag)) return tag as DockerImageTag;
  throw new Error(`unsupported Docker image tag: ${tag}. Supported tags: ${SUPPORTED_DOCKER_IMAGE_TAGS.join(", ")}`);
}

export async function dockerConfigFromOptions(options: Partial<DockerOptions>): Promise<DockerConfig> {
  return { mode: "docker", ...normalizeDockerOptions(options) };
}

export async function launchDocker(options: DockerOptions, logger: Logger): Promise<number> {
  const coursePath = resolvePath(options.course_path);
  const tmpDir = resolvePath(options.tmp_dir);

  if (!(await isDirectory(coursePath))) {
    logger.error(`${coursePath} is not a directory.`);
    return 1;
  }
  if (!(await isDirectory(tmpDir))) {
    logger.error(`${tmpDir} is not a directory.`);
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
    const startStatus = await promptAndRunDockerDaemonStartCommand(options.quiet, logger);
    if (startStatus !== 0) return startStatus;
    if (!(await waitForDockerDaemon(options.quiet))) {
      logger.warn("Docker daemon is still unavailable. Try again once Docker finishes starting.");
      await pauseBeforeExit(options.quiet);
      return 1;
    }
  }

  const preLaunchImageIds = await prairielearnImageIds();
  const jobsDir = await fs.mkdtemp(path.join(tmpDir, "pl-jobs-dir."));
  const args = dockerRunArgs({ ...options, course_path: coursePath, tmp_dir: tmpDir }, jobsDir);
  logger.info("--- docker run ---");
  const status = await runInteractiveProcess("docker", args, {
    quiet: options.quiet,
    env: withoutVirtualEnv(),
  });
  logger.info("--- docker run ---");
  (status !== 0 ? logger.warn : logger.info)(`docker run exited with ${status}`);
  await cleanupFormerPrairieLearnImages(preLaunchImageIds, options.quiet, logger);
  return status;
}

export function dockerRunArgs(options: DockerOptions, jobsDir: string): string[] {
  return [
    "run",
    "-it",
    "--rm",
    `--pull=${options.local_only ? "never" : "always"}`,
    "-p",
    options.port,
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

async function promptAndRunDockerDaemonStartCommand(quiet: boolean, logger: Logger): Promise<number> {
  let command: string;
  try {
    command = await ask("Start Docker daemon", dockerDaemonStartCommand(), "Enter to run, Esc/Ctrl+C to cancel");
  } catch (error) {
    if (error instanceof PromptCanceled) return 130;
    throw error;
  }
  if (!command) {
    logger.warn("Docker daemon start canceled.");
    return 1;
  }

  const shell = shellCommand(command);
  logger.info(`running: ${command}`);
  return runInteractiveProcess(shell.command, shell.args, {
    quiet,
    env: withoutVirtualEnv(),
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

async function cleanupFormerPrairieLearnImages(beforeImageIds: string[], quiet: boolean, logger: Logger): Promise<void> {
  const currentImageIds = await prairielearnImageIds();
  const untaggedImageIds = await untaggedDockerImageIds(beforeImageIds);
  const cleanupIds = formerPrairieLearnDanglingImageIds(beforeImageIds, currentImageIds, untaggedImageIds);
  if (cleanupIds.length === 0) return;

  logger.info("cleaning old PrairieLearn docker images...");
  const status = await runInteractiveProcess("docker", ["image", "rm", ...cleanupIds], {
    quiet,
    env: withoutVirtualEnv(),
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
