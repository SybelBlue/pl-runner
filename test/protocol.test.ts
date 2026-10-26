import assert from "node:assert/strict";
import test from "node:test";
import { launchConfigSchema, requestSchema } from "../src/protocol.ts";

test("validates versioned request envelopes", () => {
  assert.deepEqual(requestSchema.parse({ protocol: 2, id: "a", type: "status.get", payload: {} }), {
    protocol: 2,
    id: "a",
    type: "status.get",
    payload: {},
  });
  assert.throws(() => requestSchema.parse({ protocol: 1, id: "a", type: "status.get" }));
});

test("rejects malformed launch configurations", () => {
  assert.equal(launchConfigSchema.parse({
    mode: "git",
    path: "/pl",
    branch: null,
    port: 3000,
    isolated_database: false,
    force_rebuild: false,
    local_only: true,
    no_watch_upstream: true,
    quiet: false,
  }).mode, "git");
  assert.throws(() => launchConfigSchema.parse({ mode: "git", path: "" }));
  assert.throws(() => launchConfigSchema.parse({
    mode: "docker",
    course_path: "/course",
    image: "unsupported",
    port: 3000,
    tmp_dir: "/tmp",
    local_only: false,
    quiet: false,
  }));
});
