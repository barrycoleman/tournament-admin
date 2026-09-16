# Multi-Tournament Picker Layer — Design

## Problem

The server process is hardcoded to exactly one SQLite tournament file at
startup: `Settings.from_env()` always resolves a concrete `db_path` (the
`TOURNAMENT_DB_PATH` env var, or the hardcoded default `./tournament.db`),
and `create_app()` unconditionally calls `ensure_schema_current(engine,
settings.db_path)` on whatever that path is. There is no concept of "the
server is running but no tournament has been chosen yet" anywhere in the
architecture, and no persistent state describing where tournament files
live on disk — nothing can be stored inside a tournament's own SQLite file
before that file exists.

This blocks the very first thing a new admin needs to do: start the
server for the first time and either create a new tournament or open one
that already exists, without a role password (none exist until a
tournament is created) and without needing to hand-edit an env var or
config file before the UI is usable at all.

## Goals

- On a fresh server start with no tournament resolvable, the admin UI
  offers exactly two actions: **Create New Tournament** and **Open
  Existing Tournament** — no login required at this stage.
- Tournament files live on the *server's* filesystem, browsed through a
  server-side listing API — never a raw client-supplied path (path
  traversal risk if the client's own filesystem were trusted, and
  meaningless in a client/server-on-different-machines deployment
  anyway).
- An admin can add a new directory to browse (e.g. a USB drive plugged
  into the server machine) from within the picker UI, and it persists for
  future use.
- Automatic pre-migration backup files never appear as if they were
  ordinary tournaments.
- Once a tournament has been opened, the server behaves exactly as it
  does today — this feature only changes what happens *before* that
  point, plus one new admin-gated "switch tournament" escape hatch.
- The existing `TOURNAMENT_DB_PATH` env var keeps working unchanged, for
  scripted/single-tournament deployments that never need the picker.

## Non-goals

- Live, no-restart tournament switching (rejected — see "Approaches
  considered" below).
- Removing a directory from the allowlist via the UI (rare enough to
  leave as a hand-edit of the config file).
- Any changes to how a tournament is created once its file path is
  chosen — `POST /api/event`'s existing unauthenticated bootstrap-role-
  password contract is untouched.
- Concurrent multi-tournament serving (still one tournament per running
  process, matching the rest of this project's architecture).
- A dedicated "restore from backup" flow. Backups are excluded from the
  normal listing (they don't match the `*.db` glob — see "Config file &
  directory allowlist" below) and rejected outright if opened directly,
  satisfying the "never appear as if they were ordinary tournaments"
  goal without new API surface. An admin who wants to restore one
  renames/copies the `.pre-migration-*.bak` file to end in `.db` outside
  the app, after which it opens normally as an existing tournament. A
  real in-app restore flow is a reasonable future addition, not part of
  this plan.

## Approaches considered

**A — Separate minimal picker FastAPI app, self-exec restart into the
normal app once a path is chosen (recommended, and the one this spec
follows).** When no tournament path is resolvable, `main.py` builds a
small, distinct app exposing only the picker endpoints (list allowed
directories, list tournament files, add a directory, create, open).
Choosing a path writes it to a small JSON config file and the process
calls `os.execve` to restart itself in place — the restarted process
goes through the exact same startup logic, now resolves a path, and
boots the ordinary `create_app()` unchanged. Picker mode's route surface
is trivially small and fully unauthenticated by design, matching the
"nothing sensitive exists yet" reality; nothing about the loaded-
tournament code path changes at all.

**B — One always-running app, conditionally mounted routers, live
in-process rebind instead of a restart.** Rejected: it requires the
engine/session-factory/WebSocket-registry/match-timer machinery — none
of which was designed to be swapped out from under a running process —
to support teardown and rebuild, for no benefit over a restart in this
single-admin-per-event deployment model. A restart's few seconds of
visible "reconnecting…" is an acceptable, explicitly chosen trade-off.

**C — Picker logic embedded in the existing app via a middleware
gate.** Rejected: keeping one `create_app()` and short-circuiting most
routes until a tournament is resolved muddies `app.py`'s single
responsibility, and a mistake in which routes the gate lets through
pre-tournament is a security-relevant bug, not just a UX one. A
dedicated picker app with a small, enumerable route list is easier to
audit and gets this right by construction.

## Architecture & data flow

A new JSON config file — default path `$HOME/.tournament-admin/server-
config.json`, overridable via a new `TOURNAMENT_CONFIG_PATH` env var —
holds the state that has to exist *before* any tournament does:

```json
{
  "allowed_directories": ["/home/admin/tournaments"],
  "last_opened_path": null
}
```

`main.py`'s `_startup()` gains a resolution step before it decides which
app to build:

1. If `TOURNAMENT_DB_PATH` is set → use it directly (legacy override,
   byte-for-byte the same behavior as today).
2. Else, load the JSON config. If `last_opened_path` is set and that
   file exists → use it (auto-reopen after a crash, reboot, or ordinary
   restart).
3. Else → no tournament resolvable → build the **picker app**
   instead of the normal app.

The picker app's only job is to let the admin choose a path and then
get out of the way. Choosing "create" or "open" writes the resolved
path into `last_opened_path` and calls `os.execve(sys.executable,
sys.argv, os.environ.copy())` — the OS process image is replaced in
place (no lingering old process, no port conflict), and the new boot
runs `_startup()` again, now landing on step 2 and building the real
`create_app()` exactly as it does today, including the existing
unauthenticated `POST /api/event` flow for a genuinely new file.

"Switch Tournament" (see below) is the same mechanism run in reverse:
clear `last_opened_path`, self-exec, land back on step 3 next boot.

## Config file & directory allowlist

- First-ever run (no config file) creates one with `allowed_directories:
  []` and `last_opened_path: null`. An empty allowlist is not an error —
  the picker UI's "add a directory" step is how it gets populated.
- An optional `TOURNAMENT_DEFAULT_DIR` env var, read only when the
  config file is first created, seeds `allowed_directories` with that
  one entry — a convenience for scripted first-boot provisioning. It
  never touches an existing config.
- Every entry in `allowed_directories` is stored resolved (`Path
  .resolve()` — absolute, symlinks followed) so containment checks are
  reliable. "List tournament files in a directory" and "add a directory"
  only ever operate on a path that *is*, or is a descendant of, an entry
  in this list; a request for anything else is rejected with `403`. This
  containment check — not the client's own filesystem — is the actual
  path-traversal guard.
- Adding a brand-new top-level directory (the USB-drive case) is a
  distinct action: it only requires the path to exist and be a
  directory, since it's establishing a new root rather than being
  checked against existing roots.
- "List tournament files in a directory" is a non-recursive `*.db` glob
  (matching this project's existing `db_path` default extension
  convention) in that one directory. This glob alone already excludes
  automatic pre-migration backups, which are named `<path>.pre-
  migration-<timestamp>.bak` (see `migrations.py::_backup_path`) and so
  never match `*.db`. Each result is returned as `{filename, path,
  size_bytes, modified_at}` for display.
- Removing a directory from the allowlist has no UI (YAGNI) — an admin
  who needs that edits the JSON file directly.

## Picker API surface

All endpoints live under `/api/picker/`, served only by the
picker app, and unauthenticated (nothing sensitive exists
pre-tournament):

- `GET /api/picker/directories` → the current `allowed_directories`
  list.
- `POST /api/picker/directories` `{path}` → validates the path exists
  and is a directory, appends it to the config (idempotent if already
  present), returns the updated list. `422` if it doesn't exist or
  isn't a directory.
- `GET /api/picker/tournaments?dir=<path>` → lists tournament files
  in that directory. `403` if `dir` isn't inside `allowed_directories`;
  `404` if the directory doesn't exist (e.g. a USB drive was
  disconnected after being added — the allowlist entry itself is left
  in place in case it comes back).
- `POST /api/picker/create` `{directory, filename}` → `403` if
  `directory` isn't allowed; `409` if the resolved file already exists;
  otherwise writes `last_opened_path` to the resolved path, triggers the
  restart, returns `202`.
- `POST /api/picker/open` `{path}` → `403` if `path` isn't under an
  allowed directory or doesn't end in `.db` (rejecting a `.bak` file
  even if one were passed directly); `404` if it doesn't exist;
  otherwise writes `last_opened_path`, restarts, returns `202`.

A new `POST /api/picker/switch` endpoint is registered on the
*normal* (post-tournament) app instead, gated by the existing
`require_admin` dependency: it clears `last_opened_path` and triggers
the same restart, landing back in picker mode on the next boot.

A shared module, `tournament_server/picker_config.py`, owns reading
and writing the JSON config and the path-containment check, imported by
both the picker app and `main.py`'s `_startup()` — the allowlist
logic is not duplicated between them.

## Frontend picker UI & reconnect mechanics

The admin SPA's root loader gains a check before its existing "does an
event exist yet?" check: a call to `GET /api/picker/directories`
behind a short timeout. A `200` means the server is in picker mode,
and the loader renders a new `/picker` route instead of continuing;
a `404` means the server is running normally, and today's routing
(event-check → login → app shell) proceeds untouched.

The `/picker` screen offers exactly two actions:

- **Create New Tournament** — choose a directory (the `allowed_
  directories` list, plus an "Add a directory…" option that posts to
  `POST /api/picker/directories`), type a filename, submit to `POST
  /api/picker/create`.
- **Open Existing Tournament** — choose a directory the same way, then
  pick one of the files `GET /api/picker/tournaments` returns for it,
  submit to `POST /api/picker/open`.

Both actions, after their `202`, show a "Starting tournament…" spinner
and poll `GET /api/picker/directories` every ~500ms, waiting for it
to stop responding (old process gone) and then start responding again
with a different shape (a `404`, meaning picker mode has ended) —
at that point the screen calls `window.location.reload()`, which lands
back at the root loader and proceeds into the normal event-check/login
flow against the freshly-opened tournament. A ~15s timeout on this poll
shows an inline error ("Tournament failed to start — check the server
logs") instead of spinning forever, covering the case where the
restarted process's `ensure_schema_current` rejects the file and exits.

**Switch Tournament** is a new admin-only menu item in the authenticated
app shell, calling `POST /api/picker/switch` and reusing the same
reconnect-poll-and-reload logic.

## Error handling & edge cases

- **`os.execve` itself raises** (e.g. a broken `sys.executable`):
  caught in `_startup()`, logged via the existing `ERROR: ...` /
  `sys.exit(1)` clean-failure pattern already used for
  `NoFreePortError`/`SchemaMismatchError`.
- **The restarted process's chosen file fails its schema check**: this
  already raises `SchemaMismatchError`, which `_startup()` already
  handles by exiting cleanly — but since `last_opened_path` was written
  *before* the restart, a bare restart would otherwise loop forever
  retrying the same bad file. When a `SchemaMismatchError` occurs on a
  boot that resolved its path from `last_opened_path` specifically (not
  from `TOURNAMENT_DB_PATH`), `_startup()` clears `last_opened_path`
  from the config before exiting, so the *next* restart falls back to
  the picker instead of repeating the same failure silently.
- **Two browser tabs submit create/open at nearly the same time**: the
  second request arrives after the first has already triggered
  `execve`; it either connection-resets or hits a process that's mid-
  restart. No special handling is needed — the existing poll-and-reload
  logic on both tabs converges once the new process is up.
- **Directory becomes unavailable after being added** (e.g. a USB drive
  is pulled): `GET /api/picker/tournaments?dir=...` for it returns a
  `404` with a clear message; the allowlist entry is left in place.
- **Concurrent config-file writes**: not a real concern — only one
  server process is ever running against a given config file by
  construction — so no file locking is added.

## Testing plan

- **Backend unit tests** (`test_picker_config.py`): the config
  module's read/write/seed-on-first-run/containment-check logic,
  isolated with a temp config path — no server involved.
- **Backend integration tests** (`test_picker_api.py`): the picker
  app built directly against a temp config and temp directories,
  covering every `/api/picker/*` endpoint's success and error paths
  (disallowed directory, missing directory, filename collision, backup
  files never appearing in a listing). The real `os.execve` call is
  stubbed in these tests — it can't run inside pytest — but its
  arguments are asserted.
- **Backend integration test for `_startup()`'s resolution order**
  (extends the existing subprocess-based `test_main.py`): one case
  asserting that with no env var and no `last_opened_path`, the process
  serves `/api/picker/directories` (picker mode); one asserting
  that with `last_opened_path` set to a real temp DB file, it serves
  the normal app instead; one covering the `SchemaMismatchError` ->
  `last_opened_path` cleared case.
- **Frontend unit tests**: the `/picker` route component (directory
  picker, file picker, add-directory form, the reconnect-poll state
  machine) with the API mocked, matching this app's existing
  component-test conventions.
- **E2E test** (`tests/e2e/tournamentPicker.spec.ts`): this flow needs its own
  isolated backend process (its own temp config and temp directory)
  rather than joining the suite's shared single-event backend, since
  it's fundamentally a pre-tournament flow. It drives an actual
  create-tournament-through-restart cycle in a real browser against a
  real restarting process — the one place the self-exec and the
  reconnect poll get proven end-to-end rather than mocked.
