import React, { useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useBoxMetrics, useInput, useStdout } from "ink";
import { requestBackend } from "./client.js";
import { isActive, nextAvailablePort, nextProfileName } from "../core/instances.js";
import { mouseEventIsInside, useMouseWheel } from "./mouse.js";
import { completeDirectoryPath, displayHomeRelativePath, resolvePath, type DirectorySuggestion } from "../system/path.js";
import { RemoteError, type BackendPayload, type HostInspection } from "../core/protocol.js";
import type { DOMElement } from "ink";
import type { InstanceStatus, LaunchConfig, LifecycleState, RunEvent, SupervisorStatus } from "../core/types.js";

type View = "dashboard" | "config";
type LogColor = "cyan" | "green" | "yellow" | "red" | undefined;

export type ConfigField = {
  label: string;
  key: string;
  kind: "text" | "directory" | "boolean" | "choice";
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

type ProfileDraft = {
  id: string | null;
  name: string;
  config: LaunchConfig;
};

function defaultGitConfig(port = 3000): LaunchConfig {
  return {
    mode: "git",
    path: process.env.PRAIRIELEARN_PATH ?? "",
    branch: null,
    port,
    isolated_database: false,
    force_rebuild: false,
    local_only: false,
    no_watch_upstream: false,
    quiet: false,
  };
}

export async function launchTui(): Promise<void> {
  process.stdout.write(titlebarSequence(process.cwd()));
  const instance = render(<App />, { exitOnCtrlC: false, alternateScreen: true });
  await instance.waitUntilExit();
}

export function titlebarSequence(cwd: string, home?: string): string {
  const title = displayHomeRelativePath(cwd, home).replace(/[\u0000-\u001F\u007F]/g, "");
  return `\u001B]0;${title}\u0007`;
}

function App(): React.ReactElement {
  const { exit } = useApp();
  useStdout();
  const logWindowRef = useRef<DOMElement>(null);
  const logContentRef = useRef<DOMElement>(null);
  const logWindow = useBoxMetrics(logWindowRef);
  const logContent = useBoxMetrics(logContentRef);
  const refreshGeneration = useRef(0);
  const [status, setStatus] = useState<SupervisorStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [view, setView] = useState<View>("dashboard");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [draft, setDraft] = useState<ProfileDraft>({ id: null, name: "server-1", config: defaultGitConfig() });
  const [fieldIndex, setFieldIndex] = useState(0);
  const [editing, setEditing] = useState<EditingField | null>(null);
  const [hostInfo, setHostInfo] = useState<HostInspection | null>(null);
  const [directorySuggestions, setDirectorySuggestions] = useState<DirectorySuggestion[]>([]);
  const [directorySuggestionsLoading, setDirectorySuggestionsLoading] = useState(false);
  const [directorySuggestionsError, setDirectorySuggestionsError] = useState<string | null>(null);

  const refresh = async (preferredId = selectedId) => {
    const generation = ++refreshGeneration.current;
    try {
      const next = await requestBackend("status.get", {});
      const selected = next.instances.find((instance) => instance.id === preferredId) ?? next.instances[0] ?? null;
      const nextEvents = selected?.run
        ? await requestBackend("logs.tail", {
            instanceId: selected.id,
            runId: selected.run.runId,
            limit: 1_000,
            stream: "all",
          })
        : [];
      if (generation !== refreshGeneration.current) return;
      setStatus(next);
      setSelectedId(selected?.id ?? null);
      setEvents(nextEvents);
      setConnected(true);
      if (!errorCode) setError(null);
    } catch (cause) {
      if (generation !== refreshGeneration.current) return;
      setConnected(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    void refresh(selectedId);
    const interval = setInterval(() => void refresh(selectedId), 500);
    return () => clearInterval(interval);
  }, [selectedId, errorCode]);

  useEffect(() => {
    if (view !== "config") return;
    const timer = setTimeout(() => {
      const path = draft.config.mode === "git" && draft.config.path ? resolvePath(draft.config.path) : undefined;
      void requestBackend("host.inspect", {
        mode: draft.config.mode,
        ...(path ? { path } : {}),
      }).then(setHostInfo).catch(() => setHostInfo(null));
    }, 250);
    return () => clearTimeout(timer);
  }, [view, draft.config.mode, draft.config.mode === "git" ? draft.config.path : ""]);

  useEffect(() => {
    if (!editing || !isDirectoryField(draft.config, editing.key)) {
      setDirectorySuggestions([]);
      setDirectorySuggestionsLoading(false);
      setDirectorySuggestionsError(null);
      return;
    }
    let cancelled = false;
    setDirectorySuggestions([]);
    setDirectorySuggestionsLoading(true);
    setDirectorySuggestionsError(null);
    void completeDirectoryPath(editing.value, process.cwd())
      .then((suggestions) => {
        if (cancelled) return;
        setDirectorySuggestions(suggestions);
        setDirectorySuggestionsLoading(false);
      })
      .catch((cause) => {
        if (cancelled) return;
        setDirectorySuggestions([]);
        setDirectorySuggestionsLoading(false);
        setDirectorySuggestionsError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [draft.config.mode, editing?.key, editing?.value]);

  const instances = status?.instances ?? [];
  const selectedIndex = Math.max(0, instances.findIndex((instance) => instance.id === selectedId));
  const selected = instances[selectedIndex] ?? null;
  const run = selected?.run ?? null;
  const active = Boolean(run && isActive(run.state));
  const restartAvailable = canRestart(run?.state);
  const displayedErrorCode = errorCode ?? (run?.state === "failed" ? run.errorCode : null);
  const displayedError = error ?? (run?.state === "failed" ? run.errorMessage : null);
  const fields = profileFields(draft.config);

  useMouseWheel((event) => {
    if (!logWindow.hasMeasured || !mouseEventIsInside(event, logWindow)) return;
    setScrollOffset((offset) => Math.max(0, Math.min(events.length, offset + (event.direction === "up" ? 1 : -1))));
  }, { isActive: view === "dashboard" && !confirmDelete });

  const perform = async (action: () => Promise<unknown>) => {
    setError(null);
    setErrorCode(null);
    try {
      await action();
      await refresh(selectedId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setErrorCode(cause instanceof RemoteError ? cause.code : "INTERNAL_ERROR");
    }
  };

  const start = (
    overrides: Pick<BackendPayload<"instance.start">, "allowPullFailure" | "startDockerDaemon"> = {},
  ) => perform(async () => {
    if (!selected) {
      beginNewProfile();
      return;
    }
    await requestBackend("instance.start", { instanceId: selected.id, ...overrides });
  });

  const beginNewProfile = () => {
    let port = 3000;
    try {
      port = nextAvailablePort(instances);
    } catch {
      // Preserve the existing fallback; the backend will report the conflict.
    }
    setDraft({ id: null, name: nextProfileName(instances), config: defaultGitConfig(port) });
    setFieldIndex(0);
    setEditing(null);
    setError(null);
    setErrorCode(null);
    setView("config");
  };

  const selectRelative = (delta: number) => {
    const nextId = relativeInstanceId(instances, selectedId, delta);
    if (!nextId) return;
    setSelectedId(nextId);
    setEvents([]);
    setScrollOffset(0);
    setError(null);
    setErrorCode(null);
    setConfirmDelete(false);
  };

  useInput((input, key) => {
    if (view === "config") {
      if (active && draft.id === selected?.id) {
        if (key.upArrow) setFieldIndex((index) => Math.max(0, index - 1));
        else if (key.downArrow) setFieldIndex((index) => Math.min(fields.length - 1, index + 1));
        else if (!key.leftArrow && !key.rightArrow) setView("dashboard");
        return;
      }
      if (editing) {
        const editingBranch = draft.config.mode === "git" && editing.key === "branch";
        const editingDirectory = isDirectoryField(draft.config, editing.key);
        const suggestions = editingBranch
          ? branchSuggestions(hostInfo, editing.value)
          : editingDirectory
            ? directorySuggestions
            : [];
        if (key.escape) setEditing(null);
        else if (key.return) {
          const suggestion = suggestions[Math.min(editing.suggestionIndex, suggestions.length - 1)];
          const value = suggestion?.value ?? editing.value;
          if (editing.key === "port") {
            const port = Number(value);
            if (!Number.isInteger(port) || port < 1 || port > 65_535) {
              setError("Port must be an integer from 1 to 65535");
              return;
            }
          }
          setDraft(updateProfileTextField(draft, editing.key, value));
          setError(null);
          setEditing(null);
        } else if (editingDirectory && key.tab) {
          const suggestion = suggestions[Math.min(editing.suggestionIndex, suggestions.length - 1)];
          if (suggestion) {
            setDirectorySuggestions([]);
            setDirectorySuggestionsLoading(true);
            setDirectorySuggestionsError(null);
            setEditing({ ...editing, value: `${suggestion.value}/`, suggestionIndex: 0 });
          }
        } else if ((editingBranch || editingDirectory) && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab)) {
          setEditing((current) => {
            if (!current || suggestions.length === 0) return current;
            const direction = key.upArrow || key.leftArrow ? -1 : 1;
            return { ...current, suggestionIndex: (current.suggestionIndex + direction + suggestions.length) % suggestions.length };
          });
        } else if (key.backspace || key.delete) {
          if (editingDirectory) {
            setDirectorySuggestions([]);
            setDirectorySuggestionsLoading(true);
            setDirectorySuggestionsError(null);
          }
          setEditing({ ...editing, value: editing.value.slice(0, -1), suggestionIndex: 0 });
        } else if (!key.ctrl && !key.meta && input) {
          if (editingDirectory) {
            setDirectorySuggestions([]);
            setDirectorySuggestionsLoading(true);
            setDirectorySuggestionsError(null);
          }
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
      else if (input === "s") {
        const port = draft.config.port;
        setDraft({
          ...draft,
          config: draft.config.mode === "git" ? defaultDockerConfig(port) : defaultGitConfig(port),
        });
        setFieldIndex(0);
      } else if (input === "c") {
        setError(null);
        setErrorCode(null);
        void (async () => {
          try {
            const payload = {
              name: draft.name.trim(),
              config: normalizeClientConfig(draft.config),
            };
            const saved = draft.id
              ? await requestBackend("instance.update", { instanceId: draft.id, ...payload })
              : await requestBackend("instance.create", payload);
            setSelectedId(saved.id);
            setView("dashboard");
            await refresh(saved.id);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setErrorCode(cause instanceof RemoteError ? cause.code : "INTERNAL_ERROR");
          }
        })();
      } else if (key.return || input === " " || key.tab) {
        const field = fields[fieldIndex];
        if (!field) return;
        if (key.tab && field.kind !== "directory") return;
        if (field.kind === "text" || field.kind === "directory") {
          setDirectorySuggestions([]);
          setDirectorySuggestionsLoading(field.kind === "directory");
          setDirectorySuggestionsError(null);
          setEditing({ key: field.key, value: displayProfileFieldValue(draft, field.key), suggestionIndex: 0 });
        } else {
          setDraft({ ...draft, config: toggleField(draft.config, field) });
        }
      }
      return;
    }

    if (confirmDelete) {
      if (input.toLocaleLowerCase() === "y" && selected && !active) {
        setConfirmDelete(false);
        void perform(async () => {
          await requestBackend("instance.delete", { instanceId: selected.id });
          setSelectedId(null);
        });
      } else if (input.toLocaleLowerCase() === "n" || key.escape) {
        setConfirmDelete(false);
      }
      return;
    }

    if (input === "q") exit();
    else if (key.leftArrow) selectRelative(-1);
    else if (key.rightArrow) selectRelative(1);
    else if (input === "n") beginNewProfile();
    else if (key.delete && selected) {
      if (active) setError("Stop the instance before deleting it");
      else setConfirmDelete(true);
    } else if (input === "c") {
      if (!selected) beginNewProfile();
      else {
        setDraft({ id: selected.id, name: selected.name, config: selected.config });
        setFieldIndex(0);
        setEditing(null);
        setView("config");
      }
    } else if (input === "s" && selected && !active) void start();
    else if (input === "x" && selected && active) {
      void perform(() => requestBackend("instance.stop", { instanceId: selected.id }));
    } else if (input === "r" && selected && restartAvailable) {
      void perform(() => requestBackend("instance.restart", { instanceId: selected.id }));
    } else if (key.upArrow || key.pageUp) {
      setScrollOffset((offset) => Math.min(events.length, offset + (key.pageUp ? 10 : 1)));
    } else if (key.downArrow || key.pageDown) {
      setScrollOffset((offset) => Math.max(0, offset - (key.pageDown ? 10 : 1)));
    } else if (key.end) setScrollOffset(0);
    else if (input === "p" && displayedErrorCode === "PULL_FAILED") void start({ allowPullFailure: true });
    else if (input === "d" && displayedErrorCode === "DOCKER_DAEMON_UNAVAILABLE") void start({ startDockerDaemon: true });
  });

  const rows = process.stdout.rows ?? 24;
  if (view === "config") {
    return <ConfigView
      name={draft.name}
      draft={draft.config}
      fields={fields}
      fieldIndex={fieldIndex}
      editing={editing}
      hostInfo={hostInfo}
      directorySuggestions={directorySuggestions}
      directorySuggestionsLoading={directorySuggestionsLoading}
      directorySuggestionsError={directorySuggestionsError}
      error={error}
      readOnly={active && draft.id === selected?.id}
    />;
  }

  const logRows = Math.max(3, rows - 12);
  const visible = visibleLogEvents(events, scrollOffset, logRows);
  const logContentOffset = logWindow.hasMeasured && logContent.hasMeasured
    ? Math.max(0, logContent.height - logWindow.clientHeight)
    : 0;

  return <Box flexDirection="column" height={rows}>
    <Box justifyContent="space-between">
      <Text bold color="cyan">PrairieLearn Host Manager</Text>
      <Text color={connected ? "green" : "red"}>{connected ? "backend connected" : "reconnecting…"}</Text>
    </Box>
    <ProfileHeader instances={instances} selectedId={selectedId} />
    <StatusLine status={status} selectedId={selectedId} />
    <Text>Config: {formatConfig(selected?.config ?? null)}</Text>
    <DashboardMenu state={run?.state} hasInstance={Boolean(selected)} />
    <Text>Logs: {scrollOffset === 0 ? "following" : `${scrollOffset} lines from bottom`}</Text>
    <Box ref={logWindowRef} borderStyle="round" borderColor="gray" flexDirection="column" flexGrow={1} overflow="hidden" contentOffsetY={logContentOffset}>
      <Box ref={logContentRef} flexDirection="column" flexShrink={0}>
        {visible.length === 0 ? <Text dimColor>{selected ? "No lifecycle output for this profile." : "No profiles configured. Press n to create one."}</Text> : visible.map((event) => <LogLine key={event.seq} event={event} />)}
      </Box>
    </Box>
    {confirmDelete && selected ? <Text color="yellow">Delete “{selected.name}” and its retained logs? y confirm · n/Esc cancel · isolated databases are kept</Text> : null}
    {!confirmDelete && displayedError ? <Text color="red">{displayedError}{displayedErrorCode === "PULL_FAILED" ? " · p: retry without pull" : displayedErrorCode === "DOCKER_DAEMON_UNAVAILABLE" ? " · d: start Docker and retry" : ""}</Text> : null}
  </Box>;
}

export function canRestart(state: LifecycleState | undefined): boolean {
  return state === "running";
}

export function DashboardMenu({ state, hasInstance = true }: { state: LifecycleState | undefined; hasInstance?: boolean }): React.ReactElement {
  const active = state !== undefined && isActive(state);
  const items = hasInstance
    ? active ? ["x stop", "c view config"] : ["s start", "c configure"]
    : ["n new"];
  if (hasInstance && canRestart(state)) items.push("r restart");
  if (hasInstance) items.push("←/→ switch", "n new");
  if (hasInstance && !active) items.push("Del delete");
  items.push("↑/↓/wheel scroll", "q quit");
  return <Text dimColor>Keys: {items.join(" · ")}</Text>;
}

export function ProfileHeader({ instances, selectedId }: { instances: InstanceStatus[]; selectedId?: string | null }): React.ReactElement {
  const index = Math.max(0, instances.findIndex((instance) => instance.id === selectedId));
  const selected = instances[index];
  return selected
    ? <Text bold color="cyan">Profile: &lt; {index + 1}/{instances.length} · {selected.name} · localhost:{selected.config.port} · {selected.run?.state ?? "stopped"} &gt;</Text>
    : <Text bold color="yellow">Profile: none</Text>;
}

export function relativeInstanceId(
  instances: InstanceStatus[],
  selectedId: string | null,
  delta: number,
): string | null {
  if (instances.length === 0) return null;
  const currentIndex = Math.max(0, instances.findIndex((instance) => instance.id === selectedId));
  const nextIndex = (currentIndex + delta % instances.length + instances.length) % instances.length;
  return instances[nextIndex]!.id;
}

export function LogLine({ event }: { event: RunEvent }): React.ReactElement {
  const color = logColor(event);
  return <Box flexShrink={0}>
    <Box width={18} flexShrink={0}>
      <Text dimColor color={color}>{String(event.seq).padStart(4)} {event.phase.padEnd(12)} </Text>
    </Box>
    <Box flexGrow={1}>
      <Text color={color} dimColor={color === undefined}>{event.message}</Text>
    </Box>
  </Box>;
}

export function logColor(event: RunEvent): LogColor {
  if (/\b(?:warn(?:ing)?|deprecated|deprecation)\b/i.test(event.message)) return "yellow";
  if (
    event.phase === "failed"
    || /\b(?:error|failed|failure|fatal)\b/i.test(event.message)
    || /\bexit(?:ed)?(?: status| with)? [1-9]\d*\b/i.test(event.message)
  ) return "red";
  if (/\b(?:ready|started|running|listening|succeeded|completed|passed|connected|stopped)\b/i.test(event.message)) return "green";
  return event.source === "system" ? "cyan" : undefined;
}

export function StatusLine({ status, selectedId }: { status: SupervisorStatus | null; selectedId?: string | null }): React.ReactElement {
  const instance = status?.instances.find((candidate) => candidate.id === selectedId) ?? status?.instances[0];
  const run = instance?.run;
  const color = run?.state === "running" ? "green" : run?.state === "failed" ? "red" : "yellow";
  return <Text>
    Instance: <Text bold color={color}>{run?.state ?? "stopped"}</Text>
    {run ? ` · run ${run.runId.slice(0, 8)}` : ""}
  </Text>;
}

export function ConfigView(props: {
  name?: string;
  draft: LaunchConfig;
  fields: ConfigField[];
  fieldIndex: number;
  editing: EditingField | null;
  hostInfo: Record<string, unknown> | null;
  directorySuggestions?: DirectorySuggestion[];
  directorySuggestionsLoading?: boolean;
  directorySuggestionsError?: string | null;
  error: string | null;
  readOnly?: boolean;
}): React.ReactElement {
  const editingDirectory = props.editing ? isDirectoryField(props.draft, props.editing.key) : false;
  const suggestions = props.editing?.key === "branch"
    ? branchSuggestions(props.hostInfo, props.editing.value)
    : editingDirectory
      ? props.directorySuggestions ?? []
      : [];
  const suggestionIndex = Math.min(props.editing?.suggestionIndex ?? 0, suggestions.length - 1);
  const selectedField = props.fields[props.fieldIndex];
  const profileDraft: ProfileDraft = { id: null, name: props.name ?? "", config: props.draft };
  return <Box flexDirection="column">
    <Text bold color="cyan">Configuration · {props.name ? `${props.name} · ` : ""}{props.draft.mode}</Text>
    {props.readOnly
      ? <Text color="yellow">Stop current run to modify config · ↑/↓ select · any other key back</Text>
      : <Text dimColor>s switch to {props.draft.mode === "git" ? "docker" : "git"} · ↑/↓ select · Enter edit/toggle · Tab complete path · c confirm · q/Esc cancel</Text>}
    <Box marginTop={1} flexDirection="column">
      {props.fields.map((field, index) => (
        <Text key={field.key} color={index === props.fieldIndex ? "cyan" : undefined}>
          {index === props.fieldIndex ? "›" : " "} {field.label}: {props.editing?.key === field.key ? `${props.editing.value}█` : displayProfileFieldValue(profileDraft, field.key)}
        </Text>
      ))}
    </Box>
    {props.editing?.key === "branch" || editingDirectory ? <Box marginLeft={2} flexDirection="column">
      <Text dimColor>{editingDirectory ? "Type to filter · arrows select · Tab complete · Enter accept" : "Type to filter · arrow keys or Tab select · Enter accept"}</Text>
      {suggestions.map((suggestion, index) => (
        <Text key={`${suggestion.hint}:${suggestion.value}`} color={index === suggestionIndex ? "cyan" : undefined}>
          {index === suggestionIndex ? "›" : " "} {suggestion.label} <Text dimColor>· {suggestion.hint}</Text>
        </Text>
      ))}
      {editingDirectory && props.directorySuggestionsLoading ? <Text dimColor>  Loading directories…</Text> : null}
      {editingDirectory && !props.directorySuggestionsLoading && props.directorySuggestionsError ? <Text color="red">  {props.directorySuggestionsError}</Text> : null}
      {editingDirectory && !props.directorySuggestionsLoading && !props.directorySuggestionsError && suggestions.length === 0 ? <Text dimColor>  No matching directories</Text> : null}
    </Box> : null}
    {props.hostInfo && selectedField?.key === "branch" && props.editing?.key !== "branch" ? <Box marginTop={1} flexDirection="column">
      <Text dimColor>Current branch: {String(props.hostInfo.currentBranch ?? "unknown")}</Text>
      <Text dimColor>Available branches: {formatBranches(props.hostInfo)}</Text>
    </Box> : null}
    {props.hostInfo && selectedField?.key === "force_rebuild" ? <Text dimColor>Dependencies: {formatDependencies(props.hostInfo.dependencies)}</Text> : null}
    {props.hostInfo && selectedField?.key === "local_only" ? <Text dimColor>Network: {props.hostInfo.internetAvailable ? "online" : "offline"}</Text> : null}
    {props.hostInfo && selectedField?.key === "image" ? <Text dimColor>Images: {formatDockerImages(props.hostInfo.dockerImages)}</Text> : null}
    {selectedField?.key === "isolated_database" ? <Text dimColor>Creates and reuses a profile-specific PostgreSQL database; Redis remains shared.</Text> : null}
    {props.error ? <Text color="red">{props.error}</Text> : null}
  </Box>;
}

export function configFields(config: LaunchConfig): ConfigField[] {
  if (config.mode === "git") {
    return [
      { label: "PrairieLearn path", key: "path", kind: "directory" },
      { label: "Branch/ref (blank=current)", key: "branch", kind: "text" },
      { label: "Host port", key: "port", kind: "text" },
      { label: "Isolated database", key: "isolated_database", kind: "boolean" },
      { label: "Force dependency rebuild", key: "force_rebuild", kind: "boolean" },
      { label: "Local checkout only", key: "local_only", kind: "boolean" },
      { label: "Watch upstream", key: "watch_upstream", kind: "boolean" },
    ];
  }
  return [
    { label: "Course path", key: "course_path", kind: "directory" },
    { label: "Image", key: "image", kind: "choice", choices: ["us-prod-live", "latest"] },
    { label: "Host port", key: "port", kind: "text" },
    { label: "Jobs temp directory", key: "tmp_dir", kind: "directory" },
    { label: "Local image only", key: "local_only", kind: "boolean" },
  ];
}

function profileFields(config: LaunchConfig): ConfigField[] {
  return [{ label: "Profile name", key: "name", kind: "text" }, ...configFields(config)];
}

function defaultDockerConfig(port = 3000): LaunchConfig {
  return {
    mode: "docker",
    course_path: ".",
    image: "us-prod-live",
    port,
    tmp_dir: "/tmp",
    local_only: false,
    quiet: false,
  };
}

function displayProfileFieldValue(draft: ProfileDraft, key: string): string {
  if (key === "name") return draft.name;
  return displayFieldValue(draft.config, key);
}

function displayFieldValue(config: LaunchConfig, key: string): string {
  if (key === "watch_upstream" && config.mode === "git") return String(!config.no_watch_upstream);
  const value = (config as unknown as Record<string, unknown>)[key];
  return value === null ? "" : String(value ?? "");
}

function updateProfileTextField(draft: ProfileDraft, key: string, value: string): ProfileDraft {
  if (key === "name") return { ...draft, name: value };
  return { ...draft, config: updateTextField(draft.config, key, value) };
}

function updateTextField(config: LaunchConfig, key: string, value: string): LaunchConfig {
  if (config.mode === "git" && key === "branch") {
    const branch = value.trim().replace(/^origin\//, "");
    return { ...config, branch: branch || null };
  }
  if (key === "port") return { ...config, port: Number(value) } as LaunchConfig;
  return { ...config, [key]: value } as LaunchConfig;
}

function isDirectoryField(config: LaunchConfig, key: string): boolean {
  return configFields(config).some((field) => field.key === key && field.kind === "directory");
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

export function formatConfig(config: LaunchConfig | null): string {
  if (!config) return "not configured";
  return config.mode === "git"
    ? `git ${displayHomeRelativePath(config.path)}${config.branch ? ` @ ${config.branch}` : ""} (:${config.port})`
    : `docker ${displayHomeRelativePath(config.course_path)} (${config.image}, :${config.port})`;
}

function formatBranches(info: Record<string, unknown>): string {
  const local = Array.isArray(info.localBranches) ? info.localBranches : [];
  const remote = Array.isArray(info.remoteBranches) ? info.remoteBranches : [];
  const branches = [...new Set([...local, ...remote].map(String))].slice(0, 8);
  return branches.length > 0 ? branches.join(", ") : "none detected";
}

export function branchSuggestions(info: Record<string, unknown> | null, query: string): BranchSuggestion[] {
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

export function visibleLogEvents(events: RunEvent[], scrollOffset: number, rows: number): RunEvent[] {
  const end = Math.max(0, events.length - scrollOffset);
  return events.slice(Math.max(0, end - rows), end);
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
