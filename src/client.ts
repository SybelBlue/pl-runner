import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import { spawn } from "node:child_process";
import { nodeEntrypoint } from "./entrypoint.js";
import { ensureRuntimePaths, runtimePaths } from "./paths.js";
import { PROTOCOL_VERSION, RemoteError, type ProtocolEvent, type ProtocolResponse } from "./protocol.js";
import type { RunEvent, SupervisorStatus } from "./types.js";

export type RequestOptions = {
  autoStart?: boolean;
  timeoutMs?: number;
};

export async function requestBackend<T = unknown>(
  type: string,
  payload: unknown = {},
  options: RequestOptions = {},
): Promise<T> {
  const autoStart = options.autoStart !== false;
  let socket = await connectBackend();
  if (!socket && autoStart) {
    await startBackend();
    socket = await waitForBackend(options.timeoutMs ?? 5_000);
  }
  if (!socket) throw new RemoteError("NOT_RUNNING", "pl-runner backend is not running");
  return sendRequest<T>(socket, type, payload, options.timeoutMs ?? 30_000);
}

export async function backendIsRunning(): Promise<boolean> {
  const socket = await connectBackend();
  if (!socket) return false;
  socket.end();
  return true;
}

async function startBackend(env: NodeJS.ProcessEnv = process.env): Promise<void> {
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
  throw new RemoteError("NOT_RUNNING", "timed out waiting for pl-runner backend to start");
}

export async function waitForStart(runId: string, timeoutMs = 30 * 60_000): Promise<SupervisorStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await requestBackend<SupervisorStatus>("status.get");
    const instance = status.instance;
    if (!instance || instance.runId !== runId) {
      throw new RemoteError("WORKER_RECOVERY_FAILED", "the requested run is no longer current");
    }
    if (instance.state === "running" || instance.state === "failed" || instance.state === "stopped") return status;
    await delay(100);
  }
  throw new RemoteError("INTERNAL_ERROR", "timed out waiting for the managed instance to start");
}

export async function waitForTerminal(runId: string, timeoutMs = 20_000): Promise<SupervisorStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await requestBackend<SupervisorStatus>("status.get");
    const instance = status.instance;
    if (!instance || instance.runId !== runId || instance.state === "stopped" || instance.state === "failed") return status;
    await delay(100);
  }
  return requestBackend<SupervisorStatus>("status.get");
}

export async function subscribeLogs(
  afterSeq: number,
  stream: "all" | "stdout" | "stderr",
  onEvent: (event: RunEvent) => void,
): Promise<{ close: () => void; done: Promise<void> }> {
  let socket = await connectBackend();
  if (!socket) {
    await startBackend();
    socket = await waitForBackend();
  }
  const id = randomUUID();
  const request = { protocol: PROTOCOL_VERSION, id, type: "logs.subscribe", payload: { afterSeq, stream } };
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
        if (!message.ok) rejectDone(new RemoteError(message.error.code, message.error.message, message.error.details));
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

function sendRequest<T>(socket: net.Socket, type: string, payload: unknown, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new RemoteError("INTERNAL_ERROR", `backend request timed out: ${type}`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      const response = JSON.parse(buffer.slice(0, newline)) as ProtocolResponse<T>;
      socket.end();
      if (response.id !== id) {
        reject(new RemoteError("PROTOCOL_MISMATCH", "backend response id did not match request"));
      } else if (response.ok) {
        resolve(response.result);
      } else {
        reject(new RemoteError(response.error.code, response.error.message, response.error.details));
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.write(`${JSON.stringify({ protocol: PROTOCOL_VERSION, id, type, payload })}\n`);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
