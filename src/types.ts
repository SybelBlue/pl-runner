export type LaunchMode = "git" | "docker";

export type DockerImageTag = "us-prod-live" | "latest";

export type RunOptions = {
  path?: string;
  branch?: string | null;
  force_rebuild: boolean;
  local_only: boolean;
  no_watch_upstream: boolean;
  internet_available?: boolean;
  quiet: boolean;
};

export type DockerOptions = {
  course_path: string;
  image: DockerImageTag;
  port: string;
  tmp_dir: string;
  local_only: boolean;
  quiet: boolean;
};

export type GitConfig = RunOptions & {
  mode: "git";
  path: string;
  branch: string | null;
  internet_available: boolean;
};

export type DockerConfig = DockerOptions & {
  mode: "docker";
};

export type SavedConfig = GitConfig | DockerConfig;

export type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type Logger = {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
};
