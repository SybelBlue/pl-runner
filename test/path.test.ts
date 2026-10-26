import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  completeDirectoryPath,
  displayHomeRelativePath,
} from "../src/system/path.ts";

test("displays paths below the home directory without the home prefix", () => {
  assert.equal(
    displayHomeRelativePath(
      "/Users/example/Documents/PrairieLearn",
      "/Users/example",
    ),
    "Documents/PrairieLearn",
  );
  assert.equal(
    displayHomeRelativePath("/opt/PrairieLearn", "/Users/example"),
    "/opt/PrairieLearn",
  );
});

test("completes directories while preserving the input path style", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pl-path-test-"));
  try {
    await Promise.all([
      fs.mkdir(path.join(directory, "Documents")),
      fs.mkdir(path.join(directory, "Downloads")),
      fs.mkdir(path.join(directory, ".hidden")),
      fs.writeFile(path.join(directory, "Dockerfile"), ""),
    ]);

    assert.deepEqual(await completeDirectoryPath("Do", directory), [
      { label: "Documents", value: "Documents", hint: "directory" },
      { label: "Downloads", value: "Downloads", hint: "directory" },
    ]);
    assert.deepEqual(await completeDirectoryPath("~/Do", "/", directory), [
      { label: "Documents", value: "~/Documents", hint: "directory" },
      { label: "Downloads", value: "~/Downloads", hint: "directory" },
    ]);
    assert.equal(
      (await completeDirectoryPath("~", "/", directory))[0]?.value,
      "~/Documents",
    );
    assert.deepEqual(await completeDirectoryPath(".", directory), [
      { label: ".hidden", value: ".hidden", hint: "directory" },
    ]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
