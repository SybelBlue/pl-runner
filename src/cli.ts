import { stdin, stdout } from "node:process";
import {
  backendIsRunning,
  requestBackend,
  subscribeLogs,
  waitForStart,
  waitForTerminal,
} from "./client.js";
import { DEFAULT_DOCKER_IMAGE_TAG, normalizeDockerImageTag } from "./docker.js";
import { resolvePath, systemTmpDir } from "./path.js";
import { RemoteError } from "./protocol.js";
import type { DockerConfig, GitLaunchConfig, RunEvent, RunOptions, RunRecord, SupervisorStatus } from "./types.js";
import { packageVersion } from "./version.js";

type Command = "run" | "docker" | "start" | "status" | "stop" | "restart" | "logs" | "backend" | "help" | "version" | null;

export type Parsed = {
  command: Command;
  options: RunOptions;
  docker: {
    course_path?: string;
    image?: string;
    port?: string;
    tmp_dir?: string;
    local_only?: boolean;
    quiet?: boolean;
  };
  json: boolean;
  detach: boolean;
  allowPullFailure: boolean;
  startDockerDaemon: boolean;
  follow: boolean;
  tail: number;
  stream: "all" | "stdout" | "stderr";
  backendAction: "status" | "stop";
  help: boolean;
  version: boolean;
};

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.command === "help" || parsed.help) {
    printHelp();
    return 0;
  }
  if (parsed.command === "version" || parsed.version) {
    console.log(packageVersion());
    return 0;
  }

  try {
    if (parsed.command === null) {
      if (stdin.isTTY && stdout.isTTY) {
        const { launchTui } = await import("./tui.js");
        await launchTui();
        return 0;
      }
      return printStatus(parsed.json);
    }
    if (parsed.command === "status") return printStatus(parsed.json);
    if (parsed.command === "start") return startAndMaybeAttach(undefined, parsed, false);
    if (parsed.command === "run") {
      const path = parsed.options.path ?? process.env.PRAIRIELEARN_PATH ?? "";
      if (!path) throw new RemoteError("INVALID_CONFIG", "pass --path or set PRAIRIELEARN_PATH");
      const config: GitLaunchConfig = {
        mode: "git",
        path: resolvePath(path),
        branch: parsed.options.branch ?? null,
        force_rebuild: parsed.options.force_rebuild,
        local_only: parsed.options.local_only,
        no_watch_upstream: parsed.options.no_watch_upstream,
        quiet: false,
      };
      return startAndMaybeAttach(config, parsed, false);
    }
    if (parsed.command === "docker") {
      const config: DockerConfig = {
        mode: "docker",
        course_path: resolvePath(parsed.docker.course_path ?? "."),
        image: normalizeDockerImageTag(parsed.docker.image),
        port: parsed.docker.port ?? "3000:3000",
        tmp_dir: resolvePath(parsed.docker.tmp_dir ?? systemTmpDir()),
        local_only: parsed.docker.local_only ?? false,
        quiet: false,
      };
      return startAndMaybeAttach(config, parsed, false);
    }
    if (parsed.command === "stop") {
      const record = await requestBackend<RunRecord | null>("instance.stop");
      const status = record ? await waitForTerminal(record.runId) : await requestBackend<SupervisorStatus>("status.get");
      printControlResult(status, parsed.json);
      return 0;
    }
    if (parsed.command === "restart") return startAndMaybeAttach(undefined, parsed, true);
    if (parsed.command === "logs") return printLogs(parsed);
    if (parsed.command === "backend") return backendCommand(parsed);
    return 0;
  } catch (error) {
    printError(error, parsed.json);
    return 1;
  }
}

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
    json: false,
    detach: false,
    allowPullFailure: false,
    startDockerDaemon: false,
    follow: false,
    tail: 200,
    stream: "all",
    backendAction: "status",
    help: false,
    version: false,
  };

  const args = [...argv];
  if (args.includes("-h") || args.includes("--help")) parsed.help = true;
  if (args.includes("-v") || args.includes("--version")) parsed.version = true;

  while (args.length > 0) {
    const arg = args.shift()!;
    if (isCommand(arg)) {
      parsed.command = arg;
      break;
    }
    if (arg === "-q" || arg === "--quiet") parsed.options.quiet = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--detach") parsed.detach = true;
    else if (arg === "-h" || arg === "--help" || arg === "-v" || arg === "--version") continue;
    else throw new Error(`unknown option: ${arg}`);
  }

  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "-h" || arg === "--help" || arg === "-v" || arg === "--version") continue;
    if (arg === "--json") parsed.json = true;
    else if (arg === "--detach") parsed.detach = true;
    else if (arg === "-q" || arg === "--quiet") {
      parsed.options.quiet = true;
      parsed.docker.quiet = true;
    } else if (parsed.command === "run") {
      if (arg === "-b" || arg === "--branch") parsed.options.branch = requireValue(arg, args);
      else if (arg === "-f" || arg === "--force-rebuild") parsed.options.force_rebuild = true;
      else if (arg === "-l" || arg === "--local-only") parsed.options.local_only = true;
      else if (arg === "-p" || arg === "--path") parsed.options.path = requireValue(arg, args);
      else if (arg === "-w" || arg === "--no-watch-upstream") parsed.options.no_watch_upstream = true;
      else if (arg === "--allow-pull-failure") parsed.allowPullFailure = true;
      else throw new Error(`unknown run option: ${arg}`);
    } else if (parsed.command === "docker") {
      if (arg === "-l" || arg === "--local-only") parsed.docker.local_only = true;
      else if (arg === "--image") parsed.docker.image = requireValue(arg, args);
      else if (arg === "--port") parsed.docker.port = requireValue(arg, args);
      else if (arg === "--tmp-dir") parsed.docker.tmp_dir = requireValue(arg, args);
      else if (arg === "--start-docker") parsed.startDockerDaemon = true;
      else if (!arg.startsWith("-") && parsed.docker.course_path === undefined) parsed.docker.course_path = arg;
      else throw new Error(`unknown docker option: ${arg}`);
    } else if (parsed.command === "logs") {
      if (arg === "-f" || arg === "--follow") parsed.follow = true;
      else if (arg === "--tail") parsed.tail = requirePositiveInteger(arg, args);
      else if (arg === "--stream") parsed.stream = requireStream(requireValue(arg, args));
      else throw new Error(`unknown logs option: ${arg}`);
    } else if (parsed.command === "backend") {
      if (arg === "status" || arg === "stop") parsed.backendAction = arg;
      else throw new Error(`unknown backend action: ${arg}`);
    } else if (parsed.command === "start" || parsed.command === "restart") {
      if (arg === "--allow-pull-failure") parsed.allowPullFailure = true;
      else if (arg === "--start-docker") parsed.startDockerDaemon = true;
      else throw new Error(`unknown ${parsed.command} option: ${arg}`);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  parsed.options.quiet = Boolean(parsed.options.quiet);
  return parsed;
}

async function startAndMaybeAttach(
  config: GitLaunchConfig | DockerConfig | undefined,
  parsed: Parsed,
  restart: boolean,
): Promise<number> {
  const payload = {
    ...(config ? { config } : {}),
    allowPullFailure: parsed.allowPullFailure,
    startDockerDaemon: parsed.startDockerDaemon,
  };
  const record = await requestBackend<RunRecord>(restart ? "instance.restart" : "instance.start", payload);
  if (parsed.detach) {
    const status = await waitForStart(record.runId);
    printControlResult(status, parsed.json);
    return status.instance?.state === "running" ? 0 : (status.instance?.exitCode ?? 1);
  }
  return attachToRun(record.runId, parsed.json, parsed.options.quiet || parsed.docker.quiet === true);
}

async function attachToRun(runId: string, json: boolean, quiet: boolean): Promise<number> {
  const initial = await requestBackend<RunEvent[]>("logs.tail", { limit: 200, afterSeq: 0, stream: "all" });
  let lastSeq = 0;
  for (const event of initial) {
    lastSeq = Math.max(lastSeq, event.seq);
    if (!quiet) printEvent(event, json);
  }
  const subscription = await subscribeLogs(lastSeq, "all", (event) => {
    lastSeq = Math.max(lastSeq, event.seq);
    if (!quiet) printEvent(event, json);
  });
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    subscription.close();
  };
  process.once("SIGINT", onSigint);
  try {
    while (!interrupted) {
      const status = await requestBackend<SupervisorStatus>("status.get");
      const instance = status.instance;
      if (!instance || instance.runId !== runId || instance.state === "stopped" || instance.state === "failed") {
        subscription.close();
        return instance?.exitCode ?? 0;
      }
      await delay(250);
    }
    return 130;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

async function printStatus(json: boolean): Promise<number> {
  const status = await requestBackend<SupervisorStatus>("status.get");
  printControlResult(status, json);
  return 0;
}

async function printLogs(parsed: Parsed): Promise<number> {
  const events = await requestBackend<RunEvent[]>("logs.tail", {
    limit: parsed.tail,
    afterSeq: 0,
    stream: parsed.stream,
  });
  let lastSeq = 0;
  for (const event of events) {
    lastSeq = Math.max(lastSeq, event.seq);
    printEvent(event, parsed.json);
  }
  if (!parsed.follow) return 0;
  const subscription = await subscribeLogs(lastSeq, parsed.stream, (event) => printEvent(event, parsed.json));
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    subscription.close();
  };
  process.once("SIGINT", onSigint);
  try {
    await subscription.done;
  } finally {
    process.off("SIGINT", onSigint);
  }
  return interrupted ? 130 : 0;
}

async function backendCommand(parsed: Parsed): Promise<number> {
  const running = await backendIsRunning();
  if (parsed.backendAction === "status") {
    if (!running) {
      const result = { running: false };
      console.log(parsed.json ? JSON.stringify(result) : "backend: stopped");
      return 0;
    }
    const status = await requestBackend<SupervisorStatus>("backend.status", {}, { autoStart: false });
    console.log(parsed.json ? JSON.stringify(status.backend) : `backend: running (pid ${status.backend.pid}, protocol ${status.backend.protocolVersion})`);
    return 0;
  }
  if (!running) {
    console.log(parsed.json ? JSON.stringify({ stopped: true, alreadyStopped: true }) : "backend: already stopped");
    return 0;
  }
  const result = await requestBackend("backend.shutdown", {}, { autoStart: false });
  console.log(parsed.json ? JSON.stringify(result) : "backend: stopped (managed instance preserved)");
  return 0;
}

function printControlResult(status: SupervisorStatus, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(status));
    return;
  }
  const instance = status.instance;
  console.log(`backend: running (pid ${status.backend.pid})`);
  if (!instance) {
    console.log("instance: stopped");
  } else {
    const mode = instance.config.mode;
    const target = mode === "git" ? instance.config.path : instance.config.course_path;
    console.log(`instance: ${instance.state} (${mode}, ${target})`);
    if (instance.exitCode !== null) console.log(`exit: ${instance.exitCode}`);
    if (instance.errorMessage) console.log(`error: ${instance.errorMessage}`);
  }
}

function printEvent(event: RunEvent, json: boolean): void {
  if (json) console.log(JSON.stringify(event));
  else console.log(`[${event.phase}] ${event.source}: ${event.message}`);
}

function printError(error: unknown, json: boolean): void {
  const code = error instanceof RemoteError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.error(JSON.stringify({ error: { code, message } }));
  else console.error(`prairielearn: ${code}: ${message}`);
}

function requireValue(option: string, args: string[]): string {
  const value = args.shift();
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function requirePositiveInteger(option: string, args: string[]): number {
  const value = Number(requireValue(option, args));
  if (!Number.isInteger(value) || value < 1) throw new Error(`${option} requires a positive integer`);
  return value;
}

function requireStream(value: string): "all" | "stdout" | "stderr" {
  if (value === "all" || value === "stdout" || value === "stderr") return value;
  throw new Error("--stream must be all, stdout, or stderr");
}

function isCommand(value: string): value is Exclude<Command, null> {
  return ["run", "docker", "start", "status", "stop", "restart", "logs", "backend", "help", "version"].includes(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp(): void {
  console.log(`Usage: pl [command] [options]

Commands:
  start       Start the saved configuration
  run         Start a Git checkout configuration
  docker      Start a Docker configuration
  status      Show backend and instance status
  stop        Stop the managed instance
  restart     Restart the active or failed instance
  logs        Print or follow lifecycle logs
  backend     Show or stop the supervisor (status|stop)
  help        Show this help message
  version     Show the installed version

Bare pl opens the TUI in a terminal and prints status otherwise.

Common options:
  --json
  --detach
  -q, --quiet

Run options:
  -b, --branch <branch-or-ref>
  -f, --force-rebuild
  -l, --local-only
  -p, --path <path>
  -w, --no-watch-upstream
  --allow-pull-failure

Docker options:
  -l, --local-only
  --image <${DEFAULT_DOCKER_IMAGE_TAG}|latest>
  --port <host:container>
  --tmp-dir <path>
  --start-docker

Log options:
  -f, --follow
  --tail <count>
  --stream <all|stdout|stderr>`);
}
