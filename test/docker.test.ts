import assert from "node:assert/strict";
import test from "node:test";
import { dockerRunArgs } from "../src/docker.ts";

test("assembles docker run arguments", () => {
  assert.deepEqual(dockerRunArgs({
    course_path: "/course",
    port: "3000:3000",
    tmp_dir: "/tmp",
    local_only: false,
    quiet: false,
  }, "/tmp/pl-jobs-dir.abc"), [
    "run",
    "-it",
    "--rm",
    "--pull=always",
    "-p",
    "3000:3000",
    "-v",
    "/course:/course",
    "-v",
    "/tmp/pl-jobs-dir.abc:/jobs",
    "-e",
    "HOST_JOBS_DIR=/tmp/pl-jobs-dir.abc",
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "--add-host=host.docker.internal:172.17.0.1",
    "prairielearn/prairielearn:us-prod-live",
  ]);
});
