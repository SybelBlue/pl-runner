import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./process.js";
import { expandHome } from "./path.js";
import type { Logger } from "./types.js";

export type EffectiveConfig = {
  path: string;
  databaseName: string | null;
};

export async function writeEffectivePrairieLearnConfig(options: {
  launchPath: string;
  runDir: string;
  instanceId: string;
  port: number;
  isolatedDatabase: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<EffectiveConfig> {
  const env = options.env ?? process.env;
  const sourcePaths = env.PL_CONFIG_PATH
    ? [resolveConfigPath(env.PL_CONFIG_PATH, options.launchPath)]
    : [
        path.join(os.homedir(), ".config", "prairielearn", "config.json"),
        path.join(options.launchPath, "config.json"),
        path.join(options.launchPath, "apps", "prairielearn", "config.json"),
      ];
  let config: Record<string, unknown> = {};
  for (const sourcePath of sourcePaths) {
    const source = await readConfigObject(sourcePath, Boolean(env.PL_CONFIG_PATH));
    if (source) config = deepMerge(config, source);
  }

  const databaseName = options.isolatedDatabase ? isolatedDatabaseName(options.instanceId) : null;
  config.serverPort = String(options.port);
  if (databaseName) config.postgresqlDatabase = databaseName;

  const configPath = path.join(options.runDir, "prairielearn-config.json");
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { path: configPath, databaseName };
}

export async function ensureIsolatedDatabase(databaseName: string, logger: Logger): Promise<void> {
  const query = `SELECT 1 FROM pg_database WHERE datname = '${databaseName.replaceAll("'", "''")}'`;
  const check = await runCommand("psql", ["-U", "postgres", "-d", "postgres", "-Atqc", query]);
  if (check.status === 127) throw new Error("isolated database requires the psql command");
  if (check.status !== 0) throw new Error(check.stderr.trim() || "could not inspect PostgreSQL databases");
  if (check.stdout.trim() === "1") return;

  logger.info(`creating isolated PostgreSQL database ${databaseName}...`);
  const create = await runCommand("createdb", ["-U", "postgres", databaseName]);
  if (create.status === 0) return;
  if (create.status === 127) throw new Error("isolated database requires the createdb command");

  // A concurrent creator may have won the race. Verify before reporting failure.
  const recheck = await runCommand("psql", ["-U", "postgres", "-d", "postgres", "-Atqc", query]);
  if (recheck.status === 0 && recheck.stdout.trim() === "1") return;
  throw new Error(create.stderr.trim() || `could not create PostgreSQL database ${databaseName}`);
}

function isolatedDatabaseName(instanceId: string): string {
  const suffix = instanceId.toLowerCase().replaceAll(/[^a-z0-9_]/g, "_").slice(0, 45);
  return `prairielearn_pl_runner_${suffix}`;
}

function resolveConfigPath(input: string, cwd: string): string {
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

async function readConfigObject(file: string, required: boolean): Promise<Record<string, unknown> | null> {
  let contents: string;
  try {
    contents = await fs.readFile(file, "utf8");
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`PrairieLearn config must contain an object: ${file}`);
  }
  return parsed as Record<string, unknown>;
}

function deepMerge(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
