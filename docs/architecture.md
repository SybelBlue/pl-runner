# TUI/backend architecture

Status: accepted for v0.2.0.

## Boundaries

```text
Ink TUI ─┐
CLI ─────┴─ versioned JSON over a Unix socket ─→ supervisor ─→ durable worker ─→ process group
                                                    │               │
                                               config/state     event log/state
```

- The TUI and CLI render state and submit intent. They do not inspect Git, Docker, dependencies, the network, or managed processes.
- One per-user supervisor validates configuration, serializes lifecycle mutations, performs host discovery, and serves concurrent observers.
- One detached worker owns each run. It performs preparation, owns the child process group, captures output, watches upstream Git state, and remains alive if the supervisor exits.
- One PrairieLearn configuration can be active at a time. A run contains an immutable configuration snapshot.

## Protocol

Protocol v1 uses newline-delimited JSON on permission-restricted Unix-domain sockets. Every request contains `protocol`, `id`, `type`, and `payload`; every response repeats the ID and contains either `result` or a structured `error`. Long-lived log connections receive sequenced `log` events after their subscription acknowledgement.

The supervisor supports handshake/capabilities, status, configuration get/set, host inspection, instance start/stop/restart, log tail/subscription, approved Docker-daemon startup, and backend status/shutdown. The internal worker protocol supports status and stop.

Protocol input is runtime-validated. Package-version changes are allowed while protocol v1 remains compatible; a protocol mismatch fails without mutating host state.

## Lifecycle and recovery

The lifecycle is `stopped → preparing → starting → running → stopping → stopped`, with `failed` as the terminal error state. A clean natural exit is `stopped`; preparation errors and nonzero exits are `failed`.

An explicit stop sends SIGINT to the active process group, SIGTERM after 10 seconds, and SIGKILL after 15 seconds. Closing a TUI or attached CLI only disconnects that client. Stopping the supervisor leaves the worker and PrairieLearn running.

The worker writes state atomically and appends sequenced lifecycle/stdout/stderr events. A restarted supervisor reconciles its current record from the worker state file and control socket. Missing worker state for a previously active run becomes a typed recovery failure. A host restart never automatically relaunches the saved configuration.

## Storage and security

- Runtime directories are mode `0700`; sockets and state files are mode `0600`.
- Stale sockets are removed only when they are sockets owned by the current UID.
- The v2 JSON state store uses atomic rename and retains the legacy YAML after one-time import.
- The event log sanitizes ANSI/OSC and other terminal control sequences before persistence.
- Logs retain the active run and five completed runs, bounded to 10 MiB per run.
- There is no network listener, remote client, cross-user access, elevation, or arbitrary shell-command endpoint.

## Deliberate exclusions

Windows, multiple simultaneous instances, remote management, public protocol compatibility, OS login services, application-level health probes, and automatic post-reboot restart are outside v0.2.0.
