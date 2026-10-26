# TUI/backend architecture

Status: current multi-instance architecture.

## Boundaries

```text
Ink TUI ─┐
CLI ─────┴─ versioned JSON over a Unix socket ─→ supervisor ─┬→ durable worker ─→ process group
                                                    │        ├→ durable worker ─→ process group
                                               profiles/state└→ …             event logs/state
```

- The TUI and CLI render state and submit intent. They do not inspect Git, Docker, dependencies, the network, or managed processes.
- One per-user supervisor validates configuration, serializes lifecycle mutations, performs host discovery, and serves concurrent observers.
- One detached worker owns each run. Workers perform preparation, own child process groups, capture output, watch upstream Git state, and remain alive if the supervisor exits.
- Named profiles have unique host ports and independent current runs and histories. Any number can be active concurrently. A run contains an immutable configuration snapshot.

## Protocol

Supervisor protocol v2 uses newline-delimited JSON on a permission-restricted Unix-domain socket. Every request contains `protocol`, `id`, `type`, and `payload`; every response repeats the ID and contains either `result` or a structured `error`. Long-lived log connections bind to an instance and immutable run ID before receiving sequenced `log` events.

The supervisor supports handshake/capabilities, aggregate status, profile create/update/delete, host inspection, profile-scoped start/stop/restart, run-scoped log tail/subscription, approved Docker-daemon startup, and backend status/shutdown. The internal worker protocol remains v1 and supports status and stop so a v2 supervisor can recover workers launched before an upgrade.

Protocol input is runtime-validated. A new client gracefully shuts down a legacy v1 supervisor, leaves its worker running, starts v2 on the same socket, migrates state, and reconnects to that worker.

## Lifecycle and recovery

The lifecycle is `stopped → preparing → starting → running → stopping → stopped`, with `failed` as the terminal error state. A clean natural exit is `stopped`; preparation errors and nonzero exits are `failed`.

An explicit stop sends SIGINT to the active process group, SIGTERM after 10 seconds, and SIGKILL after 15 seconds. Closing a TUI or attached CLI only disconnects that client. Stopping the supervisor leaves the worker and PrairieLearn running.

Workers write state atomically and append sequenced lifecycle/stdout/stderr events. A restarted supervisor reconciles every current record from worker state files and control sockets. Missing worker state for a previously active run becomes a typed recovery failure for that profile without affecting others. A host restart never automatically relaunches profiles.

Git workers write a private effective PrairieLearn config into the run directory. It preserves PrairieLearn's normal config-source precedence and overrides `serverPort`. With database isolation enabled, preparation starts support services, creates a stable profile-specific PostgreSQL database if absent, and overlays `postgresqlDatabase`. Docker workers map the configured host port to container port 3000.

## Storage and security

- Runtime directories are mode `0700`; sockets and state files are mode `0600`.
- Stale sockets are removed only when they are sockets owned by the current UID.
- The v3 JSON state store uses atomic rename and leaves v2 JSON and legacy YAML sources untouched after migration.
- The event log sanitizes ANSI/OSC and other terminal control sequences before persistence.
- Logs retain each profile's active run and five completed runs, bounded to 10 MiB per run. Profile deletion removes those run directories but not databases.
- There is no network listener, remote client, cross-user access, elevation, or arbitrary shell-command endpoint.

## Deliberate exclusions

Windows, remote management, public protocol compatibility, automatic isolated-database deletion, OS login services, application-level health probes, and automatic post-reboot restart remain out of scope.
