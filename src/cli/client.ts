import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import { spawn } from "node:child_process";
import { nodeEntrypoint } from "../system/entrypoint.js";
import { ensureRuntimePaths, runtimePaths } from "../system/paths.js";
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

export async function backendIsRunning(): Promise<boolean> {
  const socket = await connectBackend();
  if (!socket) return false;
  socket.end();
  return true;
}

async function startBackend(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (await backendIsRunning()) return;
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

async function waitForBackend(timeoutMs = 5_000): Promise<net.Socket> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const socket = await connectBackend();
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

async function connectBackend(): Promise<net.Socket | null> {
  const socketPath = runtimePaths().backendSocket;
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
