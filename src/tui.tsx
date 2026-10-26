import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { requestBackend } from "./client.js";
import { isActive } from "./backend.js";
import { resolvePath } from "./path.js";
import { RemoteError } from "./protocol.js";
import type { LaunchConfig, RunEvent, RunRecord, SupervisorStatus } from "./types.js";

type View = "dashboard" | "config";
type StreamFilter = "all" | "stdout" | "stderr";
type ConfirmAction = "stop" | "restart" | null;

export type ConfigField = {
  label: string;
  key: string;
  kind: "text" | "boolean" | "choice";
  choices?: string[];
};

export type EditingField = {
  key: string;
  value: string;
  suggestionIndex: number;
};

export type BranchSuggestion = {
  label: string;
  value: string;
  hint: "current" | "local" | "origin" | "custom";
};

const defaultGitConfig: LaunchConfig = {
  mode: "git",
  path: process.env.PRAIRIELEARN_PATH ?? "",
  branch: null,
  force_rebuild: false,
  local_only: false,
  no_watch_upstream: false,
  quiet: false,
};

export async function launchTui(): Promise<void> {
  const instance = render(<App />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
}

function App(): React.ReactElement {
  const { exit } = useApp();
  useStdout();
  const [status, setStatus] = useState<SupervisorStatus | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [filter, setFilter] = useState<StreamFilter>("all");
  const [scrollOffset, setScrollOffset] = useState(0);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [draft, setDraft] = useState<LaunchConfig>(defaultGitConfig);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [editing, setEditing] = useState<EditingField | null>(null);
  const [hostInfo, setHostInfo] = useState<Record<string, unknown> | null>(null);

  const refresh = async () => {
    try {
      const next = await requestBackend<SupervisorStatus>("status.get");
      const nextEvents = await requestBackend<RunEvent[]>("logs.tail", { limit: 1_000, stream: "all" });
      setStatus(next);
      setEvents(nextEvents);
      setConnected(true);
      if (!errorCode) setError(null);
    } catch (cause) {
      setConnected(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 500);
    return () => clearInterval(interval);
  }, [errorCode]);

  useEffect(() => {
    if (view !== "config") return;
    const timer = setTimeout(() => {
      const path = draft.mode === "git" && draft.path ? resolvePath(draft.path) : undefined;
      void requestBackend<Record<string, unknown>>("host.inspect", { mode: draft.mode, ...(path ? { path } : {}) }).then(setHostInfo).catch(() => setHostInfo(null));
    }, 250);
    return () => clearTimeout(timer);
  }, [view, draft.mode, draft.mode === "git" ? draft.path : ""]);

  const active = Boolean(status?.instance && isActive(status.instance.state));
  const displayedErrorCode = errorCode ?? (status?.instance?.state === "failed" ? status.instance.errorCode : null);
  const displayedError = error ?? (status?.instance?.state === "failed" ? status.instance.errorMessage : null);
  const fields = configFields(draft);

  const perform = async (action: () => Promise<unknown>) => {
    setError(null);
    setErrorCode(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setErrorCode(cause instanceof RemoteError ? cause.code : "INTERNAL_ERROR");
    }
  };

  const start = (overrides: Record<string, unknown> = {}) => perform(async () => {
    const retryConfig = status?.instance?.state === "failed" ? status.instance.config : null;
    const config = status?.savedConfig ?? retryConfig;
    if (!config) {
      setDraft(defaultGitConfig);
      setView("config");
      return;
    }
    await requestBackend("instance.start", { ...overrides, config });
  });

  useInput((input, key) => {
    if (view === "config") {
      if (editing) {
        const editingBranch = draft.mode === "git" && editing.key === "branch";
        const suggestions = editingBranch ? branchSuggestions(hostInfo, editing.value) : [];
        if (key.escape) setEditing(null);
        else if (key.return) {
          const suggestion = suggestions[Math.min(editing.suggestionIndex, suggestions.length - 1)];
          setDraft(updateTextField(draft, editing.key, suggestion?.value ?? editing.value));
          setEditing(null);
        } else if (editingBranch && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab)) {
          setEditing((current) => {
            if (!current || suggestions.length === 0) return current;
            const direction = key.upArrow || key.leftArrow ? -1 : 1;
            return {
              ...current,
              suggestionIndex: (current.suggestionIndex + direction + suggestions.length) % suggestions.length,
            };
          });
        } else if (key.backspace || key.delete) {
          setEditing({ ...editing, value: editing.value.slice(0, -1), suggestionIndex: 0 });
        } else if (!key.ctrl && !key.meta && input) {
          setEditing({ ...editing, value: editing.value + input, suggestionIndex: 0 });
        }
        return;
      }
      if (input === "q" || key.escape) {
        setView("dashboard");
        return;
      }
      if (key.upArrow) setFieldIndex((index) => Math.max(0, index - 1));
      else if (key.downArrow) setFieldIndex((index) => Math.min(fields.length - 1, index + 1));
      else if (input === "m") {
        setDraft(draft.mode === "git" ? defaultDockerConfig() : defaultGitConfig);
        setFieldIndex(0);
      } else if (input === "s") {
        void perform(async () => {
          await requestBackend("config.set", { config: normalizeClientConfig(draft) });
          setView("dashboard");
        });
      } else if (key.return || input === " ") {
        const field = fields[fieldIndex];
        if (!field) return;
        if (field.kind === "text") {
          setEditing({ key: field.key, value: displayFieldValue(draft, field.key), suggestionIndex: 0 });
        } else {
          setDraft(toggleField(draft, field));
        }
      }
      return;
    }

    if (confirmAction) {
      if (input === "y") {
        const action = confirmAction;
        setConfirmAction(null);
        void perform(() => requestBackend(action === "stop" ? "instance.stop" : "instance.restart"));
      } else if (input === "n" || key.escape) {
        setConfirmAction(null);
      }
      return;
    }

    if (input === "q") exit();
    else if (input === "c" && !active) {
      setDraft(status?.savedConfig ?? defaultGitConfig);
      setView("config");
    } else if (input === "s") void start();
    else if (input === "x" && active) setConfirmAction("stop");
    else if (input === "r" && status?.instance && status.instance.state !== "stopped") setConfirmAction("restart");
    else if (input === "f") setFilter((current) => current === "all" ? "stdout" : current === "stdout" ? "stderr" : "all");
    else if (key.upArrow || key.pageUp) setScrollOffset((offset) => Math.min(events.length, offset + (key.pageUp ? 10 : 1)));
    else if (key.downArrow || key.pageDown) setScrollOffset((offset) => Math.max(0, offset - (key.pageDown ? 10 : 1)));
    else if (key.end) setScrollOffset(0);
    else if (input === "p" && displayedErrorCode === "PULL_FAILED") void start({ allowPullFailure: true });
    else if (input === "d" && displayedErrorCode === "DOCKER_DAEMON_UNAVAILABLE") void start({ startDockerDaemon: true });
  });

  const rows = process.stdout.rows ?? 24;
  if (view === "config") {
    return <ConfigView
      draft={draft}
      fields={fields}
      fieldIndex={fieldIndex}
      editing={editing}
      hostInfo={hostInfo}
      error={error}
    />;
  }

  const logRows = Math.max(3, rows - 11);
  const visible = visibleLogEvents(events, filter, scrollOffset, logRows);

  return <Box flexDirection="column" height={rows}>
    <Box justifyContent="space-between">
      <Text bold color="cyan">PrairieLearn Host Manager</Text>
      <Text color={connected ? "green" : "red"}>{connected ? "backend connected" : "reconnecting…"}</Text>
    </Box>
    <StatusLine status={status} />
    <Text>Saved: {formatConfig(status?.savedConfig ?? null)}</Text>
    <Text dimColor>Keys: s start · x stop · r restart · c configure · f filter · ↑/↓ scroll · End follow · q quit</Text>
    {confirmAction ? <Text color="yellow">Confirm {confirmAction}? y/n</Text> : <Text>Logs: {filter} · {scrollOffset === 0 ? "following" : `${scrollOffset} lines from bottom`}</Text>}
    <Box borderStyle="round" borderColor="gray" flexDirection="column" flexGrow={1} overflow="hidden">
      {visible.length === 0 ? <Text dimColor>No lifecycle output yet.</Text> : visible.map((event) => (
        <Text key={event.seq} color={event.source === "stderr" ? "red" : event.source === "system" ? "yellow" : undefined}>
          <Text dimColor>{String(event.seq).padStart(4)} {event.phase.padEnd(12)} </Text>{event.message}
        </Text>
      ))}
    </Box>
    {displayedError ? <Text color="red">{displayedError}{displayedErrorCode === "PULL_FAILED" ? " · p: retry without pull" : displayedErrorCode === "DOCKER_DAEMON_UNAVAILABLE" ? " · d: start Docker and retry" : ""}</Text> : null}
  </Box>;
}

export function StatusLine({ status }: { status: SupervisorStatus | null }): React.ReactElement {
  const instance = status?.instance;
  const color = instance?.state === "running" ? "green" : instance?.state === "failed" ? "red" : "yellow";
  return <Text>
    Instance: <Text bold color={color}>{instance?.state ?? "stopped"}</Text>
    {instance ? ` · ${formatConfig(instance.config)} · run ${instance.runId.slice(0, 8)}` : ""}
  </Text>;
}

export function ConfigView(props: {
  draft: LaunchConfig;
  fields: ConfigField[];
  fieldIndex: number;
  editing: EditingField | null;
  hostInfo: Record<string, unknown> | null;
  error: string | null;
}): React.ReactElement {
  const suggestions = props.editing?.key === "branch"
    ? branchSuggestions(props.hostInfo, props.editing.value)
    : [];
  const suggestionIndex = Math.min(props.editing?.suggestionIndex ?? 0, suggestions.length - 1);
  return <Box flexDirection="column">
    <Text bold color="cyan">Configuration · {props.draft.mode}</Text>
    <Text dimColor>m switch mode · ↑/↓ select · Enter edit/toggle · s save · q cancel</Text>
    <Box marginTop={1} flexDirection="column">
      {props.fields.map((field, index) => (
        <Text key={field.key} color={index === props.fieldIndex ? "cyan" : undefined}>
          {index === props.fieldIndex ? "›" : " "} {field.label}: {props.editing?.key === field.key ? `${props.editing.value}█` : displayFieldValue(props.draft, field.key)}
        </Text>
      ))}
    </Box>
    {props.editing?.key === "branch" ? <Box marginLeft={2} flexDirection="column">
      <Text dimColor>Type to filter · arrow keys or Tab select · Enter accept</Text>
      {suggestions.map((suggestion, index) => (
        <Text key={`${suggestion.hint}:${suggestion.value}`} color={index === suggestionIndex ? "cyan" : undefined}>
          {index === suggestionIndex ? "›" : " "} {suggestion.label} <Text dimColor>· {suggestion.hint}</Text>
        </Text>
      ))}
    </Box> : null}
    {props.hostInfo ? <Box marginTop={1} flexDirection="column">
      <Text dimColor>Network: {props.hostInfo.internetAvailable ? "online" : "offline"}</Text>
      <Text dimColor>Dependencies: {formatDependencies(props.hostInfo.dependencies)}</Text>
      {props.draft.mode === "git" ? <>
        <Text dimColor>Current branch: {String(props.hostInfo.currentBranch ?? "unknown")}</Text>
        <Text dimColor>Available branches: {formatBranches(props.hostInfo)}</Text>
      </> : <Text dimColor>Images: {formatDockerImages(props.hostInfo.dockerImages)}</Text>}
    </Box> : null}
    {props.error ? <Text color="red">{props.error}</Text> : null}
  </Box>;
}

export function configFields(config: LaunchConfig): ConfigField[] {
  if (config.mode === "git") {
    return [
      { label: "PrairieLearn path", key: "path", kind: "text" },
      { label: "Branch/ref (blank=current)", key: "branch", kind: "text" },
      { label: "Force dependency rebuild", key: "force_rebuild", kind: "boolean" },
      { label: "Local checkout only", key: "local_only", kind: "boolean" },
      { label: "Watch upstream", key: "watch_upstream", kind: "boolean" },
    ];
  }
  return [
    { label: "Course path", key: "course_path", kind: "text" },
    { label: "Image", key: "image", kind: "choice", choices: ["us-prod-live", "latest"] },
    { label: "Port mapping", key: "port", kind: "text" },
    { label: "Jobs temp directory", key: "tmp_dir", kind: "text" },
    { label: "Local image only", key: "local_only", kind: "boolean" },
  ];
}

function defaultDockerConfig(): LaunchConfig {
  return {
    mode: "docker",
    course_path: ".",
    image: "us-prod-live",
    port: "3000:3000",
    tmp_dir: "/tmp",
    local_only: false,
    quiet: false,
  };
}

function displayFieldValue(config: LaunchConfig, key: string): string {
  if (key === "watch_upstream" && config.mode === "git") return String(!config.no_watch_upstream);
  const value = (config as unknown as Record<string, unknown>)[key];
  return value === null ? "" : String(value ?? "");
}

function updateTextField(config: LaunchConfig, key: string, value: string): LaunchConfig {
  if (config.mode === "git" && key === "branch") {
    const branch = value.trim().replace(/^origin\//, "");
    return { ...config, branch: branch || null };
  }
  return { ...config, [key]: value } as LaunchConfig;
}

function toggleField(config: LaunchConfig, field: ConfigField): LaunchConfig {
  if (field.key === "watch_upstream" && config.mode === "git") {
    return { ...config, no_watch_upstream: !config.no_watch_upstream };
  }
  if (field.kind === "boolean") {
    const current = Boolean((config as unknown as Record<string, unknown>)[field.key]);
    return { ...config, [field.key]: !current } as LaunchConfig;
  }
  if (field.kind === "choice" && field.choices) {
    const current = displayFieldValue(config, field.key);
    const index = field.choices.indexOf(current);
    return { ...config, [field.key]: field.choices[(index + 1) % field.choices.length] } as LaunchConfig;
  }
  return config;
}

function formatConfig(config: LaunchConfig | null): string {
  if (!config) return "not configured";
  return config.mode === "git"
    ? `git ${config.path}${config.branch ? ` @ ${config.branch}` : ""}`
    : `docker ${config.course_path} (${config.image}, ${config.port})`;
}

function formatBranches(info: Record<string, unknown>): string {
  const local = Array.isArray(info.localBranches) ? info.localBranches : [];
  const remote = Array.isArray(info.remoteBranches) ? info.remoteBranches : [];
  const branches = [...new Set([...local, ...remote].map(String))].slice(0, 8);
  return branches.length > 0 ? branches.join(", ") : "none detected";
}

export function branchSuggestions(
  info: Record<string, unknown> | null,
  query: string,
): BranchSuggestion[] {
  const current = typeof info?.currentBranch === "string" ? info.currentBranch : null;
  const local = stringList(info?.localBranches);
  const remote = stringList(info?.remoteBranches);
  const branchNames = [...new Set([...local, ...remote])].filter((branch) => branch !== current);
  const candidates: Array<BranchSuggestion & { searchable: string }> = [
    {
      label: current ? `Current branch (${current})` : "Current branch",
      value: "",
      hint: "current",
      searchable: `current branch ${current ?? ""}`,
    },
    ...branchNames.map((branch): BranchSuggestion & { searchable: string } => ({
      label: branch,
      value: branch,
      hint: local.includes(branch) ? "local" : "origin",
      searchable: branch,
    })),
  ];
  const normalizedQuery = query.trim().replace(/^origin\//, "");
  const needle = normalizedQuery.toLocaleLowerCase();
  const matching = candidates.filter((candidate) => !needle || candidate.searchable.toLocaleLowerCase().includes(needle));
  const custom: BranchSuggestion[] = normalizedQuery && !branchNames.includes(normalizedQuery)
    ? [{ label: `Use “${normalizedQuery}” as branch/ref`, value: normalizedQuery, hint: "custom" }]
    : [];
  const visibleMatching = matching.slice(0, custom.length > 0 ? 7 : 8);
  return [...visibleMatching, ...custom].map(({ label, value, hint }) => ({ label, value, hint }));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function formatDependencies(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  return Object.entries(value as Record<string, unknown>)
    .map(([command, available]) => `${command}:${available ? "ok" : "missing"}`)
    .join(" ");
}

function formatDockerImages(value: unknown): string {
  if (!Array.isArray(value)) return "unknown";
  return value.map((item) => {
    if (!item || typeof item !== "object") return String(item);
    const info = item as { tag?: unknown; updatedAt?: unknown };
    const updated = typeof info.updatedAt === "string" ? info.updatedAt.slice(0, 10) : "update unknown";
    return `${String(info.tag ?? "unknown")} (${updated})`;
  }).join(", ");
}

export function visibleLogEvents(
  events: RunEvent[],
  filter: StreamFilter,
  scrollOffset: number,
  rows: number,
): RunEvent[] {
  const filtered = events.filter((event) => filter === "all" || event.source === filter || event.source === "system");
  const end = Math.max(0, filtered.length - scrollOffset);
  return filtered.slice(Math.max(0, end - rows), end);
}

function normalizeClientConfig(config: LaunchConfig): LaunchConfig {
  if (config.mode === "git") return { ...config, path: resolvePath(config.path), quiet: false };
  return {
    ...config,
    course_path: resolvePath(config.course_path),
    tmp_dir: resolvePath(config.tmp_dir),
    quiet: false,
  };
}
