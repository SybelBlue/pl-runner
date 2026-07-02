import { spawn } from "node:child_process";
import type { CommandResult } from "./types.js";
import { stripOsc11 } from "./format.js";
import { withoutVirtualEnv } from "./path.js";

type RunCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
};

export function runCommand(
  command: string,
  args: string[] = [],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: withoutVirtualEnv(options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
      resolve({ status: 127, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      resolve({ status: signal ? signalStatus(signal) : (code ?? 1), stdout, stderr });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

export type InteractiveProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  quiet?: boolean;
  onExitRequest?: (terminate: (signal?: NodeJS.Signals) => void) => void;
};

export function runInteractiveProcess(
  command: string,
  args: string[],
  options: InteractiveProcessOptions = {},
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: withoutVirtualEnv(options.env),
      detached: true,
      stdio: ["inherit", "pipe", "pipe"],
    });

    let interruptCount = 0;
    let resolved = false;

    const terminate = (signal: NodeJS.Signals = "SIGTERM") => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // Process may already be gone.
          }
        }
      }
    };

    options.onExitRequest?.(terminate);

    const onSigint = () => {
      interruptCount += 1;
      terminate(interruptCount === 1 ? "SIGINT" : "SIGTERM");
    };
    process.on("SIGINT", onSigint);

    const forward = (chunk: Buffer | string) => {
      if (!options.quiet) process.stdout.write(stripOsc11(String(chunk)));
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", () => {
      cleanup();
      resolved = true;
      resolve(127);
    });
    child.on("close", (code, signal) => {
      cleanup();
      if (resolved) return;
      if (interruptCount > 0) {
        resolve(130);
        return;
      }
      resolve(signal ? signalStatus(signal) : (code ?? 1));
    });

    function cleanup() {
      process.off("SIGINT", onSigint);
    }
  });
}

function signalStatus(signal: NodeJS.Signals): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}
