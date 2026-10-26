import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventLog, omitDependencyPackageChanges, readEvents, sanitizeTerminalText } from "../src/event-log.ts";
import type { RunEvent } from "../src/types.ts";

test("sanitizes terminal control sequences", () => {
  assert.equal(sanitizeTerminalText("red\x1b[31m!\x1b[0m\x1b]11;#fff\x07"), "red!");
});

test("persists sequenced stdout and stderr events", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pl-event-log-test-"));
  try {
    const file = path.join(directory, "events.jsonl");
    const log = new EventLog(file, "run");
    await log.initialize();
    await log.append("stdout", "server", "one\ntwo\n");
    await log.append("stderr", "server", "three");
    await log.flush();
    const events = await readEvents(file, 10);
    assert.deepEqual(events.map(({ seq, source, message }) => ({ seq, source, message })), [
      { seq: 1, source: "stdout", message: "one" },
      { seq: 2, source: "stdout", message: "two" },
      { seq: 3, source: "stderr", message: "three" },
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("omits uv's dependency package-change list", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pl-event-log-test-"));
  try {
    const file = path.join(directory, "events.jsonl");
    const log = new EventLog(file, "run");
    await log.initialize();
    await log.append("stderr", "dependencies", "Installed 131 packages in 1.30s\n");
    await log.append("stderr", "dependencies", "Bytecode compiled 12102 files in 5.54s\n");
    await log.append("stderr", "dependencies", " \n+ typing-extensions==4.16.0\n");
    await log.append("stderr", "dependencies", " + typing-inspection==0.4.2\n0\n + wrapt==2.4.1\n");
    await log.append("stdout", "dependencies", "Tasks: 48 successful, 48 total\n");
    await log.append("stderr", "dependencies", "a later diagnostic\n");
    await log.flush();

    const events = await readEvents(file, 20);
    assert.deepEqual(events.map((event) => event.message), [
      "Installed 131 packages in 1.30s",
      "Bytecode compiled 12102 files in 5.54s",
      "Tasks: 48 successful, 48 total",
      "a later diagnostic",
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("omits dependency package changes from existing event logs", () => {
  const events: RunEvent[] = [
    event(1, "Installed 2 packages in 10ms"),
    event(2, "Bytecode compiled 20 files in 5ms"),
    event(3, "+ first==1.0"),
    event(4, ".1"),
    { ...event(5, "build complete"), source: "stdout" },
  ];

  assert.deepEqual(omitDependencyPackageChanges(events).map((item) => item.seq), [1, 2, 5]);
});

function event(seq: number, message: string): RunEvent {
  return {
    seq,
    timestamp: "2026-01-01T00:00:00.000Z",
    source: "stderr",
    phase: "dependencies",
    message,
  };
}
