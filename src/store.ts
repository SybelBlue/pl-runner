import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nextAvailablePort } from "./instances.js";
import { loadSavedConfig, stateFilePath } from "./state.js";
import { ensureRuntimePaths, runtimePaths } from "./paths.js";
import type {
  GitConfig,
  InstanceRecord,
  LaunchConfig,
  RunRecord,
  SupervisorState,
  WorkerState,
} from "./types.js";

const EMPTY_STATE: SupervisorState = {
  schemaVersion: 3,
  instances: [],
  migratedLegacyConfig: false,
};

type SupervisorStateV2 = {
  schemaVersion: 2;
  savedConfig?: unknown;
  currentRun?: (Omit<RunRecord, "instanceId" | "config"> & { config: unknown }) | null;
  history?: unknown;
  migratedLegacyConfig?: boolean;
};

export async function loadSupervisorState(env: NodeJS.ProcessEnv = process.env): Promise<SupervisorState> {
  const paths = await ensureRuntimePaths(env);
  try {
    const parsed = JSON.parse(await fs.readFile(paths.stateFile, "utf8")) as Partial<SupervisorState>;
    if (parsed.schemaVersion !== 3) throw new Error("unsupported state version");
    return normalizeStateV3(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let state: SupervisorState;
  try {
    const previous = JSON.parse(await fs.readFile(paths.previousStateFile, "utf8")) as SupervisorStateV2;
    if (previous.schemaVersion !== 2) throw new Error("unsupported previous state version");
    state = migrateStateV2(previous);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const legacy = await loadSavedConfig(stateFilePath(env));
    state = {
      ...EMPTY_STATE,
      instances: legacy
        ? [{
            id: randomUUID(),
            name: "default",
            config: fromLegacyConfig(legacy),
            currentRun: null,
            history: [],
          }]
        : [],
      migratedLegacyConfig: true,
    };
  }
  await saveSupervisorState(state, env);
  return state;
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

function workerStateFile(runDir: string): string {
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
  const keep = new Set<string>();
  for (const instance of state.instances) {
    const unique = [...new Set(instance.history)];
    instance.history = unique.slice(-retainedCompletedRuns);
    for (const runId of instance.history) keep.add(runId);
    if (instance.currentRun) keep.add(instance.currentRun.runId);
  }
  const runsDir = runtimePaths(env).runsDir;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(runsDir);
  } catch {
    return;
  }
  await Promise.all(entries
    .filter((entry) => isSafeRunId(entry) && !keep.has(entry))
    .map((entry) => fs.rm(path.join(runsDir, entry), { recursive: true, force: true })));
}

export async function deleteInstanceRuns(
  instance: InstanceRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const runIds = new Set(instance.history);
  if (instance.currentRun) runIds.add(instance.currentRun.runId);
  const runsDir = runtimePaths(env).runsDir;
  await Promise.all([...runIds]
    .filter(isSafeRunId)
    .map((runId) => fs.rm(path.join(runsDir, runId), { recursive: true, force: true })));
}

function dockerHostPort(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535) return value;
  if (typeof value !== "string") return null;
  const withoutProtocol = value.split("/", 1)[0] ?? "";
  const parts = withoutProtocol.split(":");
  const candidate = parts.length >= 2 ? parts.at(-2) : parts[0];
  const port = Number(candidate);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function normalizeStateV3(parsed: Partial<SupervisorState>): SupervisorState {
  const instances = Array.isArray(parsed.instances)
    ? parsed.instances.filter((item): item is InstanceRecord => Boolean(
        item
        && typeof item === "object"
        && typeof item.id === "string"
        && typeof item.name === "string"
        && item.config,
      )).map((instance) => ({
        id: instance.id,
        name: instance.name,
        config: instance.config,
        currentRun: instance.currentRun ?? null,
        history: Array.isArray(instance.history)
          ? instance.history.filter((item): item is string => typeof item === "string")
          : [],
      }))
    : [];
  return {
    schemaVersion: 3,
    instances,
    migratedLegacyConfig: parsed.migratedLegacyConfig === true,
  };
}

function migrateStateV2(previous: SupervisorStateV2): SupervisorState {
  const instances: InstanceRecord[] = [];
  const currentConfig = previous.currentRun ? migrateLaunchConfig(previous.currentRun.config, 3000) : null;
  if (previous.currentRun && currentConfig) {
    const id = randomUUID();
    instances.push({
      id,
      name: "default",
      config: currentConfig,
      currentRun: { ...previous.currentRun, instanceId: id, config: currentConfig },
      history: stringList(previous.history),
    });
  }

  const savedConfig = migrateLaunchConfig(previous.savedConfig, 3000);
  if (savedConfig) {
    const current = instances[0];
    if (!current || !sameConfig(current.config, savedConfig)) {
      const port = instances.some((instance) => instance.config.port === savedConfig.port)
        ? nextAvailablePort(instances)
        : savedConfig.port;
      instances.push({
        id: randomUUID(),
        name: current ? "saved" : "default",
        config: { ...savedConfig, port } as LaunchConfig,
        currentRun: null,
        history: current ? [] : stringList(previous.history),
      });
    }
  }

  return {
    schemaVersion: 3,
    instances,
    migratedLegacyConfig: previous.migratedLegacyConfig === true,
  };
}

function migrateLaunchConfig(value: unknown, fallbackPort: number): LaunchConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const config = value as Record<string, unknown>;
  if (config.mode === "git" && typeof config.path === "string" && config.path) {
    return {
      mode: "git",
      path: config.path,
      branch: typeof config.branch === "string" ? config.branch : null,
      port: validPort(config.port) ?? fallbackPort,
      isolated_database: config.isolated_database === true,
      force_rebuild: config.force_rebuild === true,
      local_only: config.local_only === true,
      no_watch_upstream: config.no_watch_upstream === true,
      quiet: config.quiet === true,
    };
  }
  if (config.mode === "docker" && typeof config.course_path === "string" && config.course_path) {
    const port = dockerHostPort(config.port) ?? fallbackPort;
    return {
      mode: "docker",
      course_path: config.course_path,
      image: config.image === "latest" ? "latest" : "us-prod-live",
      port,
      tmp_dir: typeof config.tmp_dir === "string" && config.tmp_dir ? config.tmp_dir : "/tmp",
      local_only: config.local_only === true,
      quiet: config.quiet === true,
    };
  }
  return null;
}

function fromLegacyConfig(config: GitConfig | Exclude<LaunchConfig, { mode: "git" }>): LaunchConfig {
  const migrated = migrateLaunchConfig(config, 3000);
  if (!migrated) throw new Error("legacy configuration is invalid");
  return migrated;
}

function validPort(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : null;
}

function sameConfig(left: LaunchConfig, right: LaunchConfig): boolean {
  return JSON.stringify({ ...left, quiet: false }) === JSON.stringify({ ...right, quiet: false });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isSafeRunId(value: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(value);
}
