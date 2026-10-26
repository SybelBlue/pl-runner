import assert from "node:assert/strict";
import test from "node:test";
import { formatRelativeTime, stripOsc11 } from "../src/system/format.ts";
import { branchSlug } from "../src/worker/worktree.ts";

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

test("slugifies branch refs for temp worktrees", () => {
  assert.equal(branchSlug("Feature/ABC@123"), "feature-abc-123");
});
