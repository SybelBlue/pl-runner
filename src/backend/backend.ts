import fs from "node:fs/promises";
import net from "node:net";
import { ensureRuntimePaths } from "../system/paths.js";
import {
  PROTOCOL_VERSION,
  failure,
  isBackendOperation,
  parseBackendPayload,
  requestSchema,
  success,
  type BackendOperation,
  type BackendPayload,
  type BackendResult,
  type ProtocolRequest,
} from "../core/protocol.js";
import { Supervisor, SupervisorError } from "./supervisor.js";
import { packageVersion } from "../system/version.js";

export async function runBackend(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (process.platform === "win32") throw new Error("pl-runner backend supports macOS and Linux only");
  const paths = await ensureRuntimePaths(env);
  await assertSocketAvailable(paths.backendSocket);

  const supervisor = await Supervisor.create(env);
  const handlers = createHandlers(supervisor);
  const clients = new Set<net.Socket>();

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
      writeResponse(socket, failure(
        "invalid",
        "PROTOCOL_MISMATCH",
        error instanceof Error ? error.message : String(error),
      ));
      return;
    }

    try {
      if (!isBackendOperation(request.type)) {
        throw new SupervisorError("NOT_FOUND", `unknown request type: ${request.type}`);
      }
      if (request.type === "logs.subscribe") {
        const input = parsePayload(request.type, request.payload);
        const target = await supervisor.resolveLogTarget(input);
        if (!target) throw new SupervisorError("NOT_FOUND", "the instance has no run to subscribe to");
        let afterSeq = input.afterSeq ?? 0;
        writeResponse(socket, success(request.id, { subscribed: true as const, runId: target.runId }));
        const fixedInput: BackendPayload<"logs.tail"> = {
          ...input,
          instanceId: target.instanceId,
          runId: target.runId,
        };
        const interval = setInterval(() => {
          void supervisor.tailLogs({ ...fixedInput, afterSeq, limit: 1_000 }).then((events) => {
            for (const event of events) {
              afterSeq = Math.max(afterSeq, event.seq);
              socket.write(`${JSON.stringify({ protocol: PROTOCOL_VERSION, event: "log", data: event })}\n`);
            }
          }).catch(() => undefined);
        }, 250);
        intervals.add(interval);
        return;
      }

      const result = await dispatch(handlers, request.type, request.payload);
      writeResponse(socket, success(request.id, result));
      if (request.type === "backend.shutdown") {
        setImmediate(() => {
          server.close();
          for (const client of clients) client.end();
        });
      }
    } catch (error) {
      if (error instanceof SupervisorError) {
        writeResponse(socket, failure(request.id, error.code, error.message, error.details));
      } else {
        writeResponse(socket, failure(
          request.id,
          "INTERNAL_ERROR",
          error instanceof Error ? error.message : String(error),
        ));
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

type DispatchOperation = Exclude<BackendOperation, "logs.subscribe">;
type DispatchHandlers = {
  [K in DispatchOperation]: (payload: BackendPayload<K>) => Promise<BackendResult<K>> | BackendResult<K>;
};

function createHandlers(supervisor: Supervisor): DispatchHandlers {
  return {
    hello: () => Promise.resolve({
      protocolVersion: PROTOCOL_VERSION,
      packageVersion: packageVersion(),
      capabilities: ["instances", "discovery", "lifecycle", "logs", "docker-daemon", "recovery"],
    }),
    "status.get": () => supervisor.status(),
    "backend.status": () => supervisor.status(),
    "instance.get": (payload) => supervisor.getInstance(payload),
    "instance.create": (payload) => supervisor.createInstance(payload),
    "instance.update": (payload) => supervisor.updateInstance(payload),
    "instance.delete": (payload) => supervisor.deleteInstance(payload),
    "host.inspect": (payload) => supervisor.inspectHost(payload),
    "instance.start": (payload) => supervisor.startInstance(payload),
    "instance.stop": (payload) => supervisor.stopInstance(payload),
    "instance.restart": (payload) => supervisor.restartInstance(payload),
    "logs.tail": (payload) => supervisor.tailLogs(payload),
    "docker.startDaemon": () => supervisor.startDockerDaemon(),
    "backend.shutdown": () => supervisor.shutdown(),
  };
}

async function dispatch<K extends DispatchOperation>(
  handlers: DispatchHandlers,
  type: K,
  rawPayload: unknown,
): Promise<BackendResult<K>> {
  return handlers[type](parsePayload(type, rawPayload));
}

function parsePayload<K extends BackendOperation>(type: K, payload: unknown): BackendPayload<K> {
  try {
    return parseBackendPayload(type, payload);
  } catch (error) {
    throw new SupervisorError("INVALID_CONFIG", error instanceof Error ? error.message : String(error));
  }
}

function writeResponse(socket: net.Socket, response: unknown): void {
  socket.write(`${JSON.stringify(response)}\n`);
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
