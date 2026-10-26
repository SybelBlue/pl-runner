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

/** A Git launch request before the backend applies current network defaults. */
export type GitLaunchConfig = Omit<GitConfig, "internet_available">;

export type DockerConfig = DockerOptions & {
  mode: "docker";
};

export type SavedConfig = GitConfig | DockerConfig;

/** The versioned configuration owned by the backend. */
export type LaunchConfig = GitLaunchConfig | DockerConfig;

export type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type Logger = {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
};

export type LifecycleState =
  | "stopped"
  | "preparing"
  | "starting"
  | "running"
  | "stopping"
  | "failed";

export type LogSource = "system" | "stdout" | "stderr";

export type RunEvent = {
  seq: number;
  timestamp: string;
  source: LogSource;
  phase: string;
  message: string;
};

export type WorkerState = {
  runId: string;
  state: LifecycleState;
  pid: number;
  childPid: number | null;
  startedAt: string;
  updatedAt: string;
  exitCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type RunRecord = WorkerState & {
  config: LaunchConfig;
  runDir: string;
  workerSocket: string;
};

export type SupervisorState = {
  schemaVersion: 2;
  savedConfig: LaunchConfig | null;
  currentRun: RunRecord | null;
  history: string[];
  migratedLegacyConfig: boolean;
};

export type SupervisorStatus = {
  backend: {
    running: boolean;
    pid: number;
    protocolVersion: number;
    packageVersion: string;
  };
  instance: RunRecord | null;
  savedConfig: LaunchConfig | null;
};
