import assert from "node:assert/strict";
import test from "node:test";
import { formatRelativeTime, stripOsc11 } from "../src/format.ts";
import { previewDockerCommand, previewRunCommand } from "../src/preview.ts";
import { branchSlug } from "../src/worktree.ts";

test("strips OSC 11 sequences", () => {
  assert.equal(stripOsc11("a\x1b]11;rgb:0000/0000/0000\x07b"), "ab");
  assert.equal(stripOsc11("a\x1b]11;#ffffff\x1b\\b"), "ab");
});

test("formats relative time thresholds", () => {
  assert.equal(formatRelativeTime(44), "just now");
  assert.equal(formatRelativeTime(60), "1 minute ago");
  assert.equal(formatRelativeTime(3600), "1 hour ago");
  assert.equal(formatRelativeTime(8 * 24 * 60 * 60), "1 week ago");
});

test("generates stable command previews", () => {
  assert.equal(
    previewRunCommand({
      path: "/pl path",
      branch: "feature/a",
      force_rebuild: true,
      local_only: false,
      no_watch_upstream: true,
      quiet: true,
    }),
    "pl run --branch feature/a --force-rebuild --path '/pl path' --no-watch-upstream --quiet",
  );
  assert.equal(
    previewDockerCommand({
      course_path: "/course",
      port: "3001:3000",
      tmp_dir: "/tmp",
      local_only: true,
      quiet: false,
    }),
    "pl docker --local-only --port 3001:3000 --tmp-dir /tmp /course",
  );
});

test("omits path preview when PRAIRIELEARN_PATH already provides it", () => {
  const previous = process.env.PRAIRIELEARN_PATH;
  process.env.PRAIRIELEARN_PATH = "/pl path";
  try {
    assert.equal(
      previewRunCommand({
        path: "/pl path",
        branch: null,
        force_rebuild: false,
        local_only: false,
        no_watch_upstream: false,
        quiet: false,
      }),
      "pl run",
    );
  } finally {
    if (previous === undefined) delete process.env.PRAIRIELEARN_PATH;
    else process.env.PRAIRIELEARN_PATH = previous;
  }
});

test("slugifies branch refs for temp worktrees", () => {
  assert.equal(branchSlug("Feature/ABC@123"), "feature-abc-123");
});
