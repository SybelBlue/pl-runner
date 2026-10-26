import type {
  InstanceRecord,
  InstanceStatus,
  LifecycleState,
} from "./types.js";

const ACTIVE_STATES = new Set<LifecycleState>([
  "preparing",
  "starting",
  "running",
  "stopping",
]);

export function isActive(state: LifecycleState): boolean {
  return ACTIVE_STATES.has(state);
}

export function instanceNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

export function findInstanceByName<T extends Pick<InstanceStatus, "name">>(
  instances: T[],
  name: string,
): T | undefined {
  const key = instanceNameKey(name);
  return instances.find((instance) => instanceNameKey(instance.name) === key);
}

export function isStartEligible(instance: InstanceStatus): boolean {
  return !instance.run || !isActive(instance.run.state);
}

export function isRestartEligible(instance: InstanceStatus): boolean {
  return Boolean(
    instance.run &&
    (isActive(instance.run.state) || instance.run.state === "failed"),
  );
}

export function nextAvailablePort(
  instances: Array<{ config: { port: number } }>,
  start = 3000,
): number {
  const used = new Set(instances.map((instance) => instance.config.port));
  for (let port = Math.max(1, start); port <= 65_535; port += 1) {
    if (!used.has(port)) return port;
  }
  throw new RangeError("no available TCP port remains");
}

export function nextProfileName(
  instances: Array<Pick<InstanceStatus, "name">>,
): string {
  const names = new Set(
    instances.map((instance) => instanceNameKey(instance.name)),
  );
  for (let index = 1; ; index += 1) {
    const candidate = `server-${index}`;
    if (!names.has(instanceNameKey(candidate))) return candidate;
  }
}

export function instanceStatus(instance: InstanceRecord): InstanceStatus {
  return {
    id: instance.id,
    name: instance.name,
    config: instance.config,
    run: instance.currentRun,
  };
}
