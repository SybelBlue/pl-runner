import { z } from "zod";
import type { PreflightDependencies } from "../system/deps.js";
import type { DockerImageInfo } from "../worker/docker.js";
import type {
  InstanceStatus,
  LaunchConfig,
  RunEvent,
  RunRecord,
  SupervisorStatus,
} from "./types.js";

export const PROTOCOL_VERSION = 3;
export const WORKER_PROTOCOL_VERSION = 1;

export const instanceNameSchema = z.string().trim().min(1).max(64);
const portSchema = z.number().int().min(1).max(65_535);

const gitConfigSchema = z.object({
  mode: z.literal("git"),
  path: z.string().min(1),
  branch: z.string().nullable(),
  port: portSchema,
  isolated_database: z.boolean(),
  force_rebuild: z.boolean(),
  local_only: z.boolean(),
  no_watch_upstream: z.boolean(),
  quiet: z.boolean(),
});

const dockerConfigSchema = z.object({
  mode: z.literal("docker"),
  course_path: z.string().min(1),
  image: z.enum(["us-prod-live", "latest"]),
  port: portSchema,
  tmp_dir: z.string().min(1),
  local_only: z.boolean(),
  quiet: z.boolean(),
});

export const launchConfigSchema = z.discriminatedUnion("mode", [
  gitConfigSchema,
  dockerConfigSchema,
]);

const emptyPayloadSchema = z.object({});
const instanceIdSchema = z.string().min(1);
const streamSchema = z.enum(["all", "stdout", "stderr"]);

export type HostInspection = {
  dependencies: PreflightDependencies;
  internetAvailable: boolean;
  dockerImages: DockerImageInfo[];
  validProjectPath?: boolean;
  warnings?: string[];
  currentBranch?: string | null;
  localBranches?: string[];
  remoteBranches?: string[];
};

export type BackendOperationMap = {
  hello: {
    payload: Record<string, never>;
    result: {
      protocolVersion: number;
      packageVersion: string;
      capabilities: string[];
    };
  };
  "status.get": { payload: Record<string, never>; result: SupervisorStatus };
  "backend.status": {
    payload: Record<string, never>;
    result: SupervisorStatus;
  };
  "instance.get": { payload: { instanceId: string }; result: InstanceStatus };
  "instance.create": {
    payload: { name: string; config: LaunchConfig };
    result: InstanceStatus;
  };
  "instance.update": {
    payload: { instanceId: string; name: string; config: LaunchConfig };
    result: InstanceStatus;
  };
  "instance.delete": {
    payload: { instanceId: string };
    result: { deletedId: string };
  };
  "host.inspect": {
    payload: { mode: LaunchConfig["mode"]; path?: string };
    result: HostInspection;
  };
  "instance.start": {
    payload: {
      instanceId: string;
      allowPullFailure?: boolean;
      startDockerDaemon?: boolean;
    };
    result: RunRecord;
  };
  "instance.stop": {
    payload: { instanceId: string };
    result: RunRecord | null;
  };
  "instance.restart": {
    payload: {
      instanceId: string;
      allowPullFailure?: boolean;
      startDockerDaemon?: boolean;
    };
    result: RunRecord;
  };
  "logs.tail": {
    payload: {
      instanceId: string;
      runId?: string;
      limit?: number;
      afterSeq?: number;
      stream?: "all" | "stdout" | "stderr";
    };
    result: RunEvent[];
  };
  "logs.subscribe": {
    payload: {
      instanceId: string;
      runId?: string;
      limit?: number;
      afterSeq?: number;
      stream?: "all" | "stdout" | "stderr";
    };
    result: { subscribed: true; runId: string };
  };
  "docker.startDaemon": {
    payload: Record<string, never>;
    result: { exitCode: number };
  };
  "backend.shutdown": {
    payload: Record<string, never>;
    result: { accepted: true; activeInstancesPreserved: number };
  };
};

export type BackendOperation = keyof BackendOperationMap;
export type BackendPayload<K extends BackendOperation> =
  BackendOperationMap[K]["payload"];
export type BackendResult<K extends BackendOperation> =
  BackendOperationMap[K]["result"];

const backendPayloadSchemas = {
  hello: emptyPayloadSchema,
  "status.get": emptyPayloadSchema,
  "backend.status": emptyPayloadSchema,
  "instance.get": z.object({ instanceId: instanceIdSchema }),
  "instance.create": z.object({
    name: instanceNameSchema,
    config: launchConfigSchema,
  }),
  "instance.update": z.object({
    instanceId: instanceIdSchema,
    name: instanceNameSchema,
    config: launchConfigSchema,
  }),
  "instance.delete": z.object({ instanceId: instanceIdSchema }),
  "host.inspect": z.object({
    mode: z.enum(["git", "docker"]),
    path: z.string().optional(),
  }),
  "instance.start": z.object({
    instanceId: instanceIdSchema,
    allowPullFailure: z.boolean().optional(),
    startDockerDaemon: z.boolean().optional(),
  }),
  "instance.stop": z.object({ instanceId: instanceIdSchema }),
  "instance.restart": z.object({
    instanceId: instanceIdSchema,
    allowPullFailure: z.boolean().optional(),
    startDockerDaemon: z.boolean().optional(),
  }),
  "logs.tail": z.object({
    instanceId: instanceIdSchema,
    runId: z.string().optional(),
    limit: z.number().finite().optional(),
    afterSeq: z.number().finite().optional(),
    stream: streamSchema.optional(),
  }),
  "logs.subscribe": z.object({
    instanceId: instanceIdSchema,
    runId: z.string().optional(),
    limit: z.number().finite().optional(),
    afterSeq: z.number().finite().optional(),
    stream: streamSchema.optional(),
  }),
  "docker.startDaemon": emptyPayloadSchema,
  "backend.shutdown": emptyPayloadSchema,
} satisfies { [K in BackendOperation]: z.ZodType<BackendPayload<K>> };

export const requestSchema = z.object({
  protocol: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown().optional(),
});

export const workerRequestSchema = z.object({
  protocol: z.literal(WORKER_PROTOCOL_VERSION),
  id: z.string().min(1),
  type: z.string().min(1),
  payload: z.unknown().optional(),
});

export type ProtocolRequest = z.infer<typeof requestSchema>;

export function isBackendOperation(type: string): type is BackendOperation {
  return Object.hasOwn(backendPayloadSchemas, type);
}

export function parseBackendPayload<K extends BackendOperation>(
  type: K,
  payload: unknown,
): BackendPayload<K> {
  return backendPayloadSchemas[type].parse(payload ?? {}) as BackendPayload<K>;
}

export type ProtocolErrorCode =
  | "INVALID_CONFIG"
  | "ACTIVE_INSTANCE_CONFLICT"
  | "INSTANCE_NOT_FOUND"
  | "INSTANCE_NAME_CONFLICT"
  | "PORT_CONFLICT"
  | "PORT_IN_USE"
  | "PULL_FAILED"
  | "MISSING_DEPENDENCY"
  | "DOCKER_DAEMON_UNAVAILABLE"
  | "WORKER_RECOVERY_FAILED"
  | "PROTOCOL_MISMATCH"
  | "NOT_RUNNING"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

type ProtocolError = {
  code: ProtocolErrorCode;
  message: string;
  details?: unknown;
};

export type ProtocolResponse<T = unknown> =
  | { protocol: typeof PROTOCOL_VERSION; id: string; ok: true; result: T }
  | {
      protocol: typeof PROTOCOL_VERSION;
      id: string;
      ok: false;
      error: ProtocolError;
    };

export type ProtocolEvent = {
  protocol: typeof PROTOCOL_VERSION;
  event: "log" | "status";
  data: RunEvent | SupervisorStatus;
};

export function success<T>(id: string, result: T): ProtocolResponse<T> {
  return { protocol: PROTOCOL_VERSION, id, ok: true, result };
}

export function failure(
  id: string,
  code: ProtocolErrorCode,
  message: string,
  details?: unknown,
): ProtocolResponse {
  return {
    protocol: PROTOCOL_VERSION,
    id,
    ok: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
}

export function parseLaunchConfig(value: unknown): LaunchConfig {
  return launchConfigSchema.parse(value) as LaunchConfig;
}

export class RemoteError extends Error {
  constructor(
    public readonly code: ProtocolErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
