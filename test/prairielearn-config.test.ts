import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureIsolatedDatabase,
  writeEffectivePrairieLearnConfig,
} from "../src/prairielearn-config.ts";
import type { Logger } from "../src/types.ts";

const logger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};

test("writes a private effective config with the selected port", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pl-effective-config-test-"));
  const source = path.join(directory, "source.json");
  await fs.writeFile(source, JSON.stringify({
    serverPort: "9999",
    nested: { preserved: true },
    list: ["preserved"],
  }));
  try {
    const result = await writeEffectivePrairieLearnConfig({
      launchPath: directory,
      runDir: directory,
      instanceId: "instance-a",
      port: 3012,
      isolatedDatabase: false,
      env: { PL_CONFIG_PATH: source },
    });
    const config = JSON.parse(await fs.readFile(result.path, "utf8")) as Record<string, unknown>;
    assert.equal(config.serverPort, "3012");
    assert.deepEqual(config.nested, { preserved: true });
    assert.deepEqual(config.list, ["preserved"]);
    assert.equal(result.databaseName, null);
    assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("overlays a stable database name only when isolation is enabled", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pl-isolated-config-test-"));
  const source = path.join(directory, "source.json");
  await fs.writeFile(source, JSON.stringify({ postgresqlDatabase: "postgres" }));
  try {
    const result = await writeEffectivePrairieLearnConfig({
      launchPath: directory,
      runDir: directory,
      instanceId: "ABC-123",
      port: 3004,
      isolatedDatabase: true,
      env: { PL_CONFIG_PATH: source },
    });
    const config = JSON.parse(await fs.readFile(result.path, "utf8")) as Record<string, unknown>;
    assert.equal(result.databaseName, "prairielearn_pl_runner_abc_123");
    assert.equal(config.postgresqlDatabase, result.databaseName);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("creates a missing isolated database and reports missing PostgreSQL tools", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pl-isolated-db-test-"));
  const marker = path.join(directory, "created");
  await fs.writeFile(path.join(directory, "psql"), "#!/bin/sh\nexit 0\n");
  await fs.writeFile(path.join(directory, "createdb"), `#!/bin/sh\nprintf x > ${JSON.stringify(marker)}\n`);
  await Promise.all([
    fs.chmod(path.join(directory, "psql"), 0o755),
    fs.chmod(path.join(directory, "createdb"), 0o755),
  ]);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = directory;
    await ensureIsolatedDatabase("prairielearn_pl_runner_test", logger);
    assert.equal((await fs.stat(marker)).isFile(), true);

    process.env.PATH = "";
    await assert.rejects(
      ensureIsolatedDatabase("prairielearn_pl_runner_missing", logger),
      /requires the psql command/,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
