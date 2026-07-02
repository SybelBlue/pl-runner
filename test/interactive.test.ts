import assert from "node:assert/strict";
import test from "node:test";
import { launcherChoices, recommendedLauncherMode, uniqueBranches } from "../src/interactive.ts";
import type { PreflightDependencies } from "../src/deps.ts";
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

const deps: PreflightDependencies = {
  git: true,
  docker: true,
  pnpm: true,
  uv: true,
};

test("recommends previous config first when available", () => {
  assert.equal(recommendedLauncherMode({ saved, configuredPath: "/env/pl", deps }), "previous");
});

test("recommends default configuration when no previous config exists", () => {
  assert.equal(recommendedLauncherMode({ saved: null, configuredPath: "/env/pl", deps }), "defaults");
});

test("recommends docker when no git checkout is configured", () => {
  assert.equal(recommendedLauncherMode({ saved: null, configuredPath: null, deps }), "docker");
});

test("disables unavailable previous and default configuration actions", () => {
  const choices = launcherChoices({ saved: null, configuredPath: null, currentBranch: null, deps }, baseRun);

  assert.equal(choices.find((choice) => choice.value === "previous")?.disabled, true);
  assert.equal(choices.find((choice) => choice.value === "defaults")?.disabled, true);
  assert.equal(choices.find((choice) => choice.value === "custom")?.disabled, false);
  assert.equal(choices.find((choice) => choice.value === "docker")?.disabled, false);
});

test("disables git actions when git or PrairieLearn command dependencies are missing", () => {
  const choices = launcherChoices({
    saved,
    configuredPath: "/env/pl",
    currentBranch: "main",
    deps: { ...deps, pnpm: false },
  }, baseRun);

  assert.equal(choices.find((choice) => choice.value === "previous")?.disabled, true);
  assert.equal(choices.find((choice) => choice.value === "defaults")?.disabled, true);
  assert.equal(choices.find((choice) => choice.value === "custom")?.disabled, true);
  assert.equal(choices.find((choice) => choice.value === "docker")?.disabled, false);
  assert.equal(choices.find((choice) => choice.value === "custom")?.hint, "Missing: pnpm");
});

test("disables docker action when docker is missing", () => {
  const choices = launcherChoices({
    saved: null,
    configuredPath: null,
    currentBranch: null,
    deps: { ...deps, docker: false },
  }, baseRun);

  assert.equal(choices.find((choice) => choice.value === "docker")?.disabled, true);
  assert.equal(choices.find((choice) => choice.value === "docker")?.hint, "Missing: docker");
});

test("preserves branch update order while removing current and duplicate refs", () => {
  assert.deepEqual(
    uniqueBranches("main", ["recent-local", "main", "shared", "older-local"], ["recent-remote", "shared", "older-remote"]),
    ["recent-local", "shared", "older-local", "recent-remote", "older-remote"],
  );
});
