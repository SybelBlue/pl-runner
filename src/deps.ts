import { runCommand } from "./process.js";

export type CommandDependency = "git" | "docker" | "pnpm" | "uv";

export type DependencyStatus = {
  command: CommandDependency;
  available: boolean;
};

export type PreflightDependencies = Record<CommandDependency, boolean>;

const dependencies: CommandDependency[] = ["git", "docker", "pnpm", "uv"];

export async function checkCommandDependency(command: CommandDependency): Promise<DependencyStatus> {
  const result = await runCommand(command, ["--version"]);
  return { command, available: result.status === 0 };
}

export async function checkPreflightDependencies(): Promise<PreflightDependencies> {
  const results = await Promise.all(dependencies.map((dependency) => checkCommandDependency(dependency)));
  return Object.fromEntries(results.map((result) => [result.command, result.available])) as PreflightDependencies;
}

export function missingDependencies(deps: PreflightDependencies, commands: CommandDependency[]): CommandDependency[] {
  return commands.filter((command) => !deps[command]);
}

export function formatDependencyStatus(deps: PreflightDependencies): string {
  return dependencies.map((dependency) => `${dependency}: ${deps[dependency] ? "found" : "missing"}`).join(", ");
}
