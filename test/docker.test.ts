import assert from "node:assert/strict";
import test from "node:test";
import {
  dockerDaemonStartCommand,
  dockerRunArgs,
  formerPrairieLearnDanglingImageIds,
  normalizeDockerOptions,
  shellCommand,
} from "../src/docker.ts";

test("assembles docker run arguments", () => {
  assert.deepEqual(dockerRunArgs({
    course_path: "/course",
    image: "latest",
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
    "prairielearn/prairielearn:latest",
  ]);
});

test("rejects unsupported docker image tags", () => {
  assert.throws(() => normalizeDockerOptions({ image: "dev" }), /unsupported Docker image tag: dev/);
});

test("suggests platform-specific docker daemon start commands", () => {
  assert.equal(dockerDaemonStartCommand("darwin"), "open -a Docker");
  assert.equal(dockerDaemonStartCommand("win32"), "Start-Process 'Docker Desktop'");
  assert.equal(dockerDaemonStartCommand("linux"), "sudo systemctl start docker");
});

test("wraps editable daemon start commands in the platform shell", () => {
  assert.deepEqual(shellCommand("open -a Docker", "darwin"), { command: "sh", args: ["-lc", "open -a Docker"] });
  assert.deepEqual(shellCommand("Start-Process 'Docker Desktop'", "win32"), {
    command: "powershell.exe",
    args: ["-NoProfile", "-Command", "Start-Process 'Docker Desktop'"],
  });
});

test("selects only former PrairieLearn images that are now untagged", () => {
  assert.deepEqual(
    formerPrairieLearnDanglingImageIds(
      ["old", "old", "still-tagged", "other-tagged"],
      ["still-tagged"],
      ["old", "not-prairielearn"],
    ),
    ["old"],
  );
});
