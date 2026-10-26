import assert from "node:assert/strict";
import test from "node:test";
import {
  isBackendOperation,
  parseBackendPayload,
  type BackendOperationMap,
} from "../src/protocol.ts";

const config = {
  mode: "docker" as const,
  course_path: "/course",
  image: "us-prod-live" as const,
  port: 3000,
  tmp_dir: "/tmp",
  local_only: true,
  quiet: true,
};

const payloads = {
  hello: {},
  "status.get": {},
  "backend.status": {},
  "instance.get": { instanceId: "one" },
  "instance.create": { name: "one", config },
  "instance.update": { instanceId: "one", name: "renamed", config },
  "instance.delete": { instanceId: "one" },
  "host.inspect": { mode: "docker" as const, path: "/course" },
  "instance.start": { instanceId: "one", allowPullFailure: true },
  "instance.stop": { instanceId: "one" },
  "instance.restart": { instanceId: "one", startDockerDaemon: true },
  "logs.tail": { instanceId: "one", runId: "run", limit: 20, afterSeq: 4, stream: "stderr" as const },
  "logs.subscribe": { instanceId: "one", runId: "run", afterSeq: 4, stream: "all" as const },
  "docker.startDaemon": {},
  "backend.shutdown": {},
} satisfies { [K in keyof BackendOperationMap]: BackendOperationMap[K]["payload"] };

test("validates every backend operation payload", () => {
  for (const type of Object.keys(payloads) as Array<keyof BackendOperationMap>) {
    assert.equal(isBackendOperation(type), true);
    assert.deepEqual(parseBackendPayload(type, payloads[type]), payloads[type]);
  }
  assert.equal(isBackendOperation("unknown.operation"), false);
});

test("rejects malformed operation-specific payloads", () => {
  assert.throws(() => parseBackendPayload("instance.get", {}));
  assert.throws(() => parseBackendPayload("instance.create", { name: "", config }));
  assert.throws(() => parseBackendPayload("logs.tail", { instanceId: "one", stream: "invalid" }));
});
