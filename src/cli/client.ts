import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import { spawn } from "node:child_process";
import { nodeEntrypoint } from "../system/entrypoint.js";
import { ensureRuntimePaths, runtimePaths } from "../system/paths.js";
import { runCommand } from "../system/process.js";
import {
  PROTOCOL_VERSION,
  RemoteError,
  type BackendOperation,
  type BackendPayload,
  type BackendResult,
  type ProtocolEvent,
  type ProtocolResponse,
} from "../core/protocol.js";
import type { RunEvent, SupervisorStatus } from "../core/types.js";

export type RequestOptions = {
  autoStart?: boolean;
  timeoutMs?: number;
};

export type BackendKillResult = {
  killedPids: number[];
};

let compatibilityCheck: Promise<void> | null = null;
let recoveryCheck: Promise<void> | null = null;

export async function requestBackend<K extends BackendOperation>(
  type: K,
  payload: BackendPayload<K>,
  options: RequestOptions = {},
): Promise<BackendResult<K>> {
  const autoStart = options.autoStart !== false;
  await ensureCompatibleBackend(autoStart, options.timeoutMs ?? 5_000);
  let socket = await connectBackend();
  if (!socket && autoStart) {
    await recoverCompatibleBackend(options.timeoutMs ?? 5_000);
    socket = await connectBackend();
  }
  if (!socket)
    throw new RemoteError("NOT_RUNNING", "pl-runner backend is not running");
  const result = await sendRequest<BackendResult<K>>(
    socket,
    type,
    payload,
    options.timeoutMs ?? 30_000,
  );
  if (type === "backend.shutdown") compatibilityCheck = null;
  return result;
}

export async function backendIsRunning(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const socket = await connectBackend(env);
  if (!socket) return false;
  socket.end();
  return true;
}

/**
 * Stops the supervisor without relying on its request loop. Durable workers are
 * separate processes and intentionally remain running.
 */
export async function killBackend(
  knownPid?: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<BackendKillResult> {
  compatibilityCheck = null;
  recoveryCheck = null;
  const paths = await ensureRuntimePaths(env);
  const recordedPid = await readBackendPid(paths.backendPid);
  const socketIdentity = await readSocketIdentity(paths.backendSocket);
  const socketPids = await findSocketOwners(paths.backendSocket);
  const fallbackPid = validBackendPid(knownPid) ? knownPid : recordedPid;
  const candidates = new Set(
    (socketPids.length > 0
      ? socketPids
      : fallbackPid !== undefined
        ? [fallbackPid]
        : []
    ).filter((pid) => pid !== process.pid),
  );
  const matchingPids = await findBackendEntrypoints([...candidates]);
  const targetPids =
    matchingPids.length > 0
      ? matchingPids
      : socketPids.length === 1 && socketPids[0] !== process.pid
        ? socketPids
        : [];

  if (targetPids.length === 0) {
    const socket = await connectBackend(env);
    if (socket) {
      socket.end();
      throw new RemoteError(
        "INTERNAL_ERROR",
        "could not safely identify the backend process to kill",
      );
    }
  } else {
    await terminateProcesses(targetPids);
  }

  await Promise.all([
    removeOwnedSocket(paths.backendSocket, socketIdentity),
    removeStalePidFile(paths.backendPid, new Set(targetPids)),
  ]);
  return { killedPids: targetPids };
}

export async function restartBackend(
  knownPid?: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SupervisorStatus> {
  await killBackend(knownPid, env);
  await startBackend(env);
  const socket = await waitForBackend(5_000, env);
  compatibilityCheck = null;
  recoveryCheck = null;
  return sendRequest<SupervisorStatus>(socket, "backend.status", {}, 30_000);
}

async function startBackend(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (await backendIsRunning(env)) return;
  const paths = await ensureRuntimePaths(env);
  const entry = nodeEntrypoint("backend-entry");
  const log = await fs.open(paths.backendLog, "a", 0o600);
  try {
    const child = spawn(entry.command, entry.args, {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env,
    });
    child.unref();
  } finally {
    await log.close();
  }
}

async function waitForBackend(
  timeoutMs = 5_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<net.Socket> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const socket = await connectBackend(env);
    if (socket) return socket;
    await delay(50);
  }
  throw new RemoteError(
    "NOT_RUNNING",
    "timed out waiting for pl-runner backend to start",
  );
}

export async function waitForStart(
  instanceId: string,
  runId: string,
  timeoutMs = 30 * 60_000,
): Promise<SupervisorStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await requestBackend("status.get", {});
    const instance = status.instances.find(
      (candidate) => candidate.id === instanceId,
    );
    if (!instance?.run || instance.run.runId !== runId) {
      throw new RemoteError(
        "WORKER_RECOVERY_FAILED",
        "the requested run is no longer current",
      );
    }
    if (
      instance.run.state === "running" ||
      instance.run.state === "failed" ||
      instance.run.state === "stopped"
    )
      return status;
    await delay(100);
  }
  throw new RemoteError(
    "INTERNAL_ERROR",
    "timed out waiting for the managed instance to start",
  );
}

export async function waitForTerminal(
  instanceId: string,
  runId: string,
  timeoutMs = 20_000,
): Promise<SupervisorStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await requestBackend("status.get", {});
    const instance = status.instances.find(
      (candidate) => candidate.id === instanceId,
    );
    if (
      !instance?.run ||
      instance.run.runId !== runId ||
      instance.run.state === "stopped" ||
      instance.run.state === "failed"
    )
      return status;
    await delay(100);
  }
  return requestBackend("status.get", {});
}

export async function subscribeLogs(
  instanceId: string,
  runId: string,
  afterSeq: number,
  stream: "all" | "stdout" | "stderr",
  onEvent: (event: RunEvent) => void,
): Promise<{ close: () => void; done: Promise<void> }> {
  await ensureCompatibleBackend(true, 5_000);
  let socket = await connectBackend();
  if (!socket) {
    await recoverCompatibleBackend(5_000);
    socket = await connectBackend();
  }
  if (!socket)
    throw new RemoteError("NOT_RUNNING", "pl-runner backend is not running");
  const id = randomUUID();
  const request = {
    protocol: PROTOCOL_VERSION,
    id,
    type: "logs.subscribe",
    payload: { instanceId, runId, afterSeq, stream },
  };
  let buffer = "";
  let acknowledged = false;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line) as ProtocolResponse | ProtocolEvent;
      if ("id" in message) {
        if (message.id !== id) continue;
        if (!message.ok)
          rejectDone(
            new RemoteError(
              message.error.code,
              message.error.message,
              message.error.details,
            ),
          );
        else acknowledged = true;
      } else if (acknowledged && message.event === "log") {
        onEvent(message.data as RunEvent);
      }
    }
  });
  socket.on("error", (error) => rejectDone(error));
  socket.on("close", () => resolveDone());
  socket.write(`${JSON.stringify(request)}\n`);
  return { close: () => socket.destroy(), done };
}

async function ensureCompatibleBackend(
  autoStart: boolean,
  timeoutMs: number,
): Promise<void> {
  if (!compatibilityCheck) {
    compatibilityCheck = checkCompatibility(autoStart, timeoutMs).catch(
      (error) => {
        compatibilityCheck = null;
        throw error;
      },
    );
  }
  await compatibilityCheck;
}

async function recoverCompatibleBackend(timeoutMs: number): Promise<void> {
  if (!recoveryCheck) {
    compatibilityCheck = null;
    const recovery = ensureCompatibleBackend(true, timeoutMs).finally(() => {
      if (recoveryCheck === recovery) recoveryCheck = null;
    });
    recoveryCheck = recovery;
  }
  await recoveryCheck;
}

async function checkCompatibility(
  autoStart: boolean,
  timeoutMs: number,
): Promise<void> {
  const socket = await connectBackend();
  if (!socket) {
    if (!autoStart)
      throw new RemoteError("NOT_RUNNING", "pl-runner backend is not running");
    await startBackend();
    const started = await waitForBackend(timeoutMs);
    started.end();
    return;
  }
  const version = await probeProtocol(socket);
  if (version === PROTOCOL_VERSION) return;
  if (version !== 1 && version !== 2) {
    throw new RemoteError(
      "PROTOCOL_MISMATCH",
      `unsupported backend protocol: ${version}`,
    );
  }

  // Older supervisors preserve their workers when shut down. Hand the stable
  // socket over to the new supervisor, which will migrate and recover them.
  const legacy = await connectBackend();
  if (!legacy)
    throw new RemoteError(
      "PROTOCOL_MISMATCH",
      "legacy backend disappeared during upgrade",
    );
  await sendLegacyShutdown(legacy, version);
  await waitForBackendStop(timeoutMs);
  await startBackend();
  const started = await waitForBackend(timeoutMs);
  started.end();
}

function probeProtocol(socket: net.Socket): Promise<number> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(
        new RemoteError(
          "PROTOCOL_MISMATCH",
          "backend protocol probe timed out",
        ),
      );
    }, 1_000);
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      const response = JSON.parse(buffer.slice(0, newline)) as {
        protocol?: unknown;
      };
      socket.end();
      resolve(typeof response.protocol === "number" ? response.protocol : -1);
    });
    socket.write(
      `${JSON.stringify({ protocol: PROTOCOL_VERSION, id, type: "hello", payload: {} })}\n`,
    );
  });
}

function sendLegacyShutdown(
  socket: net.Socket,
  protocol: 1 | 2,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(
        new RemoteError(
          "PROTOCOL_MISMATCH",
          "legacy backend shutdown timed out",
        ),
      );
    }, 2_000);
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      clearTimeout(timeout);
      socket.end();
      resolve();
    });
    socket.write(
      `${JSON.stringify({ protocol, id, type: "backend.shutdown", payload: {} })}\n`,
    );
  });
}

async function waitForBackendStop(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const socket = await connectBackend();
    if (!socket) return;
    socket.end();
    await delay(50);
  }
  throw new RemoteError(
    "PROTOCOL_MISMATCH",
    "timed out waiting for legacy backend to stop",
  );
}

async function connectBackend(
  env: NodeJS.ProcessEnv = process.env,
): Promise<net.Socket | null> {
  const socketPath = runtimePaths(env).backendSocket;
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const onError = () => resolve(null);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

async function readBackendPid(pidFile: string): Promise<number | undefined> {
  try {
    const pid = Number((await fs.readFile(pidFile, "utf8")).trim());
    return validBackendPid(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function validBackendPid(pid: number | undefined): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1;
}

async function findSocketOwners(socketPath: string): Promise<number[]> {
  const result = await runCommand("lsof", ["-n", "-t", "--", socketPath]);
  if (result.status !== 0 && !result.stdout.trim()) return [];
  return uniquePids(result.stdout.match(/\d+/g) ?? []);
}

async function findBackendEntrypoints(pids: number[]): Promise<number[]> {
  if (pids.length === 0) return [];
  const result = await runCommand("ps", [
    "-ww",
    "-p",
    pids.join(","),
    "-o",
    "pid=,command=",
  ]);
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match || !/[/\\]backend-entry\.(?:js|ts)(?:\s|$)/.test(match[2]!))
        return [];
      return [Number(match[1])];
    })
    .filter((pid) => pids.includes(pid));
}

function uniquePids(values: string[]): number[] {
  return [
    ...new Set(
      values.map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 1),
    ),
  ];
}

async function terminateProcesses(pids: number[]): Promise<void> {
  for (const pid of pids) signalProcess(pid, "SIGTERM");
  await waitForProcesses(pids, 1_000);
  const remaining = pids.filter(processExists);
  for (const pid of remaining) signalProcess(pid, "SIGKILL");
  await waitForProcesses(remaining, 1_000);
  const survivors = remaining.filter(processExists);
  if (survivors.length > 0) {
    throw new RemoteError(
      "INTERNAL_ERROR",
      `backend process did not exit: ${survivors.join(", ")}`,
    );
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcesses(pids: number[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(processExists) && Date.now() < deadline) await delay(50);
}

type SocketIdentity = { dev: number; ino: number };

async function readSocketIdentity(
  socketPath: string,
): Promise<SocketIdentity | undefined> {
  try {
    const stat = await fs.lstat(socketPath);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function removeOwnedSocket(
  socketPath: string,
  expected: SocketIdentity | undefined,
): Promise<void> {
  if (!expected) return;
  try {
    const stat = await fs.lstat(socketPath);
    const uid =
      typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isSocket() || stat.uid !== uid) {
      throw new RemoteError(
        "INTERNAL_ERROR",
        `refusing to remove unsafe socket: ${socketPath}`,
      );
    }
    if (stat.dev !== expected.dev || stat.ino !== expected.ino) return;
    await fs.rm(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeStalePidFile(
  pidFile: string,
  killedPids: Set<number>,
): Promise<void> {
  const pid = await readBackendPid(pidFile);
  if (pid !== undefined && !killedPids.has(pid) && processExists(pid)) return;
  await fs.rm(pidFile, { force: true });
}

function sendRequest<T>(
  socket: net.Socket,
  type: string,
  payload: unknown,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(
        new RemoteError("INTERNAL_ERROR", `backend request timed out: ${type}`),
      );
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      const response = JSON.parse(
        buffer.slice(0, newline),
      ) as ProtocolResponse<T>;
      socket.end();
      if (response.id !== id) {
        reject(
          new RemoteError(
            "PROTOCOL_MISMATCH",
            "backend response id did not match request",
          ),
        );
      } else if (response.ok) {
        resolve(response.result);
      } else {
        reject(
          new RemoteError(
            response.error.code,
            response.error.message,
            response.error.details,
          ),
        );
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.write(
      `${JSON.stringify({ protocol: PROTOCOL_VERSION, id, type, payload })}\n`,
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
