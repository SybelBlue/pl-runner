import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventLog, readEvents, sanitizeTerminalText } from "../src/event-log.ts";

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
