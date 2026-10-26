import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanStopBackend } from "../src/cli/client.ts";
import { PROTOCOL_VERSION } from "../src/core/protocol.ts";
import type {
  LifecycleState,
  RunRecord,
  SupervisorStatus,
} from "../src/core/types.ts";
import { runtimePaths } from "../src/system/paths.ts";

test("clean stop waits for managed processes before shutting down the backend", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pl-client-test-"));
  const previousRuntime = process.env.PRAIRIELEARN_RUNTIME_DIR;
  const previousState = process.env.PRAIRIELEARN_STATE_DIR;
  process.env.PRAIRIELEARN_RUNTIME_DIR = path.join(directory, "runtime");
  process.env.PRAIRIELEARN_STATE_DIR = path.join(directory, "state");
  await fs.mkdir(process.env.PRAIRIELEARN_RUNTIME_DIR);

  const requests: string[] = [];
  let runState: LifecycleState = "running";
  const run: RunRecord = {
    instanceId: "instance-1",
    runId: "run-1",
    runDir: path.join(directory, "run-1"),
    workerSocket: path.join(directory, "worker.sock"),
    config: {
      mode: "docker",
      course_path: "/course",
      image: "us-prod-live",
      port: 3000,
      tmp_dir: "/tmp",
      local_only: true,
      quiet: true,
    },
    state: runState,
    pid: 200,
    childPid: 201,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    exitCode: null,
    errorCode: null,
    errorMessage: null,
  };
  const status = (): SupervisorStatus => ({
    backend: {
      running: true,
      pid: 100,
      protocolVersion: PROTOCOL_VERSION,
      packageVersion: "test",
    },
    instances: [
      {
        id: "instance-1",
        name: "alpha",
        config: run.config,
        run: { ...run, state: runState },
      },
    ],
  });

  const socketPath = runtimePaths().backendSocket;
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        id: string;
        type: string;
      };
      requests.push(request.type);
      let result: unknown;
      if (request.type === "hello") {
        result = {
          protocolVersion: PROTOCOL_VERSION,
          packageVersion: "test",
          capabilities: [],
        };
      } else if (
        request.type === "backend.status" ||
        request.type === "status.get"
      ) {
        result = status();
      } else if (request.type === "instance.stop") {
        runState = "stopped";
        result = { ...run, state: "stopping" };
      } else if (request.type === "backend.shutdown") {
        result = { accepted: true, activeInstancesPreserved: 0 };
      } else {
        throw new Error(`unexpected request: ${request.type}`);
      }
      socket.write(
        `${JSON.stringify({ protocol: PROTOCOL_VERSION, id: request.id, ok: true, result })}\n`,
      );
      if (request.type === "backend.shutdown") {
        setImmediate(() => server.close());
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    const result = await cleanStopBackend();
    assert.deepEqual(result, {
      backendPid: 100,
      stoppedInstanceIds: ["instance-1"],
    });
    assert.deepEqual(requests, [
      "hello",
      "backend.status",
      "instance.stop",
      "status.get",
      "backend.status",
      "backend.shutdown",
    ]);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (previousRuntime === undefined)
      delete process.env.PRAIRIELEARN_RUNTIME_DIR;
    else process.env.PRAIRIELEARN_RUNTIME_DIR = previousRuntime;
    if (previousState === undefined) delete process.env.PRAIRIELEARN_STATE_DIR;
    else process.env.PRAIRIELEARN_STATE_DIR = previousState;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
