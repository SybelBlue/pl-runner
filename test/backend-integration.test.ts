import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runBackend } from "../src/backend.ts";
import { runtimePaths } from "../src/paths.ts";
import type { ProtocolResponse } from "../src/protocol.ts";
import type { RunEvent, RunRecord, SupervisorStatus } from "../src/types.ts";

test("supervisor reconnects to a running worker and preserves its logs", { timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pl-backend-test-"));
  const bin = path.join(directory, "bin");
  const course = path.join(directory, "course");
  const jobs = path.join(directory, "jobs");
  await Promise.all([fs.mkdir(bin), fs.mkdir(course), fs.mkdir(jobs)]);
  const docker = path.join(bin, "docker");
  await fs.writeFile(docker, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Docker fake"; exit 0; fi
if [ "$1" = "info" ]; then exit 0; fi
if [ "$1" = "image" ]; then exit 0; fi
if [ "$1" = "run" ]; then
  trap 'exit 0' INT TERM
  echo "fake stdout"
  echo "fake stderr" >&2
  while true; do sleep 1; done
fi
exit 0
`);
  await fs.chmod(docker, 0o755);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    PRAIRIELEARN_STATE_DIR: path.join(directory, "state"),
    PRAIRIELEARN_RUNTIME_DIR: path.join(directory, "runtime"),
    PRAIRIELEARN_PREVIOUS_CONFIG_FILE: path.join(directory, "missing-legacy.yaml"),
  };
  const socketPath = runtimePaths(env).backendSocket;

  let firstBackend: Promise<void> | null = null;
  let secondBackend: Promise<void> | null = null;
  try {
    firstBackend = runBackend(env);
    await waitForSocket(socketPath);
    const record = await request<RunRecord>(socketPath, "instance.start", {
      config: {
        mode: "docker",
        course_path: course,
        image: "us-prod-live",
        port: "3000:3000",
        tmp_dir: jobs,
        local_only: true,
        quiet: true,
      },
    });
    const running = await waitForState(socketPath, record.runId, "running");
    assert.equal(running.instance?.state, "running");

    await request(socketPath, "backend.shutdown");
    await firstBackend;
    firstBackend = null;

    secondBackend = runBackend(env);
    await waitForSocket(socketPath);
    const recovered = await request<SupervisorStatus>(socketPath, "status.get");
    assert.equal(recovered.instance?.runId, record.runId);
    assert.equal(recovered.instance?.state, "running");

    const events = await request<RunEvent[]>(socketPath, "logs.tail", { limit: 100, stream: "all" });
    assert.equal(events.some((event) => event.source === "stdout" && event.message === "fake stdout"), true);
    assert.equal(events.some((event) => event.source === "stderr" && event.message === "fake stderr"), true);

    await request(socketPath, "instance.stop");
    const stopped = await waitForState(socketPath, record.runId, "stopped");
    assert.equal(stopped.instance?.state, "stopped");
    assert.deepEqual(await fs.readdir(jobs), []);
    await request(socketPath, "backend.shutdown");
    await secondBackend;
    secondBackend = null;
  } finally {
    if (firstBackend) {
      await request(socketPath, "backend.shutdown").catch(() => undefined);
      await firstBackend.catch(() => undefined);
    }
    if (secondBackend) {
      await request(socketPath, "instance.stop").catch(() => undefined);
      await request(socketPath, "backend.shutdown").catch(() => undefined);
      await secondBackend.catch(() => undefined);
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function request<T = unknown>(socketPath: string, type: string, payload: unknown = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const id = randomUUID();
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ protocol: 1, id, type, payload })}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const response = JSON.parse(buffer.slice(0, newline)) as ProtocolResponse<T>;
      socket.end();
      if (response.ok) resolve(response.result);
      else reject(new Error(`${response.error.code}: ${response.error.message}`));
    });
  });
}

async function waitForSocket(socketPath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await request(socketPath, "hello");
      return;
    } catch {
      await delay(50);
    }
  }
  throw new Error("backend socket did not become ready");
}

async function waitForState(
  socketPath: string,
  runId: string,
  expected: "running" | "stopped",
): Promise<SupervisorStatus> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status = await request<SupervisorStatus>(socketPath, "status.get");
    if (status.instance?.runId === runId && status.instance.state === expected) return status;
    if (status.instance?.state === "failed") throw new Error(status.instance.errorMessage ?? "worker failed");
    await delay(100);
  }
  throw new Error(`run did not reach ${expected}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
