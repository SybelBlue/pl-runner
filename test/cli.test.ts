import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli.ts";

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
  const parsed = parseArgs(["docker", "--port", "3001:3000", "--tmp-dir", "/tmp", "-l", "-q", "course"]);
  assert.equal(parsed.command, "docker");
  assert.deepEqual(parsed.docker, {
    port: "3001:3000",
    tmp_dir: "/tmp",
    local_only: true,
    quiet: true,
    course_path: "course",
  });
});
