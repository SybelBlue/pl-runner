import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { main, parseArgs } from "../src/cli.ts";

test("parses run options and quiet aliases", () => {
  const parsed = parseArgs(["--quiet", "run", "--branch", "main", "-f", "-l", "-p", "/pl", "-w"]);
  assert.equal(parsed.command, "run");
  assert.equal(parsed.options.quiet, true);
  assert.equal(parsed.options.branch, "main");
  assert.equal(parsed.options.force_rebuild, true);
  assert.equal(parsed.options.local_only, true);
  assert.equal(parsed.options.path, "/pl");
  assert.equal(parsed.options.no_watch_upstream, true);
});

test("parses docker options and positional course path", () => {
  const parsed = parseArgs(["docker", "--image", "latest", "--port", "3001:3000", "--tmp-dir", "/tmp", "-l", "-q", "course"]);
  assert.equal(parsed.command, "docker");
  assert.deepEqual(parsed.docker, {
    image: "latest",
    port: "3001:3000",
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

test("parses help and version flags after a command", () => {
  assert.equal(parseArgs(["run", "--help"]).help, true);
  assert.equal(parseArgs(["docker", "--version"]).version, true);
});

test("help command prints usage", async () => {
  const output = await captureConsoleLog(() => main(["help"]));
  assert.match(output, /^Usage: pl /);
  assert.match(output, /^  version   Show the installed version$/m);
});

test("version command prints the package version", async () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  const output = await captureConsoleLog(() => main(["version"]));
  assert.equal(output, packageJson.version);
});

async function captureConsoleLog(action: () => Promise<number>): Promise<string> {
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
