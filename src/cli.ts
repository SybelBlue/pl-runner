import { launchDocker, normalizeDockerOptions } from "./docker.js";
import { launchInteractive } from "./interactive.js";
import { createLogger } from "./logger.js";
import { launchRun, normalizeRunConfig } from "./run.js";
import type { RunOptions } from "./types.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  const logger = createLogger(parsed.options.quiet);

  if (parsed.help) {
    printHelp();
    return 0;
  }

  if (parsed.command === "run") {
    const config = await normalizeRunConfig(parsed.options, false, logger);
    return config ? launchRun(config, logger, false) : 1;
  }

  if (parsed.command === "docker") {
    return launchDocker(normalizeDockerOptions(parsed.docker), logger);
  }

  return launchInteractive(parsed.options, logger);
}

type Parsed = {
  command: "run" | "docker" | null;
  options: RunOptions;
  docker: {
    course_path?: string;
    port?: string;
    tmp_dir?: string;
    local_only?: boolean;
    quiet?: boolean;
  };
  help: boolean;
};

export function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = {
    command: null,
    options: {
      branch: null,
      force_rebuild: false,
      local_only: false,
      no_watch_upstream: false,
      quiet: false,
    },
    docker: {},
    help: false,
  };

  const args = [...argv];
  if (args.includes("-h") || args.includes("--help")) parsed.help = true;

  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "run" || arg === "docker") {
      parsed.command = arg;
      break;
    }
    if (arg === "-q" || arg === "--quiet") parsed.options.quiet = true;
  }

  if (parsed.command === "run") {
    while (args.length > 0) {
      const arg = args.shift()!;
      if (arg === "-b" || arg === "--branch") parsed.options.branch = requireValue(arg, args);
      else if (arg === "-f" || arg === "--force-rebuild") parsed.options.force_rebuild = true;
      else if (arg === "-l" || arg === "--local-only") parsed.options.local_only = true;
      else if (arg === "-p" || arg === "--path") parsed.options.path = requireValue(arg, args);
      else if (arg === "-w" || arg === "--no-watch-upstream") parsed.options.no_watch_upstream = true;
      else if (arg === "-q" || arg === "--quiet") parsed.options.quiet = true;
      else throw new Error(`unknown run option: ${arg}`);
    }
  } else if (parsed.command === "docker") {
    parsed.docker.quiet = parsed.options.quiet;
    while (args.length > 0) {
      const arg = args.shift()!;
      if (arg === "-l" || arg === "--local-only") parsed.docker.local_only = true;
      else if (arg === "--port") parsed.docker.port = requireValue(arg, args);
      else if (arg === "--tmp-dir") parsed.docker.tmp_dir = requireValue(arg, args);
      else if (arg === "-q" || arg === "--quiet") parsed.docker.quiet = true;
      else if (!arg.startsWith("-") && parsed.docker.course_path === undefined) parsed.docker.course_path = arg;
      else throw new Error(`unknown docker option: ${arg}`);
    }
  }

  parsed.options.quiet = Boolean(parsed.options.quiet);
  return parsed;
}

function requireValue(option: string, args: string[]): string {
  const value = args.shift();
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function printHelp(): void {
  console.log(`Usage: pl [--quiet] [run|docker] [options]

Commands:
  run       Launch PrairieLearn without opening the interactive launcher
  docker    Launch PrairieLearn from the Docker image

Run options:
  -b, --branch <branch-or-ref>
  -f, --force-rebuild
  -l, --local-only
  -p, --path <path>
  -w, --no-watch-upstream
  -q, --quiet

Docker options:
  -l, --local-only
  --port <host:container>
  --tmp-dir <path>
  -q, --quiet`);
}
