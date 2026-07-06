import assert from "node:assert/strict";
import test from "node:test";
import { parseConfigYaml, stateFilePath, stringifyConfigYaml } from "../src/state.ts";

test("uses state file path precedence", () => {
  assert.equal(
    stateFilePath({ PRAIRIELEARN_PREVIOUS_CONFIG_FILE: "~/pl.yaml" }),
    `${process.env.HOME}/pl.yaml`,
  );
  assert.equal(
    stateFilePath({ XDG_STATE_HOME: "/state" }),
    "/state/prairielearn/last-config.yaml",
  );
});

test("round trips git config yaml", () => {
  const yaml = stringifyConfigYaml({
    mode: "git",
    path: "/path/to/PrairieLearn",
    branch: null,
    force_rebuild: false,
    local_only: false,
    no_watch_upstream: false,
    internet_available: true,
    quiet: false,
  });
  assert.deepEqual(parseConfigYaml(yaml), {
    mode: "git",
    path: "/path/to/PrairieLearn",
    branch: null,
    force_rebuild: false,
    local_only: false,
    no_watch_upstream: false,
    internet_available: true,
    quiet: false,
  });
});

test("round trips docker config yaml", () => {
  const yaml = stringifyConfigYaml({
    mode: "docker",
    course_path: "/course path",
    image: "latest",
    port: "3000:3000",
    tmp_dir: "/tmp",
    local_only: false,
    quiet: true,
  });
  assert.deepEqual(parseConfigYaml(yaml), {
    mode: "docker",
    course_path: "/course path",
    image: "latest",
    port: "3000:3000",
    tmp_dir: "/tmp",
    local_only: false,
    quiet: true,
  });
});

test("defaults docker image for older saved configs", () => {
  assert.deepEqual(parseConfigYaml([
    "mode: docker",
    "course_path: /course",
    "port: 3000:3000",
    "tmp_dir: /tmp",
    "local_only: false",
    "quiet: false",
    "",
  ].join("\n")), {
    mode: "docker",
    course_path: "/course",
    image: "us-prod-live",
    port: "3000:3000",
    tmp_dir: "/tmp",
    local_only: false,
    quiet: false,
  });
});

test("ignores malformed config yaml", () => {
  assert.equal(parseConfigYaml("mode: git\nforce_rebuild: no\n"), null);
});
