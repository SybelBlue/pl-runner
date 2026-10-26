import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import { spawn } from "node:child_process";
import { checkPreflightDependencies } from "./deps.js";
import { dockerImageInfo, startDockerDaemon } from "./docker.js";
import { nodeEntrypoint } from "./entrypoint.js";
import { readEvents } from "./event-log.js";
import { currentBranch, localBranches, remoteOnlyBranches, validateProjectPath } from "./git.js";
import { hasInternet } from "./internet.js";
import { createLogger } from "./logger.js";
import { ensurePrivateDirectory, ensureRuntimePaths, runDirectory, workerSocketPath } from "./paths.js";
import {
  PROTOCOL_VERSION,
  failure,
  parseLaunchConfig,
  requestSchema,
  success,
  type ProtocolErrorCode,
  type ProtocolRequest,
} from "./protocol.js";
import {
  eventLogFile,
  loadSupervisorState,
  loadWorkerState,
  pruneRunHistory,
  saveSupervisorState,
  workerRequestFile,
} from "./store.js";
import type {
  LaunchConfig,
  LifecycleState,
  RunEvent,
  RunRecord,
  SupervisorState,
  SupervisorStatus,
  WorkerState,
} from "./types.js";
import { packageVersion } from "./version.js";
import type { WorkerRequest } from "./worker.js";

const ACTIVE_STATES = new Set<LifecycleState>(["preparing", "starting", "running", "stopping"]);

class ActionError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function runBackend(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (process.platform === "win32") throw new Error("pl-runner backend supports macOS and Linux only");
  const paths = await ensureRuntimePaths(env);
  await assertSocketAvailable(paths.backendSocket);

  let state = await loadSupervisorState(env);
  let mutationQueue: Promise<unknown> = Promise.resolve();
  let refreshQueue: Promise<void> = Promise.resolve();
  let shuttingDown = false;
  const clients = new Set<net.Socket>();

  const refreshOnce = async (): Promise<void> => {
    if (!state.currentRun) return;
    const workerState = await loadWorkerState(state.currentRun.runDir);
    if (workerState) {
      if (ACTIVE_STATES.has(workerState.state)) {
        try {
          const liveState = await workerRequest(state.currentRun.workerSocket, "worker.status") as WorkerState;
          Object.assign(workerState, liveState);
        } catch {
          const age = Date.now() - new Date(workerState.updatedAt).getTime();
          if (age > 3_000) {
            Object.assign(workerState, {
              state: "failed",
              updatedAt: new Date().toISOString(),
              errorCode: "WORKER_RECOVERY_FAILED",
              errorMessage: "the durable worker is no longer reachable",
            } satisfies Partial<WorkerState>);
          }
        }
      }
      const previous = JSON.stringify(stripConfig(state.currentRun));
      state.currentRun = { ...state.currentRun, ...workerState };
      if (JSON.stringify(stripConfig(state.currentRun)) !== previous) await saveSupervisorState(state, env);
      return;
    }
    if (ACTIVE_STATES.has(state.currentRun.state)) {
      const age = Date.now() - new Date(state.currentRun.updatedAt).getTime();
      if (age > 3_000) {
        state.currentRun = {
          ...state.currentRun,
          state: "failed",
          updatedAt: new Date().toISOString(),
          errorCode: "WORKER_RECOVERY_FAILED",
          errorMessage: "the durable worker is no longer reachable",
        };
        await saveSupervisorState(state, env);
      }
    }
  };

  const refresh = (): Promise<void> => {
    const next = refreshQueue.then(refreshOnce, refreshOnce);
    refreshQueue = next.then(() => undefined, () => undefined);
    return next;
  };

  const status = async (): Promise<SupervisorStatus> => {
    await refresh();
    return {
      backend: {
        running: true,
        pid: process.pid,
        protocolVersion: PROTOCOL_VERSION,
        packageVersion: packageVersion(),
      },
      instance: state.currentRun,
      savedConfig: state.savedConfig,
    };
  };

  const mutate = <T>(action: () => Promise<T>): Promise<T> => {
    const next = mutationQueue.then(action, action);
    mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  };

  const start = async (payload: unknown): Promise<RunRecord> => {
    const input = asRecord(payload);
    const rawConfig = input.config ?? state.savedConfig;
    if (!rawConfig) throw new ActionError("INVALID_CONFIG", "no saved configuration exists");
    let config: LaunchConfig;
    try {
      config = parseLaunchConfig(rawConfig);
    } catch (error) {
      throw new ActionError("INVALID_CONFIG", error instanceof Error ? error.message : String(error));
    }
    await refresh();
    if (state.currentRun && ACTIVE_STATES.has(state.currentRun.state)) {
      if (sameConfig(state.currentRun.config, config)) return state.currentRun;
      throw new ActionError(
        "ACTIVE_INSTANCE_CONFLICT",
        "a different PrairieLearn configuration is already active",
        { active: state.currentRun },
      );
    }

    if (state.currentRun) state.history.push(state.currentRun.runId);
    const runId = randomUUID();
    const runDir = runDirectory(runId, env);
    const workerSocket = workerSocketPath(runId, env);
    await ensurePrivateDirectory(runDir);
    const now = new Date().toISOString();
    const workerRequest: WorkerRequest = {
      runId,
      runDir,
      workerSocket,
      config,
      allowPullFailure: input.allowPullFailure === true,
      startDockerDaemon: input.startDockerDaemon === true,
    };
    await fs.writeFile(workerRequestFile(runDir), `${JSON.stringify(workerRequest, null, 2)}\n`, { mode: 0o600 });
    const record: RunRecord = {
      runId,
      runDir,
      workerSocket,
      config,
      state: "preparing",
      pid: 0,
      childPid: null,
      startedAt: now,
      updatedAt: now,
      exitCode: null,
      errorCode: null,
      errorMessage: null,
    };
    state.currentRun = record;
    await pruneRunHistory(state, env, 5);
    await saveSupervisorState(state, env);

    const entry = nodeEntrypoint("worker-entry");
    const child = spawn(entry.command, [...entry.args, workerRequestFile(runDir)], {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
    record.pid = child.pid ?? 0;
    record.updatedAt = new Date().toISOString();
    state.currentRun = record;
    await saveSupervisorState(state, env);
    return record;
  };

  const stop = async (): Promise<RunRecord | null> => {
    await refresh();
    if (!state.currentRun || !ACTIVE_STATES.has(state.currentRun.state)) return state.currentRun;
    await workerRequest(state.currentRun.workerSocket, "worker.stop").catch((error) => {
      throw new ActionError("WORKER_RECOVERY_FAILED", error instanceof Error ? error.message : String(error));
    });
    state.currentRun = { ...state.currentRun, state: "stopping", updatedAt: new Date().toISOString() };
    await saveSupervisorState(state, env);
    return state.currentRun;
  };

  const restart = async (payload: unknown): Promise<RunRecord> => {
    await refresh();
    const current = state.currentRun;
    if (!current || current.state === "stopped") {
      throw new ActionError("NOT_RUNNING", "no active or failed run exists; use `pl start`");
    }
    const config = current.config;
    if (ACTIVE_STATES.has(current.state)) {
      await stop();
      await waitForTerminal(current.runDir, 17_000);
      await refresh();
    }
    return start({ ...asRecord(payload), config });
  };

  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    const intervals = new Set<NodeJS.Timeout>();
    socket.on("close", () => {
      clients.delete(socket);
      for (const interval of intervals) clearInterval(interval);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        socket.destroy(new Error("protocol frame exceeds 1 MiB"));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        void handleLine(line, socket, intervals);
      }
    });
  });

  const handleLine = async (
    line: string,
    socket: net.Socket,
    intervals: Set<NodeJS.Timeout>,
  ): Promise<void> => {
    let request: ProtocolRequest;
    try {
      request = requestSchema.parse(JSON.parse(line));
    } catch (error) {
      socket.write(`${JSON.stringify(failure("invalid", "PROTOCOL_MISMATCH", error instanceof Error ? error.message : String(error)))}\n`);
      return;
    }
    try {
      let result: unknown;
      if (request.type === "hello") {
        result = {
          protocolVersion: PROTOCOL_VERSION,
          packageVersion: packageVersion(),
          capabilities: ["config", "discovery", "lifecycle", "logs", "docker-daemon", "recovery"],
        };
      } else if (request.type === "status.get" || request.type === "backend.status") {
        result = await status();
      } else if (request.type === "config.get") {
        result = state.savedConfig;
      } else if (request.type === "config.set") {
        result = await mutate(async () => {
          await refresh();
          if (state.currentRun && ACTIVE_STATES.has(state.currentRun.state)) {
            throw new ActionError("ACTIVE_INSTANCE_CONFLICT", "configuration cannot be edited while an instance is active");
          }
          try {
            state.savedConfig = parseLaunchConfig(asRecord(request.payload).config);
          } catch (error) {
            throw new ActionError("INVALID_CONFIG", error instanceof Error ? error.message : String(error));
          }
          await saveSupervisorState(state, env);
          return state.savedConfig;
        });
      } else if (request.type === "host.inspect") {
        result = await inspectHost(request.payload);
      } else if (request.type === "instance.start") {
        result = await mutate(() => start(request.payload));
      } else if (request.type === "instance.stop") {
        result = await mutate(stop);
      } else if (request.type === "instance.restart") {
        result = await mutate(() => restart(request.payload));
      } else if (request.type === "logs.tail") {
        result = await tailLogs(state, request.payload);
      } else if (request.type === "logs.subscribe") {
        const payload = asRecord(request.payload);
        let afterSeq = numberValue(payload.afterSeq, 0);
        socket.write(`${JSON.stringify(success(request.id, { subscribed: true }))}\n`);
        const interval = setInterval(async () => {
          const events = await tailLogs(state, { ...payload, afterSeq, limit: 1_000 });
          for (const event of events) {
            afterSeq = Math.max(afterSeq, event.seq);
            socket.write(`${JSON.stringify({ protocol: PROTOCOL_VERSION, event: "log", data: event })}\n`);
          }
        }, 250);
        intervals.add(interval);
        return;
      } else if (request.type === "docker.startDaemon") {
        const code = await startDockerDaemon(true, createLogger(true));
        result = { exitCode: code };
      } else if (request.type === "backend.shutdown") {
        result = { accepted: true, activeInstancePreserved: Boolean(state.currentRun && ACTIVE_STATES.has(state.currentRun.state)) };
        shuttingDown = true;
      } else {
        throw new ActionError("NOT_FOUND", `unknown request type: ${request.type}`);
      }
      socket.write(`${JSON.stringify(success(request.id, result))}\n`);
      if (shuttingDown) {
        setImmediate(() => {
          server.close();
          for (const client of clients) client.end();
        });
      }
    } catch (error) {
      if (error instanceof ActionError) {
        socket.write(`${JSON.stringify(failure(request.id, error.code, error.message, error.details))}\n`);
      } else {
        socket.write(`${JSON.stringify(failure(request.id, "INTERNAL_ERROR", error instanceof Error ? error.message : String(error)))}\n`);
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.backendSocket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await fs.chmod(paths.backendSocket, 0o600);
  await new Promise<void>((resolve) => server.once("close", resolve));
  await fs.rm(paths.backendSocket, { force: true });
}

async function inspectHost(payload: unknown): Promise<unknown> {
  const input = asRecord(payload);
  const [dependencies, internetAvailable] = await Promise.all([checkPreflightDependencies(), hasInternet()]);
  const images = input.mode === "docker" ? await dockerImageInfo(internetAvailable) : [];
  const result: Record<string, unknown> = {
    dependencies,
    internetAvailable,
    dockerImages: images,
  };
  if (typeof input.path === "string" && input.path) {
    const warnings: string[] = [];
    const logger = {
      error: (message: string) => warnings.push(message),
      warn: (message: string) => warnings.push(message),
      info: () => undefined,
      debug: () => undefined,
    };
    result.validProjectPath = await validateProjectPath(input.path, logger);
    result.warnings = warnings;
    if (result.validProjectPath) {
      const [current, local, remote] = await Promise.all([
        currentBranch(input.path),
        localBranches(input.path),
        internetAvailable ? remoteOnlyBranches(input.path) : Promise.resolve([]),
      ]);
      result.currentBranch = current;
      result.localBranches = local;
      result.remoteBranches = remote;
    }
  }
  return result;
}

async function tailLogs(state: SupervisorState, payload: unknown): Promise<RunEvent[]> {
  if (!state.currentRun) return [];
  const input = asRecord(payload);
  const limit = Math.min(1_000, Math.max(1, numberValue(input.limit, 200)));
  const afterSeq = numberValue(input.afterSeq, 0);
  const stream = typeof input.stream === "string" ? input.stream : "all";
  const events = await readEvents(eventLogFile(state.currentRun.runDir), 1_000, afterSeq);
  const filtered = stream === "stdout" || stream === "stderr"
    ? events.filter((event) => event.source === stream || event.source === "system")
    : events;
  return filtered.slice(-limit);
}

async function workerRequest(socketPath: string, type: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const id = randomUUID();
    let buffer = "";
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    };
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(() => reject(new Error("worker request timed out")));
    }, 1_000);
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("close", () => finish(() => reject(new Error("worker closed the connection without a response"))));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ protocol: PROTOCOL_VERSION, id, type, payload: {} })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const response = JSON.parse(buffer.slice(0, newline)) as { ok: boolean; result?: unknown; error?: { message: string } };
      socket.end();
      if (response.ok) finish(() => resolve(response.result));
      else finish(() => reject(new Error(response.error?.message ?? "worker request failed")));
    });
  });
}

async function waitForTerminal(runDir: string, timeoutMs: number): Promise<WorkerState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await loadWorkerState(runDir);
    if (state && !ACTIVE_STATES.has(state.state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return loadWorkerState(runDir);
}

async function assertSocketAvailable(socketPath: string): Promise<void> {
  const running = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
  if (running) throw new Error("pl-runner backend is already running");
  try {
    const stat = await fs.lstat(socketPath);
    const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isSocket() || stat.uid !== uid) throw new Error(`refusing to remove unsafe socket: ${socketPath}`);
    await fs.rm(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isActive(state: LifecycleState): boolean {
  return ACTIVE_STATES.has(state);
}

function sameConfig(left: LaunchConfig, right: LaunchConfig): boolean {
  return JSON.stringify({ ...left, quiet: false }) === JSON.stringify({ ...right, quiet: false });
}

function stripConfig(record: RunRecord): Omit<RunRecord, "config"> {
  const { config: _config, ...rest } = record;
  return rest;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export { isActive };
