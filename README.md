# pi-toolbelt

My personal toolbelt for the [pi coding agent](https://github.com/badlogic/pi-mono): tools, workflow commands, UI tweaks, and themes.

![Preview](docs/preview.png)

This is primarily built for my own workflow. You're welcome to use it too, but I may make breaking changes at any time without notice.

## Included

- ask user prompt (`ask_user`)
- todos (`todos_set`, `todos_get`)
- web search via Tavily (`web_search`)
- web fetch (`web_fetch`)
- plan mode tools and commands
- process manager / log capture for dev servers (`pi-proc` CLI + `proc_process_start`, `proc_process_list`, `proc_process_stop`, `proc_process_restart`, `proc_logs_query`, `proc_inbox_check`)
- cross-platform handover command (`/handover`)
- a custom footer

## Install

Install it with pi from git:

```bash
pi install git:git@github.com:ThilinaTLM/pi-toolbelt.git
```

For package/extension loading details, see the pi coding agent docs for packages and extensions.

## Process management with `pi-proc`

`pi-proc` is a small process manager that runs dev servers / watchers / daemons with full PTY support **and** captures their output into a structured log store the pi agent can query later. It's designed to be a drop-in replacement for the way you normally start dev servers — colors, interactive keys (Vite's `q`/`r`, Jest watch keys, etc.), and resize all keep working — while letting the agent inspect logs without you re-running anything.

### Install the shim

Inside pi:

```text
/proc-install-bin
```

This drops a `pi-proc` shim into `~/.pi/bin` and prints whether that directory is on your PATH.

### Foreground use (replaces the way you start dev servers)

```bash
pi-proc run -- pnpm dev
# shorthand for the above:
pi-proc pnpm dev
```

You get a real PTY (when `node-pty` is available — see below). All output is also written to `~/.pi/proc/runs/<runId>/`. Ctrl-C stops the run cleanly.

### Detached / named runs

```bash
pi-proc start web -- pnpm dev      # named, detached
pi-proc attach web                  # interactive attach (Ctrl-\ to detach)
pi-proc tail web -f                 # read-only follow
pi-proc logs web --errors --since 10m
pi-proc list                        # runs under this cwd (cwd + subdirs)
pi-proc list --exact                # literal cwd only
pi-proc list --all                  # everywhere on the machine
pi-proc restart web                 # stop + start with same options
pi-proc stop web                    # graceful (SIGTERM, escalates to SIGKILL)
pi-proc stop --all                  # stop all active runs in this cwd
pi-proc prune --keep 20             # delete old terminated runs
pi-proc reconcile                   # re-check pid liveness after a crash
```

The `cwd` filter is hierarchical by default: running `pi-proc list` from a
monorepo root (e.g. `/home/me/projects/mono`) surfaces runs in every
subproject (`mono/web-app`, `mono/api`, ...). Pass `--exact` if you want
literal-only matching.

A run with the same `name` in the same `cwd` is rejected by default to prevent accidental duplicates. Use `--replace` (stop + start) or `--reuse` (return the existing run) if you want different behaviour.

### How the agent sees it

When the agent is running in a project, the following tools are available:

| Tool | Purpose |
|---|---|
| `proc_process_start` | Start a dev server / watcher in the background and wait briefly for it to be ready. Returns startup logs, detected URLs, and status. Supports `onConflict: fail \| replace \| reuse`, `readyPattern`, `readyOnUrl`, `readyTimeoutMs`, `startupTailLines` (default 10, `0` suppresses), and noise filters `keepBlankLines` / `collapseProgress` (see below). |
| `proc_process_list` | List managed runs (defaults to this project's cwd, status `running`). |
| `proc_process_stop` | Stop one run by `name` or `runId`. Clean stops are recorded as `stopped`, not `failed`. |
| `proc_process_restart` | Stop + start a run with its previous command/cwd/env. Also takes `startupTailLines`. |
| `proc_logs_query` | Query captured events with smart modes (`recent`, `errors`, `warnings`, `startup`, `since_last_query`), context lines, and per-line truncation. Output `format` defaults to `'compact'` (`HH:MM:SS line`); pass `format: 'full'` for the `[label] #seq stream level:` prefix when correlating across runs. When you pass `contains` / `regex` without an explicit `mode`, the search runs across all events (mode defaults to `'recent'`); set `mode: 'errors'` explicitly to constrain a text search to error-level lines. |
| `proc_inbox_check` | Peek at queued error notifications without dispatching them. |

The `proc_process_start` response reports an accurate `Ready: yes (took NNNms)` (computed from `meta.startedAt` and `state.readyAt`) and distinguishes `Ready: not signalled within Nms (process still running).` from `Ready: no — process reached terminal status '<status>' before signalling ready.` so the agent doesn't have to second-guess whether the run is healthy.

#### Storage-layer noise filters

Two defaults keep `events.ndjson` (and thus `seq`-based cursors like `since_last_query`) honest for chatty processes:

- **`collapseProgress: true`** (default) — when a logical line contains one or more `\r` characters (Gradle, npm, pip progress bars), only the segment after the final `\r` is persisted, mirroring what a terminal would render. Pass `false` to keep every intermediate redraw.
- **`keepBlankLines: false`** (default) — events whose body is empty after ANSI stripping AND whose raw line contained at least one ANSI escape are dropped (Vite / ink cursor-move / clear-screen noise). Literal blank lines emitted by the program (no ANSI) are preserved. Pass `true` to keep redraws.

Raw `stdout.log` and `stderr.log` files remain byte-faithful regardless of these flags.

The system prompt nudges the agent to use `proc_process_start` for any long-running command instead of running it through the bash tool (which would block the session and lose the log integration).

### PTY mode and the optional native dep

`pi-proc` uses [`node-pty`](https://www.npmjs.com/package/node-pty) for PTY support. It's declared as an `optionalDependencies` entry, so install never hard-fails on a platform without prebuilt binaries. If the dynamic import fails at runtime, the supervisor logs `[pi-proc] node-pty unavailable, using pipe mode: <reason>` and falls back to plain `child_process.spawn` with pipes. In pipe mode:

- Stdout and stderr stay separate (the `proc_logs_query` `stream` filter remains useful).
- Dev servers that detect non-TTY may disable interactive keys / colors. `--force-color` (CLI) or `forceColor: true` (tool) restores colors for many tools.

In PTY mode:

- Stdout and stderr are merged into a single stream — the `stream` filter is a no-op.
- Colors and interactive keys work exactly as if you ran the command directly.
- `pi-proc attach <name>` re-attaches a detached run as if you had been there the whole time, including resize handling.

### Storage layout

```
~/.pi/proc/
  SCHEMA_VERSION
  runs/
    <runId>/
      meta.json          # immutable
      state.json         # status, pids, exit info, detected URLs
      events.ndjson      # active segment
      events.001.ndjson  # rotated segment(s)
      stdout.log
      stderr.log
      segments.json      # index of all rotated segments
      control.sock       # Unix domain socket for attach (detached runs only)
  inbox/
    <cwd-hash>/<id>.json # pending agent notifications, scoped per cwd
  cursors/
    <key-hash>.json      # since_last_query cursors
```

Bump the schema version (`store.ts:SCHEMA_VERSION`) when the layout changes incompatibly; old roots are renamed to `~/.pi/proc.bak.<UTCstamp>/` automatically on first use.

### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PI_PROC_DIR` | `~/.pi/proc` | Override the storage root. |
| `PI_PROC_ROTATE_BYTES` | `8388608` (8 MB) | Rotate the active log segment when it exceeds this size. |
| `PI_PROC_MAX_SEGMENTS` | `8` | Keep this many rotated segments per kind per run; delete older ones. |
| `PI_PROC_REPLAY_BYTES` | `32768` | How much raw output a new `attach` client receives as scrollback. |
| `PI_PROC_NOTIFY_TTL_MS` | `1800000` (30 min) | Inbox entries older than this are auto-reaped. |
| `PI_PROC_DETACH_KEY` | `0x1c` (Ctrl-\) | Single character that detaches an interactive attach. |
| `NODE_BINARY` / `NODE` | — | Used to spawn the detached supervisor when `process.execPath` is not a plain Node binary (e.g. inside the bundled `pi` binary). |

## Config

`web_search` requires:

```bash
export TAVILY_API_KEY=your_key_here
```

## Note

This repo is meant to keep pi stocked with the tools and customizations I reach for often — not to provide a stable public API or compatibility guarantees.
