import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type DirectorySuggestion = {
  label: string;
  value: string;
  hint: "directory";
};

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function resolvePath(input: string): string {
  return path.resolve(expandHome(input));
}

export function displayHomeRelativePath(input: string, home = os.homedir()): string {
  if (!path.isAbsolute(input)) return input;
  const relative = path.relative(path.resolve(home), path.resolve(input));
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? relative
    : input;
}

export async function completeDirectoryPath(
  input: string,
  cwd = process.cwd(),
  home = os.homedir(),
): Promise<DirectorySuggestion[]> {
  const parentInput = input === "~" || input.endsWith(path.sep) ? input : path.dirname(input);
  const prefix = input === "~" || input.endsWith(path.sep) ? "" : path.basename(input);
  const expandedParent = parentInput === "~"
    ? home
    : parentInput.startsWith(`~${path.sep}`)
      ? path.join(home, parentInput.slice(2))
      : parentInput;
  const parent = path.resolve(cwd, expandedParent);

  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && (prefix.startsWith(".") || !entry.name.startsWith(".")))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 8)
      .map((entry) => ({
        label: entry.name,
        value: joinCompletionPath(parentInput, input, entry.name),
        hint: "directory" as const,
      }));
  } catch {
    return [];
  }
}

function joinCompletionPath(parentInput: string, input: string, name: string): string {
  if (parentInput === ".") return input.startsWith(`.${path.sep}`) ? `.${path.sep}${name}` : name;
  if (parentInput.endsWith(path.sep)) return `${parentInput}${name}`;
  return `${parentInput}${path.sep}${name}`;
}

export function systemTmpDir(): string {
  return os.tmpdir();
}

export function withoutVirtualEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.VIRTUAL_ENV;
  return next;
}
