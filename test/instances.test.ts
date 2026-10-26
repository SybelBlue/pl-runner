import assert from "node:assert/strict";
import test from "node:test";
import {
  findInstanceByName,
  isActive,
  isRestartEligible,
  isStartEligible,
  nextAvailablePort,
  nextProfileName,
} from "../src/core/instances.ts";
import type { InstanceStatus, LifecycleState } from "../src/core/types.ts";

const config = {
  mode: "docker" as const,
  course_path: "/course",
  image: "us-prod-live" as const,
  port: 3000,
  tmp_dir: "/tmp",
  local_only: true,
  quiet: true,
};

function instance(name: string, state?: LifecycleState): InstanceStatus {
  return {
    id: name,
    name,
    config,
    run: state
      ? {
          instanceId: name,
          runId: `${name}-run`,
          runDir: `/runs/${name}`,
          workerSocket: `/sockets/${name}`,
          config,
          state,
          pid: 1,
          childPid: null,
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          exitCode: null,
          errorCode: null,
          errorMessage: null,
        }
      : null,
  };
}

test("centralizes lifecycle eligibility", () => {
  for (const state of ["preparing", "starting", "running", "stopping"] as const) {
    assert.equal(isActive(state), true);
    assert.equal(isStartEligible(instance(state, state)), false);
  }
  assert.equal(isActive("stopped"), false);
  assert.equal(isActive("failed"), false);
  assert.equal(isStartEligible(instance("stopped", "stopped")), true);
  assert.equal(isRestartEligible(instance("running", "running")), true);
  assert.equal(isRestartEligible(instance("failed", "failed")), true);
  assert.equal(isRestartEligible(instance("stopped", "stopped")), false);
});

test("matches names case-insensitively and generates an unused profile name", () => {
  const instances = [instance("Alpha"), instance("server-1"), instance("SERVER-2")];
  assert.equal(findInstanceByName(instances, " alpha ")?.id, "Alpha");
  assert.equal(nextProfileName(instances), "server-3");
});

test("allocates the lowest port and reports exhaustion", () => {
  const instances = [instance("first"), { ...instance("second"), config: { ...config, port: 3002 } }];
  assert.equal(nextAvailablePort(instances), 3001);
  assert.throws(
    () => nextAvailablePort([{ config: { port: 65_535 } }], 65_535),
    /no available TCP port remains/,
  );
});
