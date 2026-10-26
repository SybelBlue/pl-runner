import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { loadSavedConfig, stateFilePath } from "./state.js";
import { ensureRuntimePaths, runtimePaths } from "./paths.js";
import type {
  GitConfig,
  LaunchConfig,
  RunRecord,
  SupervisorState,
  WorkerState,
} from "./types.js";

export const EMPTY_STATE: SupervisorState = {
  schemaVersion: 2,
  savedConfig: null,
  currentRun: null,
  history: [],
  migratedLegacyConfig: false,
};

export async function loadSupervisorState(env: NodeJS.ProcessEnv = process.env): Promise<SupervisorState> {
  const paths = await ensureRuntimePaths(env);
  let contents: string;
  try {
    contents = await fs.readFile(paths.stateFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const legacy = await loadSavedConfig(stateFilePath(env));
    const state: SupervisorState = {
      ...EMPTY_STATE,
      savedConfig: legacy ? fromLegacyConfig(legacy) : null,
      migratedLegacyConfig: true,
    };
    await saveSupervisorState(state, env);
    return state;
  }
  const parsed = JSON.parse(contents) as Partial<SupervisorState>;
  if (parsed.schemaVersion !== 2) throw new Error("unsupported state version");
  return {
    schemaVersion: 2,
    savedConfig: (parsed.savedConfig as LaunchConfig | null) ?? null,
    currentRun: (parsed.currentRun as RunRecord | null) ?? null,
    history: Array.isArray(parsed.history) ? parsed.history.filter((item): item is string => typeof item === "string") : [],
    migratedLegacyConfig: parsed.migratedLegacyConfig === true,
  };
}

export async function saveSupervisorState(
  state: SupervisorState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const paths = await ensureRuntimePaths(env);
  const temporary = `${paths.stateFile}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, paths.stateFile);
}

export function workerStateFile(runDir: string): string {
  return path.join(runDir, "worker-state.json");
}

export function eventLogFile(runDir: string): string {
  return path.join(runDir, "events.jsonl");
}

export function workerRequestFile(runDir: string): string {
  return path.join(runDir, "request.json");
}

export async function loadWorkerState(runDir: string): Promise<WorkerState | null> {
  try {
    return JSON.parse(await fs.readFile(workerStateFile(runDir), "utf8")) as WorkerState;
  } catch {
    return null;
  }
}

export async function saveWorkerState(runDir: string, state: WorkerState): Promise<void> {
  const file = workerStateFile(runDir);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function pruneRunHistory(
  state: SupervisorState,
  env: NodeJS.ProcessEnv = process.env,
  retainedCompletedRuns = 5,
): Promise<void> {
  const unique = [...new Set(state.history)];
  state.history = unique.slice(-retainedCompletedRuns);
  const keep = new Set(state.history);
  if (state.currentRun) keep.add(state.currentRun.runId);
  const runsDir = runtimePaths(env).runsDir;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(runsDir);
  } catch {
    return;
  }
  await Promise.all(entries.filter((entry) => !keep.has(entry)).map((entry) => fs.rm(path.join(runsDir, entry), { recursive: true, force: true })));
}

function fromLegacyConfig(config: GitConfig | Exclude<LaunchConfig, { mode: "git" }>): LaunchConfig {
  if (config.mode === "docker") return config;
  return {
    mode: "git",
    path: config.path,
    branch: config.branch,
    force_rebuild: config.force_rebuild,
    local_only: config.local_only,
    no_watch_upstream: config.no_watch_upstream,
    quiet: false,
  };
}
