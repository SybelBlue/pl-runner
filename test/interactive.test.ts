import assert from "node:assert/strict";
import test from "node:test";
import { launcherChoices, recommendedLauncherMode } from "../src/interactive.ts";
import type { RunOptions, SavedConfig } from "../src/types.ts";

const baseRun: RunOptions = {
  branch: null,
  force_rebuild: false,
  local_only: false,
  no_watch_upstream: false,
  quiet: false,
};

const saved: SavedConfig = {
  mode: "git",
  path: "/pl",
  branch: null,
  force_rebuild: false,
  local_only: false,
  no_watch_upstream: false,
  internet_available: true,
  quiet: false,
};

test("recommends previous config first when available", () => {
  assert.equal(recommendedLauncherMode({ saved, configuredPath: "/env/pl" }), "previous");
});

test("recommends configured checkout when no previous config exists", () => {
  assert.equal(recommendedLauncherMode({ saved: null, configuredPath: "/env/pl" }), "defaults");
});

test("recommends docker when no git checkout is configured", () => {
  assert.equal(recommendedLauncherMode({ saved: null, configuredPath: null }), "docker");
});

test("disables unavailable previous and configured checkout actions", () => {
  const choices = launcherChoices({ saved: null, configuredPath: null, currentBranch: null }, baseRun);

  assert.equal(choices.find((choice) => choice.value === "previous")?.disabled, true);
  assert.equal(choices.find((choice) => choice.value === "defaults")?.disabled, true);
  assert.equal(choices.find((choice) => choice.value === "custom")?.disabled, undefined);
  assert.equal(choices.find((choice) => choice.value === "docker")?.disabled, undefined);
});

