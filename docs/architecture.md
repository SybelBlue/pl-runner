# TUI/backend architecture

Status: current multi-instance architecture.

## Boundaries

```text
Ink TUI ─┐                  socket transport ─→ supervisor service ─┬→ durable workers → process groups
CLI ─────┴→ typed client ─→ (protocol/framing)      │               ├→ host inspection
                                                    │               └→ port/process control
                                              profiles/run state
```

- The TUI and CLI render state and submit intent. They do not inspect Git, Docker, dependencies, the network, or managed processes.
- The typed client maps every operation to its payload and result while retaining backend startup and legacy-protocol handoff.
- The socket backend owns framing, subscriptions, protocol errors, and shutdown. It delegates validated operations to one application-level supervisor service.
- The supervisor service owns profile and run behavior. One state queue serializes both worker refreshes and mutations so concurrent requests cannot overwrite newer state.
- Persistence, worker control, and host operations are injected service gateways with production implementations backed by the state store and local processes.
- One detached worker owns each run. Workers perform preparation, own child process groups, capture output, watch upstream Git state, and remain alive if the supervisor exits.
- Named profiles have unique host ports and independent current runs and histories. Any number can be active concurrently. A run contains an immutable configuration snapshot.

## Source layout

- `src/entrypoints`: executable entry modules for the CLI, backend, and worker processes.
- `src/cli`: command parsing, the typed backend client, and the Ink terminal interface.
- `src/backend`: socket handling, supervisor behavior, and persisted supervisor state.
- `src/worker`: durable worker behavior, run preparation, Docker launches, and event logs.
- `src/core`: shared domain types, instance rules, and protocol contracts.
- `src/system`: operating-system adapters and cross-cutting filesystem, process, path, and formatting utilities.

## Protocol

Supervisor protocol v3 uses newline-delimited JSON on a permission-restricted Unix-domain socket. Every request contains `protocol`, `id`, `type`, and `payload`; every response repeats the ID and contains either `result` or a structured `error`. Long-lived log connections bind to an instance and immutable run ID before receiving sequenced `log` events.

The supervisor supports handshake/capabilities, aggregate status, profile create/update/delete, host inspection, profile-scoped start/stop/restart, run-scoped log tail/subscription, approved Docker-daemon startup, and backend status/shutdown. The internal worker protocol remains v1 and supports status and stop so a v3 supervisor can recover workers launched before an upgrade.

The envelope and operation-specific payloads are runtime-validated from the same operation map used for client-side TypeScript inference. A new client gracefully shuts down a legacy v1 or v2 supervisor, leaves its workers running, starts v3 on the same socket, migrates state, and reconnects to those workers.

## Lifecycle and recovery

The lifecycle is `stopped → preparing → starting → running → stopping → stopped`, with `failed` as the terminal error state. A clean natural exit is `stopped`; preparation errors and nonzero exits are `failed`.

An explicit instance stop sends SIGINT to the active process group, SIGTERM after 10 seconds, and SIGKILL after 15 seconds. Closing a TUI or attached CLI only disconnects that client. Stopping or force-killing only the supervisor leaves the worker and PrairieLearn running. The backend manager's clean-stop action stops every active instance, waits for its worker and process group to exit, shuts down the supervisor, and exits the manager so a different runner version can start without inheriting managed processes.

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
