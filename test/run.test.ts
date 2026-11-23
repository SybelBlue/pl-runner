import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { applyOfflineDefaults, launchRun } from "../src/worker/run.ts";
import type { GitConfig, Logger } from "../src/core/types.ts";

const execFile = promisify(execFileCallback);

const logger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};

test("offline defaults disable network-dependent Git behavior", () => {
  const config: GitConfig = {
    mode: "git",
    path: "/pl",
    branch: null,
    port: 3000,
    isolated_database: false,
    force_rebuild: true,
    local_only: false,
    no_watch_upstream: false,
    internet_available: false,
    quiet: true,
  };
  applyOfflineDefaults(config, logger);
  assert.equal(config.local_only, true);
  assert.equal(config.no_watch_upstream, true);
  assert.equal(config.force_rebuild, false);
});

test("git pull failure is typed and requires an explicit override", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pl-run-test-"));
  const bin = path.join(directory, "bin");
  const project = path.join(directory, "project");
  await Promise.all([fs.mkdir(bin), fs.mkdir(project)]);
  await fs.writeFile(path.join(project, "Makefile"), "dev:\n\t@true\n");
  await fs.writeFile(
    path.join(bin, "git"),
    `#!/bin/sh
if [ "$1" = "rev-parse" ]; then echo true; exit 0; fi
if [ "$1" = "remote" ]; then echo 'origin https://github.com/PrairieLearn/PrairieLearn.git'; exit 0; fi
if [ "$1" = "pull" ]; then echo 'pull failed' >&2; exit 42; fi
exit 0
`,
  );
  await fs.writeFile(
    path.join(bin, "make"),
    "#!/bin/sh\necho server-ready\nexit 0\n",
  );
  await writeHealthyRedisCli(bin);
  await Promise.all([
    fs.chmod(path.join(bin, "git"), 0o755),
    fs.chmod(path.join(bin, "make"), 0o755),
  ]);

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const config: GitConfig = {
    mode: "git",
    path: project,
    branch: null,
    port: 3000,
    isolated_database: false,
    force_rebuild: false,
    local_only: false,
    no_watch_upstream: true,
    internet_available: true,
    quiet: true,
  };
  try {
    let failure: string | null = null;
    assert.equal(
      await launchRun(config, logger, false, {
        onFailure: (code) => {
          failure = code;
        },
      }),
      42,
    );
    assert.equal(failure, "PULL_FAILED");
    assert.equal(
      await launchRun(config, logger, false, { allowPullFailure: true }),
      0,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("managed Git runs launch with a generated port override", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "pl-run-port-test-"),
  );
  const bin = path.join(directory, "bin");
  const project = path.join(directory, "project");
  const runDir = path.join(directory, "run");
  const marker = path.join(directory, "config-path");
  await Promise.all([fs.mkdir(bin), fs.mkdir(project), fs.mkdir(runDir)]);
  await fs.writeFile(path.join(project, "Makefile"), "dev:\n\t@true\n");
  await fs.writeFile(
    path.join(project, "config.json"),
    JSON.stringify({ authName: "Local User" }),
  );
  await fs.writeFile(
    path.join(bin, "git"),
    `#!/bin/sh
if [ "$1" = "rev-parse" ]; then echo true; exit 0; fi
if [ "$1" = "remote" ]; then echo 'origin https://github.com/PrairieLearn/PrairieLearn.git'; exit 0; fi
exit 0
`,
  );
  await fs.writeFile(
    path.join(bin, "make"),
    `#!/bin/sh
printf '%s' "$PL_CONFIG_PATH" > ${JSON.stringify(marker)}
exit 0
`,
  );
  await writeHealthyRedisCli(bin);
  await Promise.all([
    fs.chmod(path.join(bin, "git"), 0o755),
    fs.chmod(path.join(bin, "make"), 0o755),
  ]);

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const config: GitConfig = {
    mode: "git",
    path: project,
    branch: null,
    port: 3111,
    isolated_database: false,
    force_rebuild: false,
    local_only: true,
    no_watch_upstream: true,
    internet_available: true,
    quiet: true,
  };
  try {
    assert.equal(
      await launchRun(
        config,
        logger,
        false,
        {},
        {
          instanceId: "instance-a",
          runDir,
          env: process.env,
        },
      ),
      0,
    );
    const configPath = await fs.readFile(marker, "utf8");
    const effective = JSON.parse(
      await fs.readFile(configPath, "utf8"),
    ) as Record<string, unknown>;
    assert.equal(effective.serverPort, "3111");
    assert.equal(effective.authName, "Local User");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("support service failures are typed and prevent launch", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "pl-run-support-test-"),
  );
  const bin = path.join(directory, "bin");
  const project = path.join(directory, "project");
  const calls = path.join(directory, "make-calls");
  await Promise.all([fs.mkdir(bin), fs.mkdir(project)]);
  await fs.writeFile(path.join(project, "Makefile"), "dev:\n\t@true\n");
  await writeGitStub(bin);
  await fs.writeFile(
    path.join(bin, "make"),
    `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(calls)}
case "$*" in
  *start-postgres*) exit 23 ;;
esac
exit 0
`,
  );
  await Promise.all([
    fs.chmod(path.join(bin, "git"), 0o755),
    fs.chmod(path.join(bin, "make"), 0o755),
  ]);

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    let failure: string | null = null;
    assert.equal(
      await launchRun(baseConfig(project), logger, false, {
        onFailure: (code) => {
          failure = code;
        },
      }),
      23,
    );
    assert.equal(failure, "SUPPORT_SERVICE_PREPARATION_FAILED");
    assert.equal(
      await fs.readFile(calls, "utf8"),
      `-C ${project} start-postgres start-redis\n`,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an unhealthy local Redis prevents launch", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "pl-run-redis-test-"),
  );
  const bin = path.join(directory, "bin");
  const project = path.join(directory, "project");
  const calls = path.join(directory, "make-calls");
  await Promise.all([fs.mkdir(bin), fs.mkdir(project)]);
  await fs.writeFile(path.join(project, "Makefile"), "dev:\n\t@true\n");
  await writeGitStub(bin);
  await fs.writeFile(
    path.join(bin, "make"),
    `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(calls)}
exit 0
`,
  );
  await fs.writeFile(
    path.join(bin, "redis-cli"),
    `#!/bin/sh
if [ "$1" = "INFO" ]; then
  printf 'rdb_last_bgsave_status:err\r\n'
  exit 0
fi
exit 1
`,
  );
  await Promise.all([
    fs.chmod(path.join(bin, "git"), 0o755),
    fs.chmod(path.join(bin, "make"), 0o755),
    fs.chmod(path.join(bin, "redis-cli"), 0o755),
  ]);

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    let failure: string | null = null;
    assert.equal(
      await launchRun(baseConfig(project), logger, false, {
        onFailure: (code) => {
          failure = code;
        },
      }),
      1,
    );
    assert.equal(failure, "SUPPORT_SERVICE_UNHEALTHY");
    assert.equal(
      await fs.readFile(calls, "utf8"),
      `-C ${project} start-postgres start-redis\n`,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("branch worktrees use stable s3rver storage", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "pl-run-s3rver-test-"),
  );
  const bin = path.join(directory, "bin");
  const project = path.join(directory, "project");
  const marker = path.join(directory, "s3rver-link");
  const supportMarker = path.join(directory, "support-path");
  await Promise.all([fs.mkdir(bin), fs.mkdir(project)]);
  await fs.writeFile(path.join(project, "Makefile"), "dev:\n\t@true\n");
  await execFile("git", ["init", "-b", "main"], { cwd: project });
  await execFile("git", ["add", "Makefile"], { cwd: project });
  await execFile(
    "git",
    [
      "-c",
      "user.name=PrairieLearn Runner Test",
      "-c",
      "user.email=runner@example.com",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: project },
  );
  await execFile("git", ["branch", "feature"], { cwd: project });
  await fs.writeFile(
    path.join(bin, "make"),
    `#!/bin/sh
if [ "$1" = "-C" ] && [ "$3" = "start-postgres" ]; then
  printf '%s\n' "$2" > ${JSON.stringify(supportMarker)}
fi
if [ "$1" = "-C" ] && [ "$3" = "dev" ]; then
  printf '%s\n%s\n' "$2" "$(readlink "$2/s3rver")" > ${JSON.stringify(marker)}
fi
exit 0
`,
  );
  await writeHealthyRedisCli(bin);
  await fs.chmod(path.join(bin, "make"), 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    assert.equal(
      await launchRun(
        {
          ...baseConfig(project),
          branch: "feature",
          internet_available: false,
        },
        logger,
      ),
      0,
    );
    assert.equal((await fs.readFile(supportMarker, "utf8")).trim(), project);
    const [launchPath, stableTarget] = (await fs.readFile(marker, "utf8"))
      .trim()
      .split("\n");
    assert.notEqual(launchPath, project);
    assert.equal(stableTarget, path.join(project, "s3rver"));
    assert.equal((await fs.stat(stableTarget)).isDirectory(), true);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function baseConfig(project: string): GitConfig {
  return {
    mode: "git",
    path: project,
    branch: null,
    port: 3000,
    isolated_database: false,
    force_rebuild: false,
    local_only: true,
    no_watch_upstream: true,
    internet_available: true,
    quiet: true,
  };
}

async function writeGitStub(bin: string): Promise<void> {
  const git = path.join(bin, "git");
  await fs.writeFile(
    git,
    `#!/bin/sh
if [ "$1" = "rev-parse" ]; then echo true; exit 0; fi
if [ "$1" = "remote" ]; then echo 'origin https://github.com/PrairieLearn/PrairieLearn.git'; exit 0; fi
exit 0
`,
  );
  await fs.chmod(git, 0o755);
}

async function writeHealthyRedisCli(bin: string): Promise<void> {
  const redisCli = path.join(bin, "redis-cli");
  await fs.writeFile(
    redisCli,
    `#!/bin/sh
case "$1" in
  INFO) printf 'rdb_last_bgsave_status:ok\r\n' ;;
  SET) echo OK ;;
  DEL) echo 1 ;;
  *) exit 1 ;;
esac
`,
  );
  await fs.chmod(redisCli, 0o755);
}
