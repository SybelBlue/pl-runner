import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION,
  launchConfigSchema,
  requestSchema,
} from "../src/core/protocol.ts";

test("validates versioned request envelopes", () => {
  assert.deepEqual(
    requestSchema.parse({
      protocol: PROTOCOL_VERSION,
      id: "a",
      type: "status.get",
      payload: {},
    }),
    {
      protocol: PROTOCOL_VERSION,
      id: "a",
      type: "status.get",
      payload: {},
    },
  );
  assert.throws(() =>
    requestSchema.parse({
      protocol: PROTOCOL_VERSION - 1,
      id: "a",
      type: "status.get",
    }),
  );
});

test("rejects malformed launch configurations", () => {
  assert.equal(
    launchConfigSchema.parse({
      mode: "git",
      path: "/pl",
      branch: null,
      port: 3000,
      isolated_database: false,
      force_rebuild: false,
      local_only: true,
      no_watch_upstream: true,
      quiet: false,
    }).mode,
    "git",
  );
  assert.throws(() => launchConfigSchema.parse({ mode: "git", path: "" }));
  assert.throws(() =>
    launchConfigSchema.parse({
      mode: "docker",
      course_path: "/course",
      image: "unsupported",
      port: 3000,
      tmp_dir: "/tmp",
      local_only: false,
      quiet: false,
    }),
  );
});
