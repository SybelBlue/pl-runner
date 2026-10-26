import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { main, parseArgs } from "../src/cli/cli.ts";

test("parses run options, selectors, ports, and quiet aliases", () => {
  const parsed = parseArgs([
    "--quiet",
    "run",
    "--instance",
    "alpha",
    "--branch",
    "main",
    "--port",
    "3001",
    "--isolated-database",
    "-f",
    "-l",
    "-p",
    "/pl",
    "-w",
    "--detach",
    "--json",
    "--allow-pull-failure",
  ]);
  assert.equal(parsed.command, "run");
  assert.equal(parsed.options.quiet, true);
  assert.equal(parsed.options.branch, "main");
  assert.equal(parsed.options.force_rebuild, true);
  assert.equal(parsed.options.local_only, true);
  assert.equal(parsed.options.path, "/pl");
  assert.equal(parsed.options.port, 3001);
  assert.equal(parsed.options.isolated_database, true);
  assert.equal(parsed.instance, "alpha");
  assert.equal(parsed.options.no_watch_upstream, true);
  assert.equal(parsed.detach, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.allowPullFailure, true);
});

test("parses docker options and positional course path", () => {
  const parsed = parseArgs([
    "docker",
    "--image",
    "latest",
    "--port",
    "3001",
    "--tmp-dir",
    "/tmp",
    "-l",
    "-q",
    "course",
  ]);
  assert.equal(parsed.command, "docker");
  assert.deepEqual(parsed.docker, {
    image: "latest",
    port: 3001,
    tmp_dir: "/tmp",
    local_only: true,
    quiet: true,
    course_path: "course",
  });
});

test("parses help and version commands", () => {
  assert.equal(parseArgs(["help"]).command, "help");
  assert.equal(parseArgs(["version"]).command, "version");
});

test("parses lifecycle, log, and backend commands", () => {
  assert.equal(parseArgs(["start", "--detach"]).command, "start");
  assert.equal(parseArgs(["stop", "--json"]).json, true);
  assert.deepEqual(
    (({ command, follow, tail, stream }) => ({
      command,
      follow,
      tail,
      stream,
    }))(parseArgs(["logs", "--follow", "--tail", "50", "--stream", "stderr"])),
    { command: "logs", follow: true, tail: 50, stream: "stderr" },
  );
  assert.equal(parseArgs(["backend", "stop"]).backendAction, "stop");
});

test("parses help and version flags after a command", () => {
  assert.equal(parseArgs(["run", "--help"]).help, true);
  assert.equal(parseArgs(["docker", "--version"]).version, true);
});

test("help command prints usage", async () => {
  const output = await captureConsoleLog(() => main(["help"]));
  assert.match(output, /^Usage: pl /);
  assert.match(output, /^  version\s+Show the installed version$/m);
});

test("version command prints the package version", async () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    version: string;
  };
  const output = await captureConsoleLog(() => main(["version"]));
  assert.equal(output, packageJson.version);
});

async function captureConsoleLog(
  action: () => Promise<number>,
): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    assert.equal(await action(), 0);
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}
