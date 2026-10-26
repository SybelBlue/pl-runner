# PrairieLearn Runner

`pl` is a local PrairieLearn host manager with a full-screen terminal dashboard and a headless CLI. A per-user backend owns host inspection and lifecycle policy, while a durable worker keeps the active PrairieLearn process and its logs alive when clients or the backend exit.

Requires macOS or Linux and Node.js 22 or newer.

## Usage

```console
pl                         # open the dashboard
pl status                  # concise noninteractive status
pl start                   # start the saved dashboard configuration
pl run --path ~/PrairieLearn --detach
pl docker ./exampleCourse --detach
pl logs --follow
pl stop
pl backend status
pl backend stop            # leaves a managed instance running
```

`pl run` and `pl docker` accept the existing Git and Docker options. Add `--json` for automation. Attached start commands stream lifecycle logs; Ctrl+C detaches without stopping PrairieLearn. Use `pl stop` for an explicit stop.

## Dashboard

- `s`: start the saved configuration
- `x`: stop the managed instance
- `r`: restart an active or failed run
- `c`: configure Git or Docker mode
- `f`: filter all/stdout/stderr output
- arrow keys/PageUp/PageDown: scroll logs
- `End`: resume auto-follow
- `q`: exit without stopping PrairieLearn

Configuration and runtime state live below `$XDG_STATE_HOME/prairielearn` (or `~/.local/state/prairielearn`). The v0.2 state store imports a valid legacy `last-config.yaml` once without deleting it. Logs retain the active run and five completed runs, with a 10 MiB cap per run.

See [docs/architecture.md](docs/architecture.md) for the process, protocol, recovery, and security model.

## Development

```console
pnpm install
pnpm run typecheck
pnpm test
pnpm build
```

Tests use isolated runtime/state directories and fake host commands; they do not require a real PrairieLearn checkout or Docker daemon.
