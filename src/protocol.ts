import { z } from "zod";
import type { LaunchConfig, RunEvent, SupervisorStatus } from "./types.js";

export const PROTOCOL_VERSION = 2;
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

export const launchConfigSchema = z.discriminatedUnion("mode", [gitConfigSchema, dockerConfigSchema]);

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
  | { protocol: 2; id: string; ok: true; result: T }
  | { protocol: 2; id: string; ok: false; error: ProtocolError };

export type ProtocolEvent = {
  protocol: 2;
  event: "log" | "status";
  data: RunEvent | SupervisorStatus;
};

export function success<T>(id: string, result: T): ProtocolResponse<T> {
  return { protocol: PROTOCOL_VERSION, id, ok: true, result };
}

export function failure(id: string, code: ProtocolErrorCode, message: string, details?: unknown): ProtocolResponse {
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
