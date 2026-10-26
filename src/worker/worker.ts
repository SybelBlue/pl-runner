import fs from "node:fs/promises";
import net from "node:net";
import {
  checkPreflightDependencies,
  missingDependencies,
} from "../system/deps.js";
import { launchDocker } from "./docker.js";
import { EventLog, eventLogger } from "./event-log.js";
import {
  WORKER_PROTOCOL_VERSION,
  workerRequestSchema,
} from "../core/protocol.js";
import {
  applyOfflineDefaults,
  launchRun,
  normalizeRunConfig,
  type LaunchControl,
} from "./run.js";
import { eventLogFile, saveWorkerState } from "../backend/store.js";
import type {
  LaunchConfig,
  LifecycleState,
  WorkerState,
} from "../core/types.js";

export type WorkerRequest = {
  instanceId: string;
  runId: string;
  runDir: string;
  workerSocket: string;
  config: LaunchConfig;
  allowPullFailure: boolean;
  startDockerDaemon: boolean;
};

export async function recordWorkerStartupFailure(
  requestPath: string,
  cause: unknown,
): Promise<void> {
  const request = JSON.parse(
    await fs.readFile(requestPath, "utf8"),
  ) as WorkerRequest;
  const message = cause instanceof Error ? cause.message : String(cause);
  const timestamp = new Date().toISOString();
  const log = new EventLog(eventLogFile(request.runDir), request.runId);
  await log.initialize();
  await log.append("system", "failed", `worker failed to start: ${message}`);
  await saveWorkerState(request.runDir, {
    runId: request.runId,
    state: "failed",
    pid: process.pid,
    childPid: null,
    startedAt: timestamp,
    updatedAt: timestamp,
    exitCode: 1,
    errorCode: "WORKER_START_FAILED",
    errorMessage: message,
  });
  await log.flush();
}

export async function runWorker(requestPath: string): Promise<number> {
  const request = JSON.parse(
    await fs.readFile(requestPath, "utf8"),
  ) as WorkerRequest;
  const log = new EventLog(eventLogFile(request.runDir), request.runId);
  await log.initialize();

  let phase = "preparing";
  let stopRequested = false;
  let activeTerminate: ((signal?: NodeJS.Signals) => void) | undefined;
  let failureCode: string | null = null;
  let failureMessage: string | null = null;
  let stateWrite = Promise.resolve();
  const startedAt = new Date().toISOString();
  let state: WorkerState = {
    runId: request.runId,
    state: "preparing",
    pid: process.pid,
    childPid: null,
    startedAt,
    updatedAt: startedAt,
    exitCode: null,
    errorCode: null,
    errorMessage: null,
  };

  const persist = (patch: Partial<WorkerState> = {}) => {
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
    stateWrite = stateWrite.then(() => saveWorkerState(request.runDir, state));
    return stateWrite;
  };

  await persist();
  const logger = eventLogger(log, () => phase);

  const requestStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    phase = "stopping";
    void persist({ state: "stopping" });
    void log.append("system", phase, "stop requested; sending SIGINT");
    activeTerminate?.("SIGINT");
    const termTimer = setTimeout(() => {
      void log.append(
        "system",
        phase,
        "process did not stop after 10s; sending SIGTERM",
      );
      activeTerminate?.("SIGTERM");
    }, 10_000);
    const killTimer = setTimeout(() => {
      void log.append(
        "system",
        phase,
        "process did not stop after 15s; sending SIGKILL",
      );
      activeTerminate?.("SIGKILL");
    }, 15_000);
    termTimer.unref();
    killTimer.unref();
  };

  const server = await createWorkerServer(
    request.workerSocket,
    () => state,
    requestStop,
  );
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);

  const control: LaunchControl = {
    allowPullFailure: request.allowPullFailure,
    startDockerDaemon: request.startDockerDaemon,
    shouldStop: () => stopRequested,
    onState(next) {
      phase = next;
      void persist({ state: next });
    },
    onProcess(terminate) {
      activeTerminate = terminate;
      if (stopRequested) activeTerminate("SIGINT");
    },
    onSpawn(pid) {
      void persist({ childPid: pid ?? null });
    },
    onOutput(source, chunk, outputPhase) {
      void log.append(source, outputPhase, chunk);
    },
    onFailure(code, message) {
      failureCode = code;
      failureMessage = message;
    },
  };

  let exitCode = 1;
  try {
    await log.append(
      "system",
      "preparing",
      `starting ${request.config.mode} run ${request.runId}`,
    );
    const deps = await checkPreflightDependencies();
    const needed =
      request.config.mode === "git"
        ? (["git", "pnpm", "uv"] as const)
        : (["docker"] as const);
    const missing = missingDependencies(deps, [...needed]);
    if (missing.length > 0) {
      failureCode = "MISSING_DEPENDENCY";
      failureMessage = `missing command dependencies: ${missing.join(", ")}`;
      logger.error(failureMessage);
      exitCode = 127;
    } else if (request.config.mode === "git") {
      const normalized = await normalizeRunConfig(
        request.config,
        false,
        logger,
      );
      if (!normalized) {
        failureCode = "INVALID_CONFIG";
        failureMessage = "Git configuration requires a PrairieLearn path";
      } else {
        // Network state is always determined by the backend-side worker.
        applyOfflineDefaults(normalized, logger);
        exitCode = await launchRun(normalized, logger, false, control, {
          instanceId: request.instanceId,
          runDir: request.runDir,
          env: process.env,
        });
      }
    } else {
      exitCode = await launchDocker(request.config, logger, control);
    }
  } catch (error) {
    failureCode ??= "INTERNAL_ERROR";
    failureMessage ??= error instanceof Error ? error.message : String(error);
    logger.error(failureMessage);
    exitCode = 1;
  }

  const terminalState: LifecycleState =
    stopRequested || exitCode === 0 ? "stopped" : "failed";
  phase = terminalState;
  if (exitCode !== 0 && !stopRequested) {
    failureCode ??= "PROCESS_EXITED";
    failureMessage ??= `managed process exited with ${exitCode}`;
  }
  await log.append(
    "system",
    phase,
    stopRequested
      ? "managed instance stopped"
      : `managed instance exited with ${exitCode}`,
  );
  await persist({
    state: terminalState,
    childPid: null,
    exitCode,
    errorCode: stopRequested ? null : failureCode,
    errorMessage: stopRequested ? null : failureMessage,
  });
  await log.flush();
  await stateWrite;
  await closeServer(server, request.workerSocket);
  return stopRequested ? 0 : exitCode;
}

async function createWorkerServer(
  socketPath: string,
  getState: () => WorkerState,
  stop: () => void,
): Promise<net.Server> {
  await fs.rm(socketPath, { force: true });
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
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
        try {
          const request = workerRequestSchema.parse(JSON.parse(line));
          if (request.type === "worker.status") {
            socket.write(
              `${JSON.stringify(workerSuccess(request.id, getState()))}\n`,
            );
          } else if (request.type === "worker.stop") {
            stop();
            socket.write(
              `${JSON.stringify(workerSuccess(request.id, { accepted: true }))}\n`,
            );
          } else {
            socket.write(
              `${JSON.stringify(workerFailure(request.id, "NOT_FOUND", `unknown worker request: ${request.type}`))}\n`,
            );
          }
        } catch (error) {
          socket.write(
            `${JSON.stringify(workerFailure("invalid", "PROTOCOL_MISMATCH", error instanceof Error ? error.message : String(error)))}\n`,
          );
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await fs.chmod(socketPath, 0o600);
  return server;
}

async function closeServer(
  server: net.Server,
  socketPath: string,
): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(socketPath, { force: true });
}

function workerSuccess(id: string, result: unknown): unknown {
  return { protocol: WORKER_PROTOCOL_VERSION, id, ok: true, result };
}

function workerFailure(id: string, code: string, message: string): unknown {
  return {
    protocol: WORKER_PROTOCOL_VERSION,
    id,
    ok: false,
    error: { code, message },
  };
}
