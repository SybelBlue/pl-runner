import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import React from "react";
import { Box, renderToString } from "ink";
import { render } from "ink-testing-library";
import {
  branchSuggestions,
  ConfigView,
  DashboardMenu,
  LogLine,
  ProfileHeader,
  StatusLine,
  canRestart,
  configFields,
  formatConfig,
  logColor,
  relativeInstanceId,
  titlebarSequence,
  visibleLogEvents,
} from "../src/cli/tui.tsx";
import type { LaunchConfig, RunEvent, SupervisorStatus } from "../src/core/types.ts";

const gitConfig: Extract<LaunchConfig, { mode: "git" }> = {
  mode: "git",
  path: "/PrairieLearn",
  branch: "main",
  port: 3000,
  isolated_database: false,
  force_rebuild: false,
  local_only: true,
  no_watch_upstream: false,
  quiet: false,
};

const dockerConfig: Extract<LaunchConfig, { mode: "docker" }> = {
  mode: "docker",
  course_path: "/course",
  image: "us-prod-live",
  port: 3001,
  tmp_dir: "/tmp",
  local_only: false,
  quiet: false,
};

test("renders the dashboard status summary", () => {
  const status: SupervisorStatus = {
    backend: { running: true, pid: 123, protocolVersion: 2, packageVersion: "0.2.0" },
    instances: [{
      id: "instance-a",
      name: "alpha",
      config: gitConfig,
      run: {
        instanceId: "instance-a",
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
    }],
  };
  const view = render(<StatusLine status={status} selectedId="instance-a" />);
  assert.match(view.lastFrame() ?? "", /Instance: running · run 12345678/);
  const header = render(<ProfileHeader instances={status.instances} selectedId="instance-a" />);
  assert.match(header.lastFrame() ?? "", /1\/1 · alpha · localhost:3000 · running/);
});

test("renders the selected profile position and port", () => {
  const instances = [
    { id: "one", name: "main", config: gitConfig, run: null },
    { id: "two", name: "feature", config: { ...gitConfig, port: 3002 }, run: null },
  ];
  const view = render(<ProfileHeader instances={instances} selectedId="two" />);
  assert.match(view.lastFrame() ?? "", /2\/2 · feature · localhost:3002 · stopped/);
  assert.equal(relativeInstanceId(instances, "one", -1), "two");
  assert.equal(relativeInstanceId(instances, "two", 1), "one");
});

test("only enables restart while the instance is running", () => {
  assert.equal(canRestart("running"), true);
  for (const state of [undefined, "stopped", "failed", "preparing", "starting", "stopping"] as const) {
    assert.equal(canRestart(state), false);
  }
});

test("exposes profile ports and optional Git database isolation", () => {
  assert.deepEqual(configFields(gitConfig).slice(2, 4).map((field) => field.key), ["port", "isolated_database"]);
  assert.equal(configFields(dockerConfig).some((field) => field.key === "port"), true);
});

test("shows only dashboard actions valid for the lifecycle state", () => {
  const view = render(<DashboardMenu state={undefined} />);
  assert.match(view.lastFrame() ?? "", /s start/);
  assert.match(view.lastFrame() ?? "", /c configure/);
  assert.doesNotMatch(view.lastFrame() ?? "", /x stop|r restart|End follow/);

  view.rerender(<DashboardMenu state="running" />);
  assert.match(view.lastFrame() ?? "", /x stop/);
  assert.match(view.lastFrame() ?? "", /c view config/);
  assert.match(view.lastFrame() ?? "", /r restart/);
  assert.doesNotMatch(view.lastFrame() ?? "", /Del delete/);
  assert.doesNotMatch(view.lastFrame() ?? "", /s start|c configure/);

  view.rerender(<DashboardMenu state="starting" />);
  assert.match(view.lastFrame() ?? "", /x stop/);
  assert.match(view.lastFrame() ?? "", /c view config/);
  assert.doesNotMatch(view.lastFrame() ?? "", /s start|r restart|c configure/);
});

test("removes the user-home prefix from titlebar configuration summaries", () => {
  const home = os.homedir();
  assert.equal(formatConfig({ ...gitConfig, path: `${home}/Documents/PrairieLearn` }), "git Documents/PrairieLearn @ main (:3000)");
  assert.equal(
    titlebarSequence("/Users/example/Documents/PrairieLearn", "/Users/example"),
    "\u001B]0;Documents/PrairieLearn\u0007",
  );
});

test("hides configuration diagnostics until their field is highlighted", () => {
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
  assert.match(frame, /s switch to docker/);
  assert.match(frame, /c confirm/);
  assert.match(frame, /q\/Esc cancel/);
  assert.match(frame, /PrairieLearn path: \/PrairieLearn/);
  assert.doesNotMatch(frame, /Network:/);
  assert.doesNotMatch(frame, /Dependencies:/);
  assert.doesNotMatch(frame, /Current branch:/);
  assert.doesNotMatch(frame, /Available branches:/);
});

test("shows only the diagnostic relevant to the highlighted configuration field", () => {
  const fields = configFields(gitConfig);
  const hostInfo = {
    internetAvailable: true,
    dependencies: { git: true, docker: true, pnpm: true, uv: true },
    currentBranch: "main",
    localBranches: ["main", "feature"],
  };
  const view = render(<ConfigView
    draft={gitConfig}
    fields={fields}
    fieldIndex={1}
    editing={null}
    hostInfo={hostInfo}
    error={null}
  />);

  assert.match(view.lastFrame() ?? "", /Current branch: main/);
  assert.match(view.lastFrame() ?? "", /Available branches: main, feature/);
  assert.doesNotMatch(view.lastFrame() ?? "", /Network:|Dependencies:/);

  view.rerender(<ConfigView
    draft={gitConfig}
    fields={fields}
    fieldIndex={4}
    editing={null}
    hostInfo={hostInfo}
    error={null}
  />);
  assert.match(view.lastFrame() ?? "", /Dependencies: git:ok docker:ok pnpm:ok uv:ok/);
  assert.doesNotMatch(view.lastFrame() ?? "", /Network:|Current branch:|Available branches:/);

  view.rerender(<ConfigView
    draft={gitConfig}
    fields={fields}
    fieldIndex={5}
    editing={null}
    hostInfo={hostInfo}
    error={null}
  />);
  assert.match(view.lastFrame() ?? "", /Network: online/);
  assert.doesNotMatch(view.lastFrame() ?? "", /Dependencies:|Current branch:|Available branches:/);
});

test("shows Docker image details only while the image field is highlighted", () => {
  const fields = configFields(dockerConfig);
  const hostInfo = {
    internetAvailable: true,
    dockerImages: [{ tag: "us-prod-live", updatedAt: "2026-10-26T12:00:00.000Z" }],
  };
  const view = render(<ConfigView
    draft={dockerConfig}
    fields={fields}
    fieldIndex={0}
    editing={null}
    hostInfo={hostInfo}
    error={null}
  />);
  assert.doesNotMatch(view.lastFrame() ?? "", /Images:/);

  view.rerender(<ConfigView
    draft={dockerConfig}
    fields={fields}
    fieldIndex={1}
    editing={null}
    hostInfo={hostInfo}
    error={null}
  />);
  assert.match(view.lastFrame() ?? "", /Images: us-prod-live \(2026-10-26\)/);
});

test("configuration mode control names git as the target from Docker mode", () => {
  const view = render(<ConfigView
    draft={dockerConfig}
    fields={configFields(dockerConfig)}
    fieldIndex={0}
    editing={null}
    hostInfo={null}
    error={null}
  />);

  assert.match(view.lastFrame() ?? "", /s switch to git/);
});

test("shows active-run configuration as view-only", () => {
  const view = render(<ConfigView
    draft={gitConfig}
    fields={configFields(gitConfig)}
    fieldIndex={0}
    editing={null}
    hostInfo={null}
    error={null}
    readOnly
  />);
  const frame = view.lastFrame() ?? "";

  assert.match(frame, /Stop current run to modify config/);
  assert.match(frame, /↑\/↓ select · any other key back/);
  assert.match(frame, /PrairieLearn path: \/PrairieLearn/);
  assert.doesNotMatch(frame, /switch to docker|edit\/toggle|c confirm/);
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

test("offers directory autocomplete while editing path fields", () => {
  const view = render(<ConfigView
    draft={gitConfig}
    fields={configFields(gitConfig)}
    fieldIndex={0}
    editing={{ key: "path", value: "/Users/example/Doc", suggestionIndex: 0 }}
    hostInfo={null}
    directorySuggestions={[
      { label: "Documents", value: "/Users/example/Documents", hint: "directory" },
      { label: "Docker", value: "/Users/example/Docker", hint: "directory" },
    ]}
    error={null}
  />);
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /Tab complete/);
  assert.match(frame, /Documents · directory/);
  assert.match(frame, /Docker · directory/);
});

test("shows directory autocomplete progress and empty results", () => {
  const props = {
    draft: gitConfig,
    fields: configFields(gitConfig),
    fieldIndex: 0,
    editing: { key: "path", value: "/Users/example/Doc", suggestionIndex: 0 },
    hostInfo: null,
    error: null,
  };
  const view = render(<ConfigView {...props} directorySuggestionsLoading />);
  assert.match(view.lastFrame() ?? "", /Loading directories…/);

  view.rerender(<ConfigView {...props} directorySuggestions={[]} />);
  assert.match(view.lastFrame() ?? "", /No matching directories/);
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

test("scrolls the complete merged log model without filtering", () => {
  const events: RunEvent[] = [
    event(1, "system"),
    event(2, "stdout"),
    event(3, "stderr"),
    event(4, "stdout"),
  ];
  assert.deepEqual(visibleLogEvents(events, 0, 10).map((item) => item.seq), [1, 2, 3, 4]);
  assert.deepEqual(visibleLogEvents(events, 1, 2).map((item) => item.seq), [2, 3]);
});

test("keeps normal output neutral and accents status, warnings, and errors", () => {
  assert.equal(logColor({ ...event(1, "system"), message: "starting git run" }), "cyan");
  assert.equal(logColor({ ...event(2, "stdout"), message: "server ready" }), "green");
  assert.equal(logColor({ ...event(3, "system"), message: "warning: using offline defaults" }), "yellow");
  assert.equal(logColor({ ...event(4, "stderr"), message: "command failed" }), "red");
  assert.equal(logColor({ ...event(5, "system"), phase: "failed", message: "managed instance exited with 130" }), "red");
  assert.equal(logColor({ ...event(6, "stdout"), message: "Compiling application modules" }), undefined);
  assert.equal(logColor({ ...event(7, "stderr"), message: "A tool wrote an ordinary diagnostic" }), undefined);
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

test("does not overlap mixed log events when a message wraps", () => {
  const events: RunEvent[] = [
    { ...event(544, "stdout"), message: "Exit status 130" },
    { ...event(545, "stdout"), message: "A long command with enough content that it wraps onto another terminal line" },
    { ...event(546, "stderr"), message: "make: *** [dev] Error 130" },
    { ...event(547, "system"), message: "make dev exited with 130" },
  ];
  const output = renderToString(
    <Box width={70} height={4} flexDirection="column" overflow="hidden" contentOffsetY={1}>
      <Box flexDirection="column" flexShrink={0}>
        {events.map((item) => <LogLine key={item.seq} event={item} />)}
      </Box>
    </Box>,
    { columns: 70 },
  );

  assert.match(output, /^ 546 server {7}make: \*\*\* \[dev\] Error 130$/m);
  assert.match(output, /^ 547 server {7}make dev exited with 130$/m);
  assert.doesNotMatch(output, /Error 130\S/);
});

function event(seq: number, source: RunEvent["source"]): RunEvent {
  return { seq, source, timestamp: "2026-01-01T00:00:00.000Z", phase: "server", message: String(seq) };
}
