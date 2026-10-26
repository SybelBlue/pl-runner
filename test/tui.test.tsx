import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { Box, renderToString } from "ink";
import { render } from "ink-testing-library";
import {
  branchSuggestions,
  ConfigView,
  LogLine,
  StatusLine,
  configFields,
  visibleLogEvents,
} from "../src/tui.tsx";
import type { LaunchConfig, RunEvent, SupervisorStatus } from "../src/types.ts";

const gitConfig: LaunchConfig = {
  mode: "git",
  path: "/PrairieLearn",
  branch: "main",
  force_rebuild: false,
  local_only: true,
  no_watch_upstream: false,
  quiet: false,
};

test("renders the dashboard status summary", () => {
  const status: SupervisorStatus = {
    backend: { running: true, pid: 123, protocolVersion: 1, packageVersion: "0.2.0" },
    savedConfig: gitConfig,
    instance: {
      runId: "12345678-aaaa-bbbb-cccc-dddddddddddd",
      runDir: "/state/run",
      workerSocket: "/tmp/worker.sock",
      config: gitConfig,
      state: "running",
      pid: 456,
      childPid: 789,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      exitCode: null,
      errorCode: null,
      errorMessage: null,
    },
  };
  const view = render(<StatusLine status={status} />);
  assert.match(view.lastFrame() ?? "", /Instance: running · git \/PrairieLearn @ main · run 12345678/);
});

test("renders backend-driven configuration details", () => {
  const fields = configFields(gitConfig);
  const view = render(<ConfigView
    draft={gitConfig}
    fields={fields}
    fieldIndex={0}
    editing={null}
    hostInfo={{ internetAvailable: true, currentBranch: "main", localBranches: ["main", "feature"] }}
    error={null}
  />);
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /Configuration · git/);
  assert.match(frame, /PrairieLearn path: \/PrairieLearn/);
  assert.match(frame, /Available branches: main, feature/);
});

test("offers repository branches while editing the branch field", () => {
  const fields = configFields(gitConfig);
  const view = render(<ConfigView
    draft={{ ...gitConfig, branch: null }}
    fields={fields}
    fieldIndex={1}
    editing={{ key: "branch", value: "feat", suggestionIndex: 0 }}
    hostInfo={{
      currentBranch: "main",
      localBranches: ["main", "feature/local"],
      remoteBranches: ["feature/remote"],
    }}
    error={null}
  />);
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /feature\/local · local/);
  assert.match(frame, /feature\/remote · origin/);
  assert.match(frame, /Use “feat” as branch\/ref · custom/);
});

test("filters and classifies branch autocomplete suggestions", () => {
  const hostInfo = {
    currentBranch: "main",
    localBranches: ["main", "feature/local", "shared"],
    remoteBranches: ["shared", "release"],
  };

  assert.deepEqual(branchSuggestions(hostInfo, "rel"), [
    { label: "release", value: "release", hint: "origin" },
    { label: "Use “rel” as branch/ref", value: "rel", hint: "custom" },
  ]);
  assert.deepEqual(branchSuggestions(hostInfo, "origin/release"), [
    { label: "release", value: "release", hint: "origin" },
  ]);
  assert.deepEqual(branchSuggestions(hostInfo, "main"), [
    { label: "Current branch (main)", value: "", hint: "current" },
    { label: "Use “main” as branch/ref", value: "main", hint: "custom" },
  ]);
  assert.deepEqual(branchSuggestions(hostInfo, "topic/new"), [
    { label: "Use “topic/new” as branch/ref", value: "topic/new", hint: "custom" },
  ]);
});

test("filters and scrolls the merged log model", () => {
  const events: RunEvent[] = [
    event(1, "system"),
    event(2, "stdout"),
    event(3, "stderr"),
    event(4, "stdout"),
  ];
  assert.deepEqual(visibleLogEvents(events, "stdout", 0, 10).map((item) => item.seq), [1, 2, 4]);
  assert.deepEqual(visibleLogEvents(events, "all", 1, 2).map((item) => item.seq), [2, 3]);
});

test("indents wrapped log output past the event prefix", () => {
  const longEvent: RunEvent = {
    ...event(304, "stdout"),
    message: "$ tsx watch --clear-screen=false --tsconfig src/tsconfig.json --include **/*.sql",
  };
  const output = renderToString(<Box width={50}><LogLine event={longEvent} /></Box>, { columns: 50 });
  const lines = output.split("\n");

  assert.ok(lines.length > 1);
  assert.equal(lines[0]?.slice(0, 18), " 304 server       ");
  for (const line of lines.slice(1)) assert.match(line, /^ {18}/);
});

function event(seq: number, source: RunEvent["source"]): RunEvent {
  return { seq, source, timestamp: "2026-01-01T00:00:00.000Z", phase: "server", message: String(seq) };
}
