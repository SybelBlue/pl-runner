import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadWorkerState } from "../src/backend/store.ts";
import { readEvents } from "../src/worker/event-log.ts";
import { recordWorkerStartupFailure } from "../src/worker/worker.ts";

test("records worker failures that happen before lifecycle logging starts", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "pl-worker-failure-test-"),
  );
  const runDir = path.join(directory, "run");
  const requestPath = path.join(runDir, "request.json");
  try {
    await fs.mkdir(runDir);
    await fs.writeFile(
      requestPath,
      JSON.stringify({
        instanceId: "instance-1",
        runId: "run-1",
        runDir,
        workerSocket: path.join(directory, "worker.sock"),
        config: {
          mode: "git",
          path: "/PrairieLearn",
          branch: null,
          port: 3000,
          isolated_database: false,
          force_rebuild: false,
          local_only: true,
          no_watch_upstream: true,
          quiet: true,
        },
        allowPullFailure: false,
        startDockerDaemon: false,
      }),
    );

    await recordWorkerStartupFailure(
      requestPath,
      new Error("socket unavailable"),
    );

    const state = await loadWorkerState(runDir);
    assert.equal(state?.state, "failed");
    assert.equal(state?.errorCode, "WORKER_START_FAILED");
    assert.equal(state?.errorMessage, "socket unavailable");
    const events = await readEvents(path.join(runDir, "events.jsonl"));
    assert.equal(
      events.at(-1)?.message,
      "worker failed to start: socket unavailable",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
