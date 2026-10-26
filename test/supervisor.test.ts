import assert from "node:assert/strict";
import test from "node:test";
import { Supervisor, SupervisorError, type SupervisorDependencyOverrides } from "../src/supervisor.ts";
import type {
  InstanceRecord,
  LaunchConfig,
  RunEvent,
  RunRecord,
  SupervisorState,
  WorkerState,
} from "../src/types.ts";

const dockerConfig = (port: number): LaunchConfig => ({
  mode: "docker",
  course_path: "/course",
  image: "us-prod-live",
  port,
  tmp_dir: "/tmp",
  local_only: true,
  quiet: true,
});

type Harness = {
  supervisor: Supervisor;
  state: SupervisorState;
  saved: SupervisorState[];
  workerStates: Map<string, WorkerState>;
  events: Map<string, RunEvent[]>;
  deleted: string[];
  writtenRequests: unknown[];
  pruneCount(): number;
};

async function createHarness(
  state: SupervisorState,
  ids: string[],
  extra: SupervisorDependencyOverrides = {},
): Promise<Harness> {
  const saved: SupervisorState[] = [];
  const workerStates = new Map<string, WorkerState>();
  const events = new Map<string, RunEvent[]>();
  const deleted: string[] = [];
  const writtenRequests: unknown[] = [];
  let pruneCount = 0;
  let now = Date.parse("2026-01-01T00:00:10.000Z");
  const supervisor = await Supervisor.create({}, {
    persistence: {
      load: async () => state,
      save: async (next) => { saved.push(structuredClone(next)); },
      loadWorker: async (runDir) => workerStates.get(runDir) ?? null,
      prepareRun: async (runId) => ({
        runDir: `/runs/${runId}`,
        workerSocket: `/sockets/${runId}`,
        requestFile: `/runs/${runId}/request.json`,
      }),
      writeWorkerRequest: async (_file, request) => { writtenRequests.push(structuredClone(request)); },
      readEvents: async (runDir) => events.get(runDir) ?? [],
      prune: async () => { pruneCount += 1; },
      deleteRuns: async (instance) => { deleted.push(instance.id); },
      historicalRunDirectory: (runId) => `/runs/${runId}`,
      ...extra.persistence,
    },
    workers: {
      spawn: () => 1234,
      request: async () => ({ accepted: true }),
      waitForTerminal: async (runDir) => {
        const record = state.instances.find((instance) => instance.currentRun?.runDir === runDir)?.currentRun;
        if (!record) return null;
        const terminal: WorkerState = {
          ...record,
          state: "stopped",
          childPid: null,
          exitCode: 0,
          updatedAt: new Date(now).toISOString(),
        };
        workerStates.set(runDir, terminal);
        return terminal;
      },
      ...extra.workers,
    },
    host: {
      portIsAvailable: async () => true,
      inspect: async () => ({
        dependencies: { git: true, docker: true, pnpm: true, uv: true },
        internetAvailable: true,
        dockerImages: [],
      }),
      startDockerDaemon: async () => 0,
      ...extra.host,
    },
    createId: () => {
      const id = ids.shift();
      if (!id) throw new Error("test ID sequence exhausted");
      return id;
    },
    now: () => new Date(now++),
    packageVersion: () => "test",
  });
  return {
    supervisor,
    state,
    saved,
    workerStates,
    events,
    deleted,
    writtenRequests,
    pruneCount: () => pruneCount,
  };
}

test("supervisor owns conflicts, lifecycle, retention, deletion, and run-pinned logs", async () => {
  const state: SupervisorState = { schemaVersion: 3, instances: [], migratedLegacyConfig: true };
  const harness = await createHarness(state, ["instance-1", "run-1", "run-2"]);
  const alpha = await harness.supervisor.createInstance({ name: "alpha", config: dockerConfig(3000) });

  await assert.rejects(
    harness.supervisor.createInstance({ name: " ALPHA ", config: dockerConfig(3001) }),
    (error: unknown) => error instanceof SupervisorError && error.code === "INSTANCE_NAME_CONFLICT",
  );
  await assert.rejects(
    harness.supervisor.createInstance({ name: "beta", config: dockerConfig(3000) }),
    (error: unknown) => error instanceof SupervisorError && error.code === "PORT_CONFLICT",
  );

  const first = await harness.supervisor.startInstance({ instanceId: alpha.id });
  assert.equal(first.runId, "run-1");
  assert.equal(first.pid, 1234);
  assert.equal(harness.writtenRequests.length, 1);
  await assert.rejects(
    harness.supervisor.updateInstance({ instanceId: alpha.id, name: "renamed", config: dockerConfig(3000) }),
    (error: unknown) => error instanceof SupervisorError && error.code === "ACTIVE_INSTANCE_CONFLICT",
  );

  harness.events.set(first.runDir, [{
    seq: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    source: "stdout",
    phase: "running",
    message: "first run",
  }]);
  const second = await harness.supervisor.restartInstance({ instanceId: alpha.id });
  assert.equal(second.runId, "run-2");
  assert.equal(harness.state.instances[0]?.history.includes(first.runId), true);
  assert.equal((await harness.supervisor.tailLogs({
    instanceId: alpha.id,
    runId: first.runId,
    stream: "all",
  }))[0]?.message, "first run");
  assert.equal(harness.pruneCount(), 2);

  await harness.supervisor.stopInstance({ instanceId: alpha.id });
  harness.workerStates.set(second.runDir, {
    ...second,
    state: "stopped",
    childPid: null,
    exitCode: 0,
    updatedAt: "2026-01-01T00:00:10.000Z",
  });
  assert.deepEqual(await harness.supervisor.deleteInstance({ instanceId: alpha.id }), { deletedId: alpha.id });
  assert.deepEqual(harness.deleted, [alpha.id]);
  assert.deepEqual(harness.state.instances, []);
});

test("supervisor marks an unreachable durable worker as failed", async () => {
  const record = runRecord("instance-1", "run-1", "running", "2026-01-01T00:00:00.000Z");
  const state: SupervisorState = {
    schemaVersion: 3,
    migratedLegacyConfig: true,
    instances: [instanceRecord("instance-1", record)],
  };
  const harness = await createHarness(state, [], {
    persistence: { loadWorker: async () => ({ ...record }) },
    workers: { request: async () => { throw new Error("gone"); } },
  });

  const status = await harness.supervisor.status();
  assert.equal(status.instances[0]?.run?.state, "failed");
  assert.equal(status.instances[0]?.run?.errorCode, "WORKER_RECOVERY_FAILED");
  assert.equal(harness.saved.length, 1);
});

test("a concurrent refresh cannot overwrite a queued profile mutation", async () => {
  const record = runRecord("instance-1", "run-1", "stopped", "2026-01-01T00:00:00.000Z");
  const state: SupervisorState = {
    schemaVersion: 3,
    migratedLegacyConfig: true,
    instances: [instanceRecord("instance-1", record)],
  };
  let announceLoad!: () => void;
  let releaseLoad!: () => void;
  const loadStarted = new Promise<void>((resolve) => { announceLoad = resolve; });
  const loadReleased = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const harness = await createHarness(state, ["instance-2"], {
    persistence: {
      loadWorker: async () => {
        announceLoad();
        await loadReleased;
        return null;
      },
    },
  });

  const refreshing = harness.supervisor.status();
  await loadStarted;
  const creating = harness.supervisor.createInstance({ name: "beta", config: dockerConfig(3001) });
  releaseLoad();
  await Promise.all([refreshing, creating]);
  const status = await harness.supervisor.status();
  assert.deepEqual(status.instances.map((instance) => instance.name), ["alpha", "beta"]);
});

function instanceRecord(id: string, currentRun: RunRecord): InstanceRecord {
  return { id, name: "alpha", config: dockerConfig(3000), currentRun, history: [] };
}

function runRecord(
  instanceId: string,
  runId: string,
  state: RunRecord["state"],
  updatedAt: string,
): RunRecord {
  return {
    instanceId,
    runId,
    runDir: `/runs/${runId}`,
    workerSocket: `/sockets/${runId}`,
    config: dockerConfig(3000),
    state,
    pid: 10,
    childPid: 11,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    exitCode: null,
    errorCode: null,
    errorMessage: null,
  };
}
