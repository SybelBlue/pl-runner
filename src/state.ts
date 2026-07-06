import fs from "node:fs/promises";
import path from "node:path";
import { normalizeDockerImageTag } from "./docker.js";
import { expandHome } from "./path.js";
import type { DockerConfig, GitConfig, Logger, SavedConfig } from "./types.js";

export function stateFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PRAIRIELEARN_PREVIOUS_CONFIG_FILE) return expandHome(env.PRAIRIELEARN_PREVIOUS_CONFIG_FILE);
  if (env.XDG_STATE_HOME) {
    return path.join(expandHome(env.XDG_STATE_HOME), "prairielearn", "last-config.yaml");
  }
  return path.join(expandHome("~"), ".local", "state", "prairielearn", "last-config.yaml");
}

export async function loadSavedConfig(file = stateFilePath()): Promise<SavedConfig | null> {
  try {
    const contents = await fs.readFile(file, "utf8");
    return parseConfigYaml(contents);
  } catch {
    return null;
  }
}

export async function saveConfig(config: SavedConfig, logger: Logger, file = stateFilePath()): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, stringifyConfigYaml(config), "utf8");
  } catch (error) {
    logger.warn(`could not save previous config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseConfigYaml(contents: string): SavedConfig | null {
  try {
    const values = new Map<string, string | null>();
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
      if (!match) return null;
      values.set(match[1], parseScalar(match[2]));
    }

    const mode = values.get("mode");
    if (mode === "git") {
      const config: GitConfig = {
        mode: "git",
        path: requireString(values, "path"),
        branch: optionalString(values.get("branch")),
        force_rebuild: requireBoolean(values, "force_rebuild"),
        local_only: requireBoolean(values, "local_only"),
        no_watch_upstream: requireBoolean(values, "no_watch_upstream"),
        internet_available: requireBoolean(values, "internet_available"),
        quiet: requireBoolean(values, "quiet"),
      };
      return config.path ? config : null;
    }
    if (mode === "docker") {
      const config: DockerConfig = {
        mode: "docker",
        course_path: requireString(values, "course_path"),
        image: normalizeDockerImageTag(optionalString(values.get("image")) ?? undefined),
        port: requireString(values, "port"),
        tmp_dir: requireString(values, "tmp_dir"),
        local_only: requireBoolean(values, "local_only"),
        quiet: requireBoolean(values, "quiet"),
      };
      return config.course_path && config.port && config.tmp_dir ? config : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function stringifyConfigYaml(config: SavedConfig): string {
  if (config.mode === "git") {
    return [
      "mode: git",
      `path: ${formatScalar(config.path)}`,
      `branch: ${config.branch === null ? "null" : formatScalar(config.branch)}`,
      `force_rebuild: ${config.force_rebuild}`,
      `local_only: ${config.local_only}`,
      `no_watch_upstream: ${config.no_watch_upstream}`,
      `internet_available: ${config.internet_available}`,
      `quiet: ${config.quiet}`,
      "",
    ].join("\n");
  }
  return [
    "mode: docker",
    `course_path: ${formatScalar(config.course_path)}`,
    `image: ${formatScalar(config.image)}`,
    `port: ${formatScalar(config.port)}`,
    `tmp_dir: ${formatScalar(config.tmp_dir)}`,
    `local_only: ${config.local_only}`,
    `quiet: ${config.quiet}`,
    "",
  ].join("\n");
}

function parseScalar(raw: string): string | null {
  if (raw === "null" || raw === "~") return null;
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replace(/\\"/g, '"');
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

function formatScalar(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function optionalString(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  return value;
}

function requireString(values: Map<string, string | null>, key: string): string {
  const value = values.get(key);
  return typeof value === "string" ? value : "";
}

function requireBoolean(values: Map<string, string | null>, key: string): boolean {
  const value = values.get(key);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`invalid boolean: ${key}`);
}
