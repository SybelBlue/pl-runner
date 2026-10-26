import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimePaths } from "../src/system/paths.ts";
import { loadSupervisorState, pruneRunHistory } from "../src/backend/store.ts";
import type { SupervisorState } from "../src/core/types.ts";

test("imports legacy YAML once and leaves it untouched", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pl-store-test-"));
  const legacy = path.join(directory, "last-config.yaml");
  const stateDir = path.join(directory, "state");
  const contents = [
    "mode: git",
    "path: /PrairieLearn",
    "branch: null",
    "force_rebuild: false",
    "local_only: true",
    "no_watch_upstream: true",
    "internet_available: false",
    "quiet: false",
    "",
  ].join("\n");
  await fs.writeFile(legacy, contents);
  try {
    const env = {
      ...process.env,
      PRAIRIELEARN_STATE_DIR: stateDir,
      PRAIRIELEARN_RUNTIME_DIR: path.join(directory, "runtime"),
      PRAIRIELEARN_PREVIOUS_CONFIG_FILE: legacy,
    };
    const first = await loadSupervisorState(env);
    assert.equal(first.schemaVersion, 3);
    assert.equal(first.instances.length, 1);
    assert.equal(first.instances[0]?.name, "default");
    assert.deepEqual(first.instances[0]?.config, {
      mode: "git",
      path: "/PrairieLearn",
      branch: null,
      port: 3000,
      isolated_database: false,
      force_rebuild: false,
      local_only: true,
      no_watch_upstream: true,
      quiet: false,
    });
    assert.equal(await fs.readFile(legacy, "utf8"), contents);
    await fs.writeFile(legacy, "mode: docker\n");
    const second = await loadSupervisorState(env);
    assert.deepEqual(second.instances, first.instances);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("migrates v2 Docker mappings into named v3 profiles", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pl-store-v2-test-"));
  const env = {
    ...process.env,
    PRAIRIELEARN_STATE_DIR: path.join(directory, "state"),
    PRAIRIELEARN_RUNTIME_DIR: path.join(directory, "runtime"),
    PRAIRIELEARN_PREVIOUS_CONFIG_FILE: path.join(directory, "missing.yaml"),
  };
  try {
    await fs.mkdir(env.PRAIRIELEARN_STATE_DIR, { recursive: true });
    await fs.writeFile(runtimePaths(env).previousStateFile, JSON.stringify({
      schemaVersion: 2,
      savedConfig: {
        mode: "docker",
        course_path: "/course",
        image: "latest",
        port: "3010:3000",
        tmp_dir: "/tmp",
        local_only: true,
        quiet: false,
      },
      currentRun: null,
      history: [],
      migratedLegacyConfig: true,
    }));
    const state = await loadSupervisorState(env);
    assert.equal(state.instances[0]?.config.port, 3010);
    assert.equal(state.instances[0]?.name, "default");
    assert.equal(state.schemaVersion, 3);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("preserves a v2 current run and gives a distinct saved config a free port", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pl-store-current-v2-test-"));
  const env = {
    ...process.env,
    PRAIRIELEARN_STATE_DIR: path.join(directory, "state"),
    PRAIRIELEARN_RUNTIME_DIR: path.join(directory, "runtime"),
    PRAIRIELEARN_PREVIOUS_CONFIG_FILE: path.join(directory, "missing.yaml"),
  };
  try {
    await fs.mkdir(env.PRAIRIELEARN_STATE_DIR, { recursive: true });
    await fs.writeFile(runtimePaths(env).previousStateFile, JSON.stringify({
      schemaVersion: 2,
      savedConfig: {
        mode: "docker",
        course_path: "/course",
        image: "us-prod-live",
        port: "3000:3000",
        tmp_dir: "/tmp",
        local_only: true,
        quiet: false,
      },
      currentRun: {
        runId: "run-current",
        runDir: "/state/run-current",
        workerSocket: "/tmp/worker.sock",
        config: {
          mode: "git",
          path: "/PrairieLearn",
          branch: null,
          force_rebuild: false,
          local_only: true,
          no_watch_upstream: true,
          quiet: false,
        },
        state: "running",
        pid: 12,
        childPid: 34,
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        exitCode: null,
        errorCode: null,
        errorMessage: null,
      },
      history: ["old-run"],
      migratedLegacyConfig: true,
    }));
    const state = await loadSupervisorState(env);
    assert.equal(state.instances.length, 2);
    assert.equal(state.instances[0]?.currentRun?.instanceId, state.instances[0]?.id);
    assert.equal(state.instances[0]?.config.port, 3000);
    assert.equal(state.instances[1]?.config.port, 3001);
    assert.deepEqual(state.instances[0]?.history, ["old-run"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("retains five completed runs per profile without pruning another profile", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pl-store-retention-test-"));
  const env = {
    ...process.env,
    PRAIRIELEARN_STATE_DIR: path.join(directory, "state"),
    PRAIRIELEARN_RUNTIME_DIR: path.join(directory, "runtime"),
  };
  const histories = [
    ["a-1", "a-2", "a-3", "a-4", "a-5", "a-6"],
    ["b-1", "b-2"],
  ];
  const state: SupervisorState = {
    schemaVersion: 3,
    migratedLegacyConfig: true,
    instances: histories.map((history, index) => ({
      id: `instance-${index}`,
      name: `instance-${index}`,
      config: {
        mode: "docker",
        course_path: "/course",
        image: "us-prod-live",
        port: 3000 + index,
        tmp_dir: "/tmp",
        local_only: true,
        quiet: false,
      },
      currentRun: null,
      history,
    })),
  };
  try {
    const runsDir = runtimePaths(env).runsDir;
    await fs.mkdir(runsDir, { recursive: true });
    await Promise.all(histories.flat().map((runId) => fs.mkdir(path.join(runsDir, runId))));
    await pruneRunHistory(state, env, 5);
    assert.deepEqual(state.instances[0]?.history, ["a-2", "a-3", "a-4", "a-5", "a-6"]);
    assert.deepEqual(state.instances[1]?.history, ["b-1", "b-2"]);
    assert.deepEqual((await fs.readdir(runsDir)).sort(), ["a-2", "a-3", "a-4", "a-5", "a-6", "b-1", "b-2"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
