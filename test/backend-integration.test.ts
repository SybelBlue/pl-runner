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
import type { InstanceStatus, RunEvent, RunRecord, SupervisorStatus } from "../src/types.ts";

test("supervisor manages and recovers multiple workers independently", { timeout: 40_000 }, async () => {
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
  echo "fake stdout $*"
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
  const [firstPort, secondPort] = await availablePorts(2);

  let firstBackend: Promise<void> | null = null;
  let secondBackend: Promise<void> | null = null;
  let alpha: InstanceStatus | null = null;
  let beta: InstanceStatus | null = null;
  let blockedServer: net.Server | null = null;
  try {
    firstBackend = runBackend(env);
    await waitForSocket(socketPath);
    await assert.rejects(request(socketPath, "unknown.operation"), /NOT_FOUND/);
    alpha = await request<InstanceStatus>(socketPath, "instance.create", {
      name: "alpha",
      config: dockerConfig(course, jobs, firstPort),
    });
    beta = await request<InstanceStatus>(socketPath, "instance.create", {
      name: "beta",
      config: dockerConfig(course, jobs, secondPort),
    });
    await assert.rejects(
      request(socketPath, "instance.create", {
        name: "duplicate-port",
        config: dockerConfig(course, jobs, firstPort),
      }),
      /PORT_CONFLICT/,
    );
    await assert.rejects(
      request(socketPath, "instance.create", {
        name: "ALPHA",
        config: dockerConfig(course, jobs, await availablePort()),
      }),
      /INSTANCE_NAME_CONFLICT/,
    );

    const portServer = net.createServer();
    blockedServer = portServer;
    await new Promise<void>((resolve, reject) => {
      portServer.once("error", reject);
      portServer.listen(0, "0.0.0.0", () => resolve());
    });
    const blockedPort = (portServer.address() as net.AddressInfo).port;
    const blocked = await request<InstanceStatus>(socketPath, "instance.create", {
      name: "blocked",
      config: dockerConfig(course, jobs, blockedPort),
    });
    await assert.rejects(
      request(socketPath, "instance.start", { instanceId: blocked.id }),
      /PORT_IN_USE/,
    );
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    blockedServer = null;
    await request(socketPath, "instance.delete", { instanceId: blocked.id });

    const [alphaRun, betaRun] = await Promise.all([
      request<RunRecord>(socketPath, "instance.start", { instanceId: alpha.id }),
      request<RunRecord>(socketPath, "instance.start", { instanceId: beta.id }),
    ]);
    await Promise.all([
      waitForState(socketPath, alpha.id, alphaRun.runId, "running"),
      waitForState(socketPath, beta.id, betaRun.runId, "running"),
    ]);
    await assert.rejects(
      request(socketPath, "instance.delete", { instanceId: alpha.id }),
      /ACTIVE_INSTANCE_CONFLICT/,
    );
    await assert.rejects(
      request(socketPath, "instance.update", {
        instanceId: alpha.id,
        name: "alpha-renamed",
        config: alpha.config,
      }),
      /ACTIVE_INSTANCE_CONFLICT/,
    );

    await request(socketPath, "backend.shutdown");
    await firstBackend;
    firstBackend = null;

    secondBackend = runBackend(env);
    await waitForSocket(socketPath);
    const recovered = await request<SupervisorStatus>(socketPath, "status.get");
    assert.equal(recovered.instances.find((item) => item.id === alpha?.id)?.run?.state, "running");
    assert.equal(recovered.instances.find((item) => item.id === beta?.id)?.run?.state, "running");

    const events = await request<RunEvent[]>(socketPath, "logs.tail", {
      instanceId: alpha.id,
      runId: alphaRun.runId,
      limit: 100,
      stream: "all",
    });
    assert.equal(events.some((event) => event.source === "stdout" && event.message.includes("fake stdout")), true);
    assert.equal(events.some((event) => event.source === "stderr" && event.message === "fake stderr"), true);

    const restartedAlpha = await request<RunRecord>(socketPath, "instance.restart", { instanceId: alpha.id });
    assert.notEqual(restartedAlpha.runId, alphaRun.runId);
    const afterRestart = await waitForState(socketPath, alpha.id, restartedAlpha.runId, "running");
    assert.equal(afterRestart.instances.find((item) => item.id === beta?.id)?.run?.state, "running");
    const retainedEvents = await request<RunEvent[]>(socketPath, "logs.tail", {
      instanceId: alpha.id,
      runId: alphaRun.runId,
      limit: 100,
      stream: "all",
    });
    assert.equal(retainedEvents.some((event) => event.message.includes("fake stdout")), true);

    await request(socketPath, "instance.stop", { instanceId: alpha.id });
    const stopped = await waitForState(socketPath, alpha.id, restartedAlpha.runId, "stopped");
    assert.equal(stopped.instances.find((item) => item.id === beta?.id)?.run?.state, "running");

    await request(socketPath, "instance.delete", { instanceId: alpha.id });
    const afterDelete = await request<SupervisorStatus>(socketPath, "status.get");
    assert.equal(afterDelete.instances.some((item) => item.id === alpha?.id), false);

    await request(socketPath, "instance.stop", { instanceId: beta.id });
    await waitForState(socketPath, beta.id, betaRun.runId, "stopped");
    assert.deepEqual(await fs.readdir(jobs), []);
    await request(socketPath, "backend.shutdown");
    await secondBackend;
    secondBackend = null;
  } finally {
    if (blockedServer?.listening) {
      await new Promise<void>((resolve) => blockedServer?.close(() => resolve()));
    }
    if (firstBackend) {
      if (alpha) await request(socketPath, "instance.stop", { instanceId: alpha.id }).catch(() => undefined);
      if (beta) await request(socketPath, "instance.stop", { instanceId: beta.id }).catch(() => undefined);
      await request(socketPath, "backend.shutdown").catch(() => undefined);
      await firstBackend.catch(() => undefined);
    }
    if (secondBackend) {
      if (alpha) await request(socketPath, "instance.stop", { instanceId: alpha.id }).catch(() => undefined);
      if (beta) await request(socketPath, "instance.stop", { instanceId: beta.id }).catch(() => undefined);
      await request(socketPath, "backend.shutdown").catch(() => undefined);
      await secondBackend.catch(() => undefined);
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function dockerConfig(course: string, jobs: string, port: number) {
  return {
    mode: "docker",
    course_path: course,
    image: "us-prod-live",
    port,
    tmp_dir: jobs,
    local_only: true,
    quiet: true,
  };
}

async function request<T = unknown>(socketPath: string, type: string, payload: unknown = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const id = randomUUID();
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ protocol: 2, id, type, payload })}\n`);
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
  instanceId: string,
  runId: string,
  expected: "running" | "stopped",
): Promise<SupervisorStatus> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status = await request<SupervisorStatus>(socketPath, "status.get");
    const run = status.instances.find((item) => item.id === instanceId)?.run;
    if (run?.runId === runId && run.state === expected) return status;
    if (run?.state === "failed") throw new Error(run.errorMessage ?? "worker failed");
    await delay(100);
  }
  throw new Error(`run did not reach ${expected}`);
}

async function availablePorts(count: number): Promise<number[]> {
  const servers: net.Server[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      servers.push(server);
    }
    return servers.map((server) => (server.address() as net.AddressInfo).port);
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}

async function availablePort(): Promise<number> {
  return (await availablePorts(1))[0]!;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
