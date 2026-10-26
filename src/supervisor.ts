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
import { instanceNameKey, instanceStatus, isActive } from "./instances.js";
import { createLogger } from "./logger.js";
import { ensurePrivateDirectory, runDirectory, workerSocketPath } from "./paths.js";
import {
  PROTOCOL_VERSION,
  WORKER_PROTOCOL_VERSION,
  instanceNameSchema,
  parseLaunchConfig,
  type BackendPayload,
  type BackendResult,
  type HostInspection,
  type ProtocolErrorCode,
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
  LaunchConfig,
  RunEvent,
  RunRecord,
  SupervisorState,
  WorkerState,
} from "./types.js";
import { packageVersion } from "./version.js";
import type { WorkerRequest } from "./worker.js";

export type LogTarget = { instanceId: string; runId: string; runDir: string };

type SupervisorPersistence = {
  load(): Promise<SupervisorState>;
  save(state: SupervisorState): Promise<void>;
  loadWorker(runDir: string): Promise<WorkerState | null>;
  prepareRun(runId: string): Promise<{ runDir: string; workerSocket: string; requestFile: string }>;
  writeWorkerRequest(file: string, request: WorkerRequest): Promise<void>;
  readEvents(runDir: string, limit: number, afterSeq: number): Promise<RunEvent[]>;
  prune(state: SupervisorState, retainedCompletedRuns: number): Promise<void>;
  deleteRuns(instance: InstanceRecord): Promise<void>;
  historicalRunDirectory(runId: string): string;
};

type SupervisorWorkers = {
  spawn(requestFile: string): number;
  request(socketPath: string, type: "worker.status" | "worker.stop"): Promise<unknown>;
  waitForTerminal(runDir: string, timeoutMs: number): Promise<WorkerState | null>;
};

type SupervisorHost = {
  portIsAvailable(port: number): Promise<boolean>;
  inspect(input: BackendPayload<"host.inspect">): Promise<HostInspection>;
  startDockerDaemon(): Promise<number>;
};

export type SupervisorDependencies = {
  persistence: SupervisorPersistence;
  workers: SupervisorWorkers;
  host: SupervisorHost;
  createId(): string;
  now(): Date;
  packageVersion(): string;
};

export type SupervisorDependencyOverrides = Partial<
  Omit<SupervisorDependencies, "persistence" | "workers" | "host">
> & {
  persistence?: Partial<SupervisorPersistence>;
  workers?: Partial<SupervisorWorkers>;
  host?: Partial<SupervisorHost>;
};

export class SupervisorError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class Supervisor {
  private stateQueue: Promise<void> = Promise.resolve();

  private constructor(
    private state: SupervisorState,
    private readonly dependencies: SupervisorDependencies,
  ) {}

  static async create(
    env: NodeJS.ProcessEnv = process.env,
    overrides: SupervisorDependencyOverrides = {},
  ): Promise<Supervisor> {
    const defaults = defaultDependencies(env);
    const dependencies: SupervisorDependencies = {
      ...defaults,
      ...overrides,
      persistence: { ...defaults.persistence, ...overrides.persistence },
      workers: { ...defaults.workers, ...overrides.workers },
      host: { ...defaults.host, ...overrides.host },
    };
    return new Supervisor(await dependencies.persistence.load(), dependencies);
  }

  status(): Promise<BackendResult<"status.get">> {
    return this.enqueue(async () => {
      await this.refreshUnlocked();
      return {
        backend: {
          running: true,
          pid: process.pid,
          protocolVersion: PROTOCOL_VERSION,
          packageVersion: this.dependencies.packageVersion(),
        },
        instances: this.state.instances.map(instanceStatus),
      };
    });
  }

  getInstance(input: BackendPayload<"instance.get">): Promise<BackendResult<"instance.get">> {
    return this.enqueue(async () => {
      await this.refreshUnlocked();
      return instanceStatus(this.requireInstance(input.instanceId));
    });
  }

  createInstance(input: BackendPayload<"instance.create">): Promise<BackendResult<"instance.create">> {
    return this.enqueue(async () => {
      const name = this.parseInstanceName(input.name);
      const config = this.parseConfig(input.config);
      this.assertUniqueProfile(name, config);
      const instance: InstanceRecord = {
        id: this.dependencies.createId(),
        name,
        config,
        currentRun: null,
        history: [],
      };
      this.state.instances.push(instance);
      await this.dependencies.persistence.save(this.state);
      return instanceStatus(instance);
    });
  }

  updateInstance(input: BackendPayload<"instance.update">): Promise<BackendResult<"instance.update">> {
    return this.enqueue(async () => {
      await this.refreshUnlocked();
      const instance = this.requireInstance(input.instanceId);
      if (instance.currentRun && isActive(instance.currentRun.state)) {
        throw new SupervisorError("ACTIVE_INSTANCE_CONFLICT", "an active instance cannot be configured");
      }
      const name = this.parseInstanceName(input.name);
      const config = this.parseConfig(input.config);
      this.assertUniqueProfile(name, config, instance.id);
      instance.name = name;
      instance.config = config;
      await this.dependencies.persistence.save(this.state);
      return instanceStatus(instance);
    });
  }

  deleteInstance(input: BackendPayload<"instance.delete">): Promise<BackendResult<"instance.delete">> {
    return this.enqueue(async () => {
      await this.refreshUnlocked();
      const instance = this.requireInstance(input.instanceId);
      if (instance.currentRun && isActive(instance.currentRun.state)) {
        throw new SupervisorError("ACTIVE_INSTANCE_CONFLICT", "stop the instance before deleting it");
      }
      this.state.instances = this.state.instances.filter((candidate) => candidate.id !== instance.id);
      await this.dependencies.persistence.save(this.state);
      await this.dependencies.persistence.deleteRuns(instance);
      return { deletedId: instance.id };
    });
  }

  startInstance(input: BackendPayload<"instance.start">): Promise<BackendResult<"instance.start">> {
    return this.enqueue(async () => {
      await this.refreshUnlocked();
      return this.startUnlocked(input);
    });
  }

  stopInstance(input: BackendPayload<"instance.stop">): Promise<BackendResult<"instance.stop">> {
    return this.enqueue(async () => {
      await this.refreshUnlocked();
      return this.stopUnlocked(input.instanceId);
    });
  }

  restartInstance(input: BackendPayload<"instance.restart">): Promise<BackendResult<"instance.restart">> {
    return this.enqueue(async () => {
      await this.refreshUnlocked();
      const instance = this.requireInstance(input.instanceId);
      const current = instance.currentRun;
      if (!current || current.state === "stopped") {
        throw new SupervisorError(
          "NOT_RUNNING",
          `instance ${instance.name} has no active or failed run; use \`pl start\``,
        );
      }
      if (isActive(current.state)) {
        await this.stopUnlocked(instance.id);
        await this.dependencies.workers.waitForTerminal(current.runDir, 17_000);
        await this.refreshUnlocked();
      }
      return this.startUnlocked(input);
    });
  }

  inspectHost(input: BackendPayload<"host.inspect">): Promise<BackendResult<"host.inspect">> {
    return this.dependencies.host.inspect(input);
  }

  async tailLogs(input: BackendPayload<"logs.tail">): Promise<BackendResult<"logs.tail">> {
    const target = await this.resolveLogTarget(input);
    if (!target) return [];
    const limit = Math.min(1_000, Math.max(1, numberValue(input.limit, 200)));
    const afterSeq = numberValue(input.afterSeq, 0);
    const events = omitDependencyPackageChanges(
      await this.dependencies.persistence.readEvents(target.runDir, 1_000, afterSeq),
    );
    const filtered = input.stream === "stdout" || input.stream === "stderr"
      ? events.filter((event) => event.source === input.stream || event.source === "system")
      : events;
    return filtered.slice(-limit);
  }

  resolveLogTarget(
    input: Pick<BackendPayload<"logs.tail">, "instanceId" | "runId">,
  ): Promise<LogTarget | null> {
    return this.enqueue(() => Promise.resolve(this.resolveLogTargetUnlocked(input)));
  }

  startDockerDaemon(): Promise<BackendResult<"docker.startDaemon">> {
    return this.dependencies.host.startDockerDaemon().then((exitCode) => ({ exitCode }));
  }

  shutdown(): Promise<BackendResult<"backend.shutdown">> {
    return this.enqueue(() => Promise.resolve({
      accepted: true as const,
      activeInstancesPreserved: this.state.instances.filter((instance) => (
        instance.currentRun && isActive(instance.currentRun.state)
      )).length,
    }));
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.stateQueue.then(action, action);
    this.stateQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async refreshUnlocked(): Promise<void> {
    const refreshed = await Promise.all(this.state.instances.map(async (instance) => {
      const current = instance.currentRun;
      if (!current) return { instanceId: instance.id, runId: null, run: null, changed: false };
      const workerState = await this.dependencies.persistence.loadWorker(current.runDir);
      if (workerState) {
        if (isActive(workerState.state)) {
          try {
            const liveState = await this.dependencies.workers.request(
              current.workerSocket,
              "worker.status",
            ) as WorkerState;
            Object.assign(workerState, liveState);
          } catch {
            const age = this.dependencies.now().getTime() - new Date(workerState.updatedAt).getTime();
            if (age > 3_000) {
              Object.assign(workerState, {
                state: "failed",
                updatedAt: this.nowIso(),
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
      if (isActive(current.state)) {
        const age = this.dependencies.now().getTime() - new Date(current.updatedAt).getTime();
        if (age > 3_000) {
          return {
            instanceId: instance.id,
            runId: current.runId,
            run: {
              ...current,
              state: "failed" as const,
              updatedAt: this.nowIso(),
              errorCode: "WORKER_RECOVERY_FAILED",
              errorMessage: "the durable worker is no longer reachable",
            },
            changed: true,
          };
        }
      }
      return { instanceId: instance.id, runId: current.runId, run: current, changed: false };
    }));
    if (!refreshed.some((item) => item.changed)) return;
    for (const item of refreshed) {
      if (!item.changed || !item.runId || !item.run) continue;
      const currentInstance = this.state.instances.find((instance) => instance.id === item.instanceId);
      if (currentInstance?.currentRun?.runId === item.runId) currentInstance.currentRun = item.run;
    }
    await this.dependencies.persistence.save(this.state);
  }

  private async startUnlocked(
    input: BackendPayload<"instance.start"> | BackendPayload<"instance.restart">,
  ): Promise<RunRecord> {
    const instance = this.requireInstance(input.instanceId);
    if (instance.currentRun && isActive(instance.currentRun.state)) return instance.currentRun;
    if (!(await this.dependencies.host.portIsAvailable(instance.config.port))) {
      throw new SupervisorError("PORT_IN_USE", `port ${instance.config.port} is already in use`, {
        instanceId: instance.id,
        port: instance.config.port,
      });
    }

    if (instance.currentRun) instance.history.push(instance.currentRun.runId);
    const runId = this.dependencies.createId();
    const location = await this.dependencies.persistence.prepareRun(runId);
    const now = this.nowIso();
    const config = { ...instance.config } as LaunchConfig;
    const workerRequest: WorkerRequest = {
      instanceId: instance.id,
      runId,
      runDir: location.runDir,
      workerSocket: location.workerSocket,
      config,
      allowPullFailure: input.allowPullFailure === true,
      startDockerDaemon: input.startDockerDaemon === true,
    };
    await this.dependencies.persistence.writeWorkerRequest(location.requestFile, workerRequest);
    const record: RunRecord = {
      instanceId: instance.id,
      runId,
      runDir: location.runDir,
      workerSocket: location.workerSocket,
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
    await this.dependencies.persistence.prune(this.state, 5);
    await this.dependencies.persistence.save(this.state);

    record.pid = this.dependencies.workers.spawn(location.requestFile);
    record.updatedAt = this.nowIso();
    instance.currentRun = record;
    await this.dependencies.persistence.save(this.state);
    return record;
  }

  private async stopUnlocked(instanceId: string): Promise<RunRecord | null> {
    const instance = this.requireInstance(instanceId);
    const current = instance.currentRun;
    if (!current || !isActive(current.state)) return current;
    await this.dependencies.workers.request(current.workerSocket, "worker.stop").catch((error) => {
      throw new SupervisorError(
        "WORKER_RECOVERY_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    });
    instance.currentRun = { ...current, state: "stopping", updatedAt: this.nowIso() };
    await this.dependencies.persistence.save(this.state);
    return instance.currentRun;
  }

  private resolveLogTargetUnlocked(
    input: Pick<BackendPayload<"logs.tail">, "instanceId" | "runId">,
  ): LogTarget | null {
    const instance = this.requireInstance(input.instanceId);
    if (!input.runId) {
      return instance.currentRun
        ? { instanceId: instance.id, runId: instance.currentRun.runId, runDir: instance.currentRun.runDir }
        : null;
    }
    if (instance.currentRun?.runId === input.runId) {
      return { instanceId: instance.id, runId: input.runId, runDir: instance.currentRun.runDir };
    }
    if (instance.history.includes(input.runId) && /^[A-Za-z0-9-]+$/.test(input.runId)) {
      return {
        instanceId: instance.id,
        runId: input.runId,
        runDir: this.dependencies.persistence.historicalRunDirectory(input.runId),
      };
    }
    throw new SupervisorError(
      "NOT_FOUND",
      `run ${input.runId} does not belong to instance ${instance.name}`,
    );
  }

  private requireInstance(instanceId: string): InstanceRecord {
    const instance = this.state.instances.find((candidate) => candidate.id === instanceId);
    if (!instance) throw new SupervisorError("INSTANCE_NOT_FOUND", `instance not found: ${instanceId}`);
    return instance;
  }

  private assertUniqueProfile(name: string, config: LaunchConfig, excludeId?: string): void {
    const sameName = this.state.instances.find((instance) => (
      instance.id !== excludeId && instanceNameKey(instance.name) === instanceNameKey(name)
    ));
    if (sameName) {
      throw new SupervisorError(
        "INSTANCE_NAME_CONFLICT",
        `an instance named ${name} already exists`,
        { instanceId: sameName.id },
      );
    }
    const samePort = this.state.instances.find((instance) => (
      instance.id !== excludeId && instance.config.port === config.port
    ));
    if (samePort) {
      throw new SupervisorError("PORT_CONFLICT", `port ${config.port} is assigned to instance ${samePort.name}`, {
        instanceId: samePort.id,
        port: config.port,
      });
    }
  }

  private parseInstanceName(value: unknown): string {
    try {
      return instanceNameSchema.parse(value);
    } catch (error) {
      throw new SupervisorError("INVALID_CONFIG", error instanceof Error ? error.message : String(error));
    }
  }

  private parseConfig(value: unknown): LaunchConfig {
    try {
      return parseLaunchConfig(value);
    } catch (error) {
      throw new SupervisorError("INVALID_CONFIG", error instanceof Error ? error.message : String(error));
    }
  }

  private nowIso(): string {
    return this.dependencies.now().toISOString();
  }
}

function defaultDependencies(env: NodeJS.ProcessEnv): SupervisorDependencies {
  return {
    persistence: {
      load: () => loadSupervisorState(env),
      save: (state) => saveSupervisorState(state, env),
      loadWorker: (runDir) => loadWorkerState(runDir),
      async prepareRun(runId) {
        const runDir = runDirectory(runId, env);
        await ensurePrivateDirectory(runDir);
        return {
          runDir,
          workerSocket: workerSocketPath(runId, env),
          requestFile: workerRequestFile(runDir),
        };
      },
      writeWorkerRequest: (file, request) => fs.writeFile(
        file,
        `${JSON.stringify(request, null, 2)}\n`,
        { mode: 0o600 },
      ),
      readEvents: (runDir, limit, afterSeq) => readEvents(eventLogFile(runDir), limit, afterSeq),
      prune: (state, retainedCompletedRuns) => pruneRunHistory(state, env, retainedCompletedRuns),
      deleteRuns: (instance) => deleteInstanceRuns(instance, env),
      historicalRunDirectory: (runId) => runDirectory(runId, env),
    },
    workers: {
      spawn(requestFile) {
        const entry = nodeEntrypoint("worker-entry");
        const child = spawn(entry.command, [...entry.args, requestFile], {
          detached: true,
          stdio: "ignore",
          env,
        });
        child.unref();
        return child.pid ?? 0;
      },
      request: requestWorker,
      waitForTerminal,
    },
    host: {
      portIsAvailable,
      inspect: inspectHost,
      startDockerDaemon: () => startDockerDaemon(true, createLogger(true)),
    },
    createId: randomUUID,
    now: () => new Date(),
    packageVersion,
  };
}

async function inspectHost(input: BackendPayload<"host.inspect">): Promise<HostInspection> {
  const [dependencies, internetAvailable] = await Promise.all([checkPreflightDependencies(), hasInternet()]);
  const dockerImages = input.mode === "docker" ? await dockerImageInfo(internetAvailable) : [];
  const result: HostInspection = { dependencies, internetAvailable, dockerImages };
  if (input.path) {
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

function requestWorker(socketPath: string, type: "worker.status" | "worker.stop"): Promise<unknown> {
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
      const response = JSON.parse(buffer.slice(0, newline)) as {
        ok: boolean;
        result?: unknown;
        error?: { message: string };
      };
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
    if (state && !isActive(state.state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return loadWorkerState(runDir);
}

async function portIsAvailable(port: number): Promise<boolean> {
  if (!(await addressPortIsAvailable(port, "0.0.0.0"))) return false;
  return addressPortIsAvailable(port, "::");
}

function addressPortIsAvailable(port: number, host: string): Promise<boolean> {
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

function stripConfig(record: RunRecord): Omit<RunRecord, "config"> {
  const { config: _config, ...rest } = record;
  return rest;
}

function numberValue(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
