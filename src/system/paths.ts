import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expandHome } from "./path.js";

export type RuntimePaths = {
  stateDir: string;
  runsDir: string;
  stateFile: string;
  previousStateFile: string;
  backendSocket: string;
  backendPid: string;
  backendLog: string;
};

function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PRAIRIELEARN_STATE_DIR) return expandHome(env.PRAIRIELEARN_STATE_DIR);
  if (env.XDG_STATE_HOME)
    return path.join(expandHome(env.XDG_STATE_HOME), "prairielearn");
  return path.join(expandHome("~"), ".local", "state", "prairielearn");
}

function runtimeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PRAIRIELEARN_RUNTIME_DIR)
    return expandHome(env.PRAIRIELEARN_RUNTIME_DIR);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const base = env.XDG_RUNTIME_DIR
    ? expandHome(env.XDG_RUNTIME_DIR)
    : os.tmpdir();
  const candidate = path.join(base, `pl-runner-${uid}`);
  // sockaddr_un paths are short on macOS. Keep a deterministic fallback.
  if (Buffer.byteLength(path.join(candidate, "backend-v1.sock")) < 96)
    return candidate;
  const digest = createHash("sha256")
    .update(candidate)
    .digest("hex")
    .slice(0, 12);
  return path.join("/tmp", `plr-${uid}-${digest}`);
}

export function runtimePaths(
  env: NodeJS.ProcessEnv = process.env,
): RuntimePaths {
  const stateDir = stateDirectory(env);
  const runtimeDir = runtimeDirectory(env);
  return {
    stateDir,
    runsDir: path.join(stateDir, "runs"),
    stateFile: path.join(stateDir, "state-v3.json"),
    previousStateFile: path.join(stateDir, "state-v2.json"),
    backendSocket: path.join(runtimeDir, "backend-v1.sock"),
    backendPid: path.join(runtimeDir, "backend.pid"),
    backendLog: path.join(stateDir, "backend.log"),
  };
}

export function runDirectory(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(runtimePaths(env).runsDir, runId);
}

export function workerSocketPath(
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(runtimeDirectory(env), `w-${runId.slice(0, 12)}.sock`);
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    const stat = await fs.lstat(directory);
    const uid =
      typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) {
      throw new Error(`refusing to use unsafe runtime directory: ${directory}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await fs.chmod(directory, 0o700);
}

export async function ensureRuntimePaths(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimePaths> {
  const paths = runtimePaths(env);
  await Promise.all([
    ensurePrivateDirectory(paths.stateDir),
    ensurePrivateDirectory(paths.runsDir),
    ensurePrivateDirectory(path.dirname(paths.backendSocket)),
  ]);
  return paths;
}
