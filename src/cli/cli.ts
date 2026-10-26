import { stdin, stdout } from "node:process";
import {
  backendIsRunning,
  requestBackend,
  subscribeLogs,
  waitForStart,
  waitForTerminal,
} from "./client.js";
import { DEFAULT_DOCKER_IMAGE_TAG, normalizeDockerImageTag } from "../worker/docker.js";
import {
  findInstanceByName,
  isActive,
  isRestartEligible,
  isStartEligible,
  nextAvailablePort,
} from "../core/instances.js";
import { resolvePath, systemTmpDir } from "../system/path.js";
import { RemoteError } from "../core/protocol.js";
import type {
  DockerConfig,
  GitLaunchConfig,
  InstanceStatus,
  RunEvent,
  RunOptions,
  SupervisorStatus,
} from "../core/types.js";
import { packageVersion } from "../system/version.js";

type Command = "run" | "docker" | "start" | "status" | "stop" | "restart" | "logs" | "backend" | "help" | "version" | null;

export type Parsed = {
  command: Command;
  instance?: string;
  options: RunOptions;
  docker: {
    course_path?: string;
    image?: string;
    port?: number;
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
      return printStatus(parsed.json, parsed.instance);
    }
    if (parsed.command === "status") return printStatus(parsed.json, parsed.instance);
    if (parsed.command === "run") return configureGitAndStart(parsed);
    if (parsed.command === "docker") return configureDockerAndStart(parsed);
    if (parsed.command === "start") {
      const status = await requestBackend("status.get", {});
      const instance = resolveInstance(status, parsed.instance, isStartEligible, "start");
      return startAndMaybeAttach(instance.id, parsed, false);
    }
    if (parsed.command === "stop") {
      const before = await requestBackend("status.get", {});
      const instance = resolveInstance(before, parsed.instance, (item) => Boolean(item.run && isActive(item.run.state)), "stop");
      const record = await requestBackend("instance.stop", { instanceId: instance.id });
      const status = record
        ? await waitForTerminal(instance.id, record.runId)
        : await requestBackend("status.get", {});
      printControlResult(status, parsed.json, instance.id);
      return 0;
    }
    if (parsed.command === "restart") {
      const status = await requestBackend("status.get", {});
      const instance = resolveInstance(status, parsed.instance, isRestartEligible, "restart");
      return startAndMaybeAttach(instance.id, parsed, true);
    }
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
      isolated_database: false,
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
    else if (arg === "--instance") parsed.instance = requireValue(arg, args);
    else if (arg === "-h" || arg === "--help" || arg === "-v" || arg === "--version") continue;
    else throw new Error(`unknown option: ${arg}`);
  }

  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "-h" || arg === "--help" || arg === "-v" || arg === "--version") continue;
    if (arg === "--json") parsed.json = true;
    else if (arg === "--detach") parsed.detach = true;
    else if (arg === "--instance") parsed.instance = requireValue(arg, args);
    else if (arg === "-q" || arg === "--quiet") {
      parsed.options.quiet = true;
      parsed.docker.quiet = true;
    } else if (parsed.command === "run") {
      if (arg === "-b" || arg === "--branch") parsed.options.branch = requireValue(arg, args);
      else if (arg === "-f" || arg === "--force-rebuild") parsed.options.force_rebuild = true;
      else if (arg === "-l" || arg === "--local-only") parsed.options.local_only = true;
      else if (arg === "-p" || arg === "--path") parsed.options.path = requireValue(arg, args);
      else if (arg === "--port") parsed.options.port = requirePort(arg, args);
      else if (arg === "--isolated-database") parsed.options.isolated_database = true;
      else if (arg === "-w" || arg === "--no-watch-upstream") parsed.options.no_watch_upstream = true;
      else if (arg === "--allow-pull-failure") parsed.allowPullFailure = true;
      else throw new Error(`unknown run option: ${arg}`);
    } else if (parsed.command === "docker") {
      if (arg === "-l" || arg === "--local-only") parsed.docker.local_only = true;
      else if (arg === "--image") parsed.docker.image = requireValue(arg, args);
      else if (arg === "--port") parsed.docker.port = requirePort(arg, args);
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
    } else if (parsed.command === "status" || parsed.command === "stop") {
      throw new Error(`unknown ${parsed.command} option: ${arg}`);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  parsed.options.quiet = Boolean(parsed.options.quiet);
  return parsed;
}

async function configureGitAndStart(parsed: Parsed): Promise<number> {
  const path = parsed.options.path ?? process.env.PRAIRIELEARN_PATH ?? "";
  if (!path) throw new RemoteError("INVALID_CONFIG", "pass --path or set PRAIRIELEARN_PATH");
  const status = await requestBackend("status.get", {});
  const target = resolveConfigTarget(status, parsed.instance);
  const port = parsed.options.port ?? target.instance?.config.port ?? requireAvailablePort(status.instances);
  const config: GitLaunchConfig = {
    mode: "git",
    path: resolvePath(path),
    branch: parsed.options.branch ?? null,
    port,
    isolated_database: parsed.options.isolated_database,
    force_rebuild: parsed.options.force_rebuild,
    local_only: parsed.options.local_only,
    no_watch_upstream: parsed.options.no_watch_upstream,
    quiet: false,
  };
  const instance = await saveConfigTarget(target, config);
  return startAndMaybeAttach(instance.id, parsed, false);
}

async function configureDockerAndStart(parsed: Parsed): Promise<number> {
  const status = await requestBackend("status.get", {});
  const target = resolveConfigTarget(status, parsed.instance);
  const port = parsed.docker.port ?? target.instance?.config.port ?? requireAvailablePort(status.instances);
  const config: DockerConfig = {
    mode: "docker",
    course_path: resolvePath(parsed.docker.course_path ?? "."),
    image: normalizeDockerImageTag(parsed.docker.image),
    port,
    tmp_dir: resolvePath(parsed.docker.tmp_dir ?? systemTmpDir()),
    local_only: parsed.docker.local_only ?? false,
    quiet: false,
  };
  const instance = await saveConfigTarget(target, config);
  return startAndMaybeAttach(instance.id, parsed, false);
}

type ConfigTarget = { instance: InstanceStatus | null; name: string };

function resolveConfigTarget(status: SupervisorStatus, selector: string | undefined): ConfigTarget {
  if (selector) {
    const instance = findInstanceByName(status.instances, selector);
    return { instance: instance ?? null, name: instance?.name ?? selector.trim() };
  }
  if (status.instances.length === 0) return { instance: null, name: "default" };
  if (status.instances.length === 1) return { instance: status.instances[0]!, name: status.instances[0]!.name };
  throw ambiguityError("configure", status.instances);
}

async function saveConfigTarget(target: ConfigTarget, config: GitLaunchConfig | DockerConfig): Promise<InstanceStatus> {
  if (target.instance) {
    return requestBackend("instance.update", {
      instanceId: target.instance.id,
      name: target.name,
      config,
    });
  }
  return requestBackend("instance.create", { name: target.name, config });
}

async function startAndMaybeAttach(instanceId: string, parsed: Parsed, restart: boolean): Promise<number> {
  const record = await requestBackend(restart ? "instance.restart" : "instance.start", {
    instanceId,
    allowPullFailure: parsed.allowPullFailure,
    startDockerDaemon: parsed.startDockerDaemon,
  });
  if (parsed.detach) {
    const status = await waitForStart(instanceId, record.runId);
    printControlResult(status, parsed.json, instanceId);
    const run = status.instances.find((instance) => instance.id === instanceId)?.run;
    return run?.state === "running" ? 0 : (run?.exitCode ?? 1);
  }
  return attachToRun(instanceId, record.runId, parsed.json, parsed.options.quiet || parsed.docker.quiet === true);
}

async function attachToRun(instanceId: string, runId: string, json: boolean, quiet: boolean): Promise<number> {
  const initial = await requestBackend("logs.tail", {
    instanceId,
    runId,
    limit: 200,
    afterSeq: 0,
    stream: "all",
  });
  let lastSeq = 0;
  for (const event of initial) {
    lastSeq = Math.max(lastSeq, event.seq);
    if (!quiet) printEvent(event, json);
  }
  const subscription = await subscribeLogs(instanceId, runId, lastSeq, "all", (event) => {
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
      const status = await requestBackend("status.get", {});
      const run = status.instances.find((instance) => instance.id === instanceId)?.run;
      if (!run || run.runId !== runId || run.state === "stopped" || run.state === "failed") {
        subscription.close();
        return run?.exitCode ?? 0;
      }
      await delay(250);
    }
    return 130;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

async function printStatus(json: boolean, selector?: string): Promise<number> {
  const status = await requestBackend("status.get", {});
  const instance = selector ? resolveInstance(status, selector, () => true, "show status for") : undefined;
  printControlResult(status, json, instance?.id);
  return 0;
}

async function printLogs(parsed: Parsed): Promise<number> {
  const status = await requestBackend("status.get", {});
  const instance = resolveInstance(status, parsed.instance, (item) => Boolean(item.run), "show logs for");
  const run = instance.run!;
  const events = await requestBackend("logs.tail", {
    instanceId: instance.id,
    runId: run.runId,
    limit: parsed.tail,
    afterSeq: 0,
    stream: parsed.stream,
  });
  let lastSeq = 0;
  for (const event of events) {
    lastSeq = Math.max(lastSeq, event.seq);
    printEvent(event, parsed.json);
  }
  if (!parsed.follow || run.state === "stopped" || run.state === "failed") return 0;
  const subscription = await subscribeLogs(instance.id, run.runId, lastSeq, parsed.stream, (event) => printEvent(event, parsed.json));
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    subscription.close();
  };
  process.once("SIGINT", onSigint);
  try {
    while (!interrupted) {
      const current = await requestBackend("status.get", {});
      const currentRun = current.instances.find((item) => item.id === instance.id)?.run;
      if (!currentRun || currentRun.runId !== run.runId || currentRun.state === "stopped" || currentRun.state === "failed") {
        subscription.close();
        return 0;
      }
      await delay(250);
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
  return 130;
}

async function backendCommand(parsed: Parsed): Promise<number> {
  const running = await backendIsRunning();
  if (parsed.backendAction === "status") {
    if (!running) {
      console.log(parsed.json ? JSON.stringify({ running: false }) : "backend: stopped");
      return 0;
    }
    const status = await requestBackend("backend.status", {}, { autoStart: false });
    console.log(parsed.json ? JSON.stringify(status.backend) : `backend: running (pid ${status.backend.pid}, protocol ${status.backend.protocolVersion})`);
    return 0;
  }
  if (!running) {
    console.log(parsed.json ? JSON.stringify({ stopped: true, alreadyStopped: true }) : "backend: already stopped");
    return 0;
  }
  const result = await requestBackend("backend.shutdown", {}, { autoStart: false });
  console.log(parsed.json ? JSON.stringify(result) : "backend: stopped (managed instances preserved)");
  return 0;
}

function resolveInstance(
  status: SupervisorStatus,
  selector: string | undefined,
  eligible: (instance: InstanceStatus) => boolean,
  action: string,
): InstanceStatus {
  if (selector) {
    const instance = findInstanceByName(status.instances, selector);
    if (!instance) throw new RemoteError("INSTANCE_NOT_FOUND", `instance not found: ${selector}`);
    return instance;
  }
  const candidates = status.instances.filter(eligible);
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) throw new RemoteError("NOT_RUNNING", `no instance is eligible to ${action}`);
  throw ambiguityError(action, candidates);
}

function ambiguityError(action: string, instances: InstanceStatus[]): RemoteError {
  return new RemoteError(
    "INVALID_CONFIG",
    `multiple instances can ${action}; pass --instance <name> (${instances.map((instance) => instance.name).join(", ")})`,
  );
}

function requireAvailablePort(instances: InstanceStatus[]): number {
  try {
    return nextAvailablePort(instances);
  } catch (error) {
    if (error instanceof RangeError) throw new RemoteError("INVALID_CONFIG", error.message);
    throw error;
  }
}

function printControlResult(status: SupervisorStatus, json: boolean, instanceId?: string): void {
  const instances = instanceId ? status.instances.filter((instance) => instance.id === instanceId) : status.instances;
  if (json) {
    console.log(JSON.stringify(instanceId ? { ...status, instances } : status));
    return;
  }
  console.log(`backend: running (pid ${status.backend.pid})`);
  if (instances.length === 0) {
    console.log("instances: none configured");
    return;
  }
  for (const instance of instances) {
    const mode = instance.config.mode;
    const target = mode === "git" ? instance.config.path : instance.config.course_path;
    const run = instance.run;
    console.log(`instance ${instance.name}: ${run?.state ?? "stopped"} (${mode}, ${target}, localhost:${instance.config.port})`);
    if (run?.exitCode !== null && run?.exitCode !== undefined) console.log(`  exit: ${run.exitCode}`);
    if (run?.errorMessage) console.log(`  error: ${run.errorMessage}`);
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

function requirePort(option: string, args: string[]): number {
  const port = requirePositiveInteger(option, args);
  if (port > 65_535) throw new Error(`${option} requires an integer from 1 to 65535`);
  return port;
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
  start       Start a configured instance
  run         Create or update and start a Git instance
  docker      Create or update and start a Docker instance
  status      Show backend and instance status
  stop        Stop an instance
  restart     Restart an active or failed instance
  logs        Print or follow an instance's lifecycle logs
  backend     Show or stop the supervisor (status|stop)
  help        Show this help message
  version     Show the installed version

Bare pl opens the TUI in a terminal and prints status otherwise.

Common options:
  --instance <name>
  --json
  --detach
  -q, --quiet

Run options:
  -b, --branch <branch-or-ref>
  -f, --force-rebuild
  -l, --local-only
  -p, --path <path>
  --port <host-port>
  --isolated-database
  -w, --no-watch-upstream
  --allow-pull-failure

Docker options:
  -l, --local-only
  --image <${DEFAULT_DOCKER_IMAGE_TAG}|latest>
  --port <host-port>
  --tmp-dir <path>
  --start-docker

Log options:
  -f, --follow
  --tail <count>
  --stream <all|stdout|stderr>`);
}
