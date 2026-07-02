import { shellQuote } from "./format.js";
import type { DockerConfig, DockerOptions, GitConfig, RunOptions } from "./types.js";

export function previewRunCommand(options: RunOptions | GitConfig): string {
  const parts = ["pl", "run"];
  if (options.branch) parts.push("--branch", shellQuote(options.branch));
  if (options.force_rebuild) parts.push("--force-rebuild");
  if (options.local_only) parts.push("--local-only");
  if (options.path) parts.push("--path", shellQuote(options.path));
  if (options.no_watch_upstream) parts.push("--no-watch-upstream");
  if (options.quiet) parts.push("--quiet");
  return parts.join(" ");
}

export function previewDockerCommand(options: DockerOptions | DockerConfig): string {
  const parts = ["pl", "docker"];
  if (options.local_only) parts.push("--local-only");
  if (options.port !== "3000:3000") parts.push("--port", shellQuote(options.port));
  if (options.tmp_dir) parts.push("--tmp-dir", shellQuote(options.tmp_dir));
  if (options.quiet) parts.push("--quiet");
  parts.push(shellQuote(options.course_path));
  return parts.join(" ");
}
