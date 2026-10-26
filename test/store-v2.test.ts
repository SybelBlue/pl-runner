import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSupervisorState } from "../src/store.ts";

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
    assert.deepEqual(first.savedConfig, {
      mode: "git",
      path: "/PrairieLearn",
      branch: null,
      force_rebuild: false,
      local_only: true,
      no_watch_upstream: true,
      quiet: false,
    });
    assert.equal(await fs.readFile(legacy, "utf8"), contents);
    await fs.writeFile(legacy, "mode: docker\n");
    const second = await loadSupervisorState(env);
    assert.deepEqual(second.savedConfig, first.savedConfig);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
