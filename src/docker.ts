import fs from "node:fs/promises";
import path from "node:path";
import { runCommand, runInteractiveProcess } from "./process.js";
import { resolvePath, systemTmpDir, withoutVirtualEnv } from "./path.js";
import type { DockerConfig, DockerOptions, Logger } from "./types.js";

export function normalizeDockerOptions(options: Partial<DockerOptions>): DockerOptions {
  return {
    course_path: resolvePath(options.course_path ?? "."),
    port: options.port ?? "3000:3000",
    tmp_dir: resolvePath(options.tmp_dir ?? systemTmpDir()),
    local_only: options.local_only ?? false,
    quiet: options.quiet ?? false,
  };
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
    logger.error("docker is not installed. Try opening docker desktop.");
    return 1;
  }
  const info = await runCommand("docker", ["info"]);
  if (info.status !== 0) {
    logger.error("docker is not available. Try opening docker desktop.");
    return 1;
  }

  const jobsDir = await fs.mkdtemp(path.join(tmpDir, "pl-jobs-dir."));
  const args = dockerRunArgs({ ...options, course_path: coursePath, tmp_dir: tmpDir }, jobsDir);
  logger.info("--- docker run ---");
  const status = await runInteractiveProcess("docker", args, {
    quiet: options.quiet,
    env: withoutVirtualEnv(),
  });
  logger.info("--- docker run ---");
  (status !== 0 ? logger.warn : logger.info)(`docker run exited with ${status}`);
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
    "prairielearn/prairielearn:us-prod-live",
  ];
}

async function isDirectory(input: string): Promise<boolean> {
  try {
    return (await fs.stat(input)).isDirectory();
  } catch {
    return false;
  }
}
