import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import { checkPreflightDependencies } from "./deps.js";
import { dockerImageInfo, startDockerDaemon } from "./docker.js";
import { nodeEntrypoint } from "./entrypoint.js";
import { omitDependencyPackageChanges, readEvents } from "./event-log.js";
import { currentBranch, localBranches, remoteOnlyBranches, validateProjectPath } from "./git.js";
import { hasInternet } from "./internet.js";
import { createLogger } from "./logger.js";
import { ensurePrivateDirectory, ensureRuntimePaths, runDirectory, workerSocketPath } from "./paths.js";
import {
  PROTOCOL_VERSION,
  WORKER_PROTOCOL_VERSION,
  failure,
  instanceNameSchema,
  parseLaunchConfig,
  requestSchema,
  success,
  type ProtocolErrorCode,
  type ProtocolRequest,
} from "./protocol.js";
import {
  deleteInstanceRuns,
  eventLogFile,
  loadSupervisorState,
  loadWorkerState,
  pruneRunHistory,
  saveSupervisorState,
  workerRequestFile,
} from "./store.js";
import type {
  InstanceRecord,
  InstanceStatus,
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
    const refreshed = await Promise.all(state.instances.map(async (instance) => {
      const current = instance.currentRun;
      if (!current) return { instanceId: instance.id, runId: null, run: null, changed: false };
      const workerState = await loadWorkerState(current.runDir);
      if (workerState) {
        if (ACTIVE_STATES.has(workerState.state)) {
          try {
            const liveState = await workerRequest(current.workerSocket, "worker.status") as WorkerState;
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
        const nextRun = { ...current, ...workerState };
        return {
          instanceId: instance.id,
          runId: current.runId,
          run: nextRun,
          changed: JSON.stringify(stripConfig(nextRun)) !== JSON.stringify(stripConfig(current)),
        };
      }
      if (ACTIVE_STATES.has(current.state)) {
        const age = Date.now() - new Date(current.updatedAt).getTime();
        if (age > 3_000) {
          return {
            instanceId: instance.id,
            runId: current.runId,
            run: {
              ...current,
              state: "failed" as const,
              updatedAt: new Date().toISOString(),
              errorCode: "WORKER_RECOVERY_FAILED",
              errorMessage: "the durable worker is no longer reachable",
            },
            changed: true,
          };
        }
      }
      return { instanceId: instance.id, runId: current.runId, run: current, changed: false };
    }));
    if (refreshed.some((item) => item.changed)) {
      for (const item of refreshed) {
        if (!item.changed || !item.runId || !item.run) continue;
        const currentInstance = state.instances.find((instance) => instance.id === item.instanceId);
        if (currentInstance?.currentRun?.runId === item.runId) currentInstance.currentRun = item.run;
      }
      await saveSupervisorState(state, env);
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
      instances: state.instances.map(instanceStatus),
    };
  };

  const mutate = <T>(action: () => Promise<T>): Promise<T> => {
    const next = mutationQueue.then(action, action);
    mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  };

  const createInstance = async (payload: unknown): Promise<InstanceStatus> => {
    const input = asRecord(payload);
    const name = parseInstanceName(input.name);
    const config = parseConfig(input.config);
    assertUniqueProfile(state, name, config);
    const instance: InstanceRecord = {
      id: randomUUID(),
      name,
      config,
      currentRun: null,
      history: [],
    };
    state.instances.push(instance);
    await saveSupervisorState(state, env);
    return instanceStatus(instance);
  };

  const updateInstance = async (payload: unknown): Promise<InstanceStatus> => {
    const input = asRecord(payload);
    await refresh();
    const instance = requireInstance(state, input.instanceId);
    if (instance.currentRun && ACTIVE_STATES.has(instance.currentRun.state)) {
      throw new ActionError("ACTIVE_INSTANCE_CONFLICT", "an active instance cannot be configured");
    }
    const name = parseInstanceName(input.name);
    const config = parseConfig(input.config);
    assertUniqueProfile(state, name, config, instance.id);
    instance.name = name;
    instance.config = config;
    await saveSupervisorState(state, env);
    return instanceStatus(instance);
  };

  const deleteInstance = async (payload: unknown): Promise<{ deletedId: string }> => {
    const input = asRecord(payload);
    await refresh();
    const instance = requireInstance(state, input.instanceId);
    if (instance.currentRun && ACTIVE_STATES.has(instance.currentRun.state)) {
      throw new ActionError("ACTIVE_INSTANCE_CONFLICT", "stop the instance before deleting it");
    }
    state.instances = state.instances.filter((candidate) => candidate.id !== instance.id);
    await saveSupervisorState(state, env);
    await deleteInstanceRuns(instance, env);
    return { deletedId: instance.id };
  };

  const start = async (payload: unknown): Promise<RunRecord> => {
    const input = asRecord(payload);
    await refresh();
    const instance = requireInstance(state, input.instanceId);
    if (instance.currentRun && ACTIVE_STATES.has(instance.currentRun.state)) return instance.currentRun;
    if (!(await portIsAvailable(instance.config.port))) {
      throw new ActionError("PORT_IN_USE", `port ${instance.config.port} is already in use`, {
        instanceId: instance.id,
        port: instance.config.port,
      });
    }

    if (instance.currentRun) instance.history.push(instance.currentRun.runId);
    const runId = randomUUID();
    const runDir = runDirectory(runId, env);
    const workerSocket = workerSocketPath(runId, env);
    await ensurePrivateDirectory(runDir);
    const now = new Date().toISOString();
    const config = { ...instance.config } as LaunchConfig;
    const workerRequest: WorkerRequest = {
      instanceId: instance.id,
      runId,
      runDir,
      workerSocket,
      config,
      allowPullFailure: input.allowPullFailure === true,
      startDockerDaemon: input.startDockerDaemon === true,
    };
    await fs.writeFile(workerRequestFile(runDir), `${JSON.stringify(workerRequest, null, 2)}\n`, { mode: 0o600 });
    const record: RunRecord = {
      instanceId: instance.id,
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
    instance.currentRun = record;
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
    instance.currentRun = record;
    await saveSupervisorState(state, env);
    return record;
  };

  const stop = async (payload: unknown): Promise<RunRecord | null> => {
    const input = asRecord(payload);
    await refresh();
    const instance = requireInstance(state, input.instanceId);
    const current = instance.currentRun;
    if (!current || !ACTIVE_STATES.has(current.state)) return current;
    await workerRequest(current.workerSocket, "worker.stop").catch((error) => {
      throw new ActionError("WORKER_RECOVERY_FAILED", error instanceof Error ? error.message : String(error));
    });
    instance.currentRun = { ...current, state: "stopping", updatedAt: new Date().toISOString() };
    await saveSupervisorState(state, env);
    return instance.currentRun;
  };

  const restart = async (payload: unknown): Promise<RunRecord> => {
    const input = asRecord(payload);
    await refresh();
    const instance = requireInstance(state, input.instanceId);
    const current = instance.currentRun;
    if (!current || current.state === "stopped") {
      throw new ActionError("NOT_RUNNING", `instance ${instance.name} has no active or failed run; use \`pl start\``);
    }
    if (ACTIVE_STATES.has(current.state)) {
      await stop({ instanceId: instance.id });
      await waitForTerminal(current.runDir, 17_000);
      await refresh();
    }
    return start({
      instanceId: instance.id,
      allowPullFailure: input.allowPullFailure,
      startDockerDaemon: input.startDockerDaemon,
    });
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
          capabilities: ["instances", "discovery", "lifecycle", "logs", "docker-daemon", "recovery"],
        };
      } else if (request.type === "status.get" || request.type === "backend.status") {
        result = await status();
      } else if (request.type === "instance.get") {
        await refresh();
        result = instanceStatus(requireInstance(state, asRecord(request.payload).instanceId));
      } else if (request.type === "instance.create") {
        result = await mutate(() => createInstance(request.payload));
      } else if (request.type === "instance.update") {
        result = await mutate(() => updateInstance(request.payload));
      } else if (request.type === "instance.delete") {
        result = await mutate(() => deleteInstance(request.payload));
      } else if (request.type === "host.inspect") {
        result = await inspectHost(request.payload);
      } else if (request.type === "instance.start") {
        result = await mutate(() => start(request.payload));
      } else if (request.type === "instance.stop") {
        result = await mutate(() => stop(request.payload));
      } else if (request.type === "instance.restart") {
        result = await mutate(() => restart(request.payload));
      } else if (request.type === "logs.tail") {
        result = await tailLogs(state, request.payload, env);
      } else if (request.type === "logs.subscribe") {
        const payload = asRecord(request.payload);
        const target = resolveRun(state, payload, env);
        if (!target) throw new ActionError("NOT_FOUND", "the instance has no run to subscribe to");
        let afterSeq = numberValue(payload.afterSeq, 0);
        socket.write(`${JSON.stringify(success(request.id, { subscribed: true, runId: target.runId }))}\n`);
        const fixedPayload = { ...payload, runId: target.runId };
        const interval = setInterval(() => {
          void tailLogs(state, { ...fixedPayload, afterSeq, limit: 1_000 }, env).then((events) => {
            for (const event of events) {
              afterSeq = Math.max(afterSeq, event.seq);
              socket.write(`${JSON.stringify({ protocol: PROTOCOL_VERSION, event: "log", data: event })}\n`);
            }
          }).catch(() => undefined);
        }, 250);
        intervals.add(interval);
        return;
      } else if (request.type === "docker.startDaemon") {
        const code = await startDockerDaemon(true, createLogger(true));
        result = { exitCode: code };
      } else if (request.type === "backend.shutdown") {
        result = {
          accepted: true,
          activeInstancesPreserved: state.instances.filter((instance) => (
            instance.currentRun && ACTIVE_STATES.has(instance.currentRun.state)
          )).length,
        };
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
  const result: Record<string, unknown> = { dependencies, internetAvailable, dockerImages: images };
  if (typeof input.path === "string" && input.path) {
    const warnings: string[] = [];
    const logger = {
      error: (message: string) => warnings.push(message),
      warn: (message: string) => warnings.push(message),
      info: () => undefined,
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

async function tailLogs(
  state: SupervisorState,
  payload: unknown,
  env: NodeJS.ProcessEnv,
): Promise<RunEvent[]> {
  const input = asRecord(payload);
  const target = resolveRun(state, input, env);
  if (!target) return [];
  const limit = Math.min(1_000, Math.max(1, numberValue(input.limit, 200)));
  const afterSeq = numberValue(input.afterSeq, 0);
  const stream = typeof input.stream === "string" ? input.stream : "all";
  const events = omitDependencyPackageChanges(await readEvents(eventLogFile(target.runDir), 1_000, afterSeq));
  const filtered = stream === "stdout" || stream === "stderr"
    ? events.filter((event) => event.source === stream || event.source === "system")
    : events;
  return filtered.slice(-limit);
}

function resolveRun(
  state: SupervisorState,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): { runId: string; runDir: string } | null {
  const instance = requireInstance(state, payload.instanceId);
  const requestedRunId = typeof payload.runId === "string" ? payload.runId : null;
  if (!requestedRunId) {
    return instance.currentRun
      ? { runId: instance.currentRun.runId, runDir: instance.currentRun.runDir }
      : null;
  }
  if (instance.currentRun?.runId === requestedRunId) {
    return { runId: requestedRunId, runDir: instance.currentRun.runDir };
  }
  if (instance.history.includes(requestedRunId) && /^[A-Za-z0-9-]+$/.test(requestedRunId)) {
    return { runId: requestedRunId, runDir: runDirectory(requestedRunId, env) };
  }
  throw new ActionError("NOT_FOUND", `run ${requestedRunId} does not belong to instance ${instance.name}`);
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
      socket.write(`${JSON.stringify({ protocol: WORKER_PROTOCOL_VERSION, id, type, payload: {} })}\n`);
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

async function portIsAvailable(port: number): Promise<boolean> {
  if (!(await addressPortIsAvailable(port, "0.0.0.0"))) return false;
  return addressPortIsAvailable(port, "::");
}

async function addressPortIsAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL") resolve(true);
      else reject(error);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
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

function parseInstanceName(value: unknown): string {
  try {
    return instanceNameSchema.parse(value);
  } catch (error) {
    throw new ActionError("INVALID_CONFIG", error instanceof Error ? error.message : String(error));
  }
}

function parseConfig(value: unknown): LaunchConfig {
  try {
    return parseLaunchConfig(value);
  } catch (error) {
    throw new ActionError("INVALID_CONFIG", error instanceof Error ? error.message : String(error));
  }
}

function assertUniqueProfile(
  state: SupervisorState,
  name: string,
  config: LaunchConfig,
  excludeId?: string,
): void {
  const sameName = state.instances.find((instance) => (
    instance.id !== excludeId && instance.name.toLocaleLowerCase() === name.toLocaleLowerCase()
  ));
  if (sameName) {
    throw new ActionError("INSTANCE_NAME_CONFLICT", `an instance named ${name} already exists`, { instanceId: sameName.id });
  }
  const samePort = state.instances.find((instance) => instance.id !== excludeId && instance.config.port === config.port);
  if (samePort) {
    throw new ActionError("PORT_CONFLICT", `port ${config.port} is assigned to instance ${samePort.name}`, {
      instanceId: samePort.id,
      port: config.port,
    });
  }
}

function requireInstance(state: SupervisorState, value: unknown): InstanceRecord {
  if (typeof value !== "string") throw new ActionError("INSTANCE_NOT_FOUND", "instanceId is required");
  const instance = state.instances.find((candidate) => candidate.id === value);
  if (!instance) throw new ActionError("INSTANCE_NOT_FOUND", `instance not found: ${value}`);
  return instance;
}

function instanceStatus(instance: InstanceRecord): InstanceStatus {
  return { id: instance.id, name: instance.name, config: instance.config, run: instance.currentRun };
}

function isActive(state: LifecycleState): boolean {
  return ACTIVE_STATES.has(state);
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
