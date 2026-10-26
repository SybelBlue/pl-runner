# PrairieLearn Runner

`pl` is a local PrairieLearn host manager with a full-screen terminal dashboard and a headless CLI. A per-user backend owns named instance profiles and lifecycle policy, while one durable worker per run keeps each PrairieLearn process and its logs alive when clients or the backend exit.

Requires macOS or Linux and Node.js 22 or newer.

## Usage

```console
pl                         # open the dashboard
pl status                  # concise noninteractive status
pl run --instance main --path ~/PrairieLearn --port 3000 --detach
pl run --instance feature --path ~/PrairieLearn --branch feature --port 3001 --detach
pl docker --instance course ./exampleCourse --port 3002 --detach
pl status                  # show every configured instance
pl logs --instance feature --follow
pl stop --instance feature
pl backend status
pl backend stop            # leaves managed instances running
```

`pl run` and `pl docker` create or update a named profile and then start it. Both accept `--port <host-port>`; Docker maps that port to the image's internal port 3000. Git profiles can opt into a stable profile-specific PostgreSQL database with `--isolated-database`. This option is off by default and does not isolate Redis.

Lifecycle and log commands accept `--instance <name>`. Without it, the CLI selects the target only when exactly one profile is eligible; otherwise it lists the names and asks for an explicit selector. Add `--json` for automation. Attached start commands stream only that run's logs; Ctrl+C detaches without stopping PrairieLearn.

## Dashboard

- `Left`/`Right`: switch named profiles
- `n`: create a profile using the next free port
- `Backspace`/`Delete`: delete a stopped profile and its retained logs after confirmation
- `s`: start the selected profile
- `x`: stop the selected instance
- `r`: restart the selected running instance
- `c`: configure the selected Git or Docker profile, or view an active run's configuration read-only
- arrow keys/PageUp/PageDown or the mouse wheel over the log pane: scroll logs
- `End`: resume auto-follow
- `q`: exit without stopping PrairieLearn

Configuration and runtime state live below `$XDG_STATE_HOME/prairielearn` (or `~/.local/state/prairielearn`). The v3 state store migrates v2 state and imports a valid legacy `last-config.yaml` without deleting either source. Logs retain the active run and five completed runs per profile, with a 10 MiB cap per run. Deleting a profile never deletes its isolated PostgreSQL database.

See [docs/architecture.md](docs/architecture.md) for the process, protocol, recovery, and security model.

## Development

```console
pnpm install
pnpm run typecheck
pnpm test
pnpm build
```

Tests use isolated runtime/state directories and fake host commands; they do not require a real PrairieLearn checkout or Docker daemon.
