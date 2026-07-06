import { shellQuote } from "./format.js";
import { resolvePath } from "./path.js";
import { DEFAULT_DOCKER_IMAGE_TAG } from "./docker.js";
import type { DockerConfig, DockerOptions, GitConfig, RunOptions } from "./types.js";

export function previewRunCommand(options: RunOptions | GitConfig): string {
  const parts = ["pl", "run"];
  if (options.branch) parts.push("--branch", shellQuote(options.branch));
  if (options.force_rebuild) parts.push("--force-rebuild");
  if (options.local_only) parts.push("--local-only");
  if (shouldIncludePath(options.path)) parts.push("--path", shellQuote(options.path));
  if (options.no_watch_upstream) parts.push("--no-watch-upstream");
  if (options.quiet) parts.push("--quiet");
  return parts.join(" ");
}

export function previewDockerCommand(options: DockerOptions | DockerConfig): string {
  const parts = ["pl", "docker"];
  if (options.local_only) parts.push("--local-only");
  if (options.image !== DEFAULT_DOCKER_IMAGE_TAG) parts.push("--image", shellQuote(options.image));
  if (options.port !== "3000:3000") parts.push("--port", shellQuote(options.port));
  if (options.quiet) parts.push("--quiet");
  parts.push(shellQuote(options.course_path));
  return parts.join(" ");
}

function shouldIncludePath(optionPath: string | undefined): optionPath is string {
  if (!optionPath) return false;
  const envPath = process.env.PRAIRIELEARN_PATH;
  if (!envPath) return true;
  return resolvePath(optionPath) !== resolvePath(envPath);
}
