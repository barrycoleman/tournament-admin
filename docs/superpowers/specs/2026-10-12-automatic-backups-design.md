# Automatic Backups — Design

**Status:** approved in brainstorming 2026-10-12.

**Builds on:** the core architecture spec (§7 "Backups", §10 gap review), the tournament picker (`server/CLAUDE.md`, "Tournament picker") and the squashed migration baseline (`server/CLAUDE.md`, "Database migrations").

**Replaces:** the core spec's idea of offering a restore after an unclean shutdown. SQLite in WAL mode survives a crash, and the live file holds the newest scores, so restoring after a crash would usually lose data. The integrity check in §5 covers the case that matters: a damaged file.

## 1. Problem

The whole event lives in one SQLite file. A bad click (deleting a session, rebuilding a schedule), a buggy release or a damaged disk can lose a day of scores. Today the only copy the server makes is the pre-migration backup, which never runs before the first release.

## 2. Goals

- The server snapshots the tournament on a timer and before risky steps, with no setup.
- An admin can see the backups, take one on demand, and restore one from the admin app.
- A damaged tournament file is detected at startup, and its backups are offered for restore.
- Backups stay readable only by the owner, because the file holds password data.

### Non-goals

- Off-machine or cloud copies.
- Restoring part of a tournament (one session, one table).
- Backups of the picker's own config file.

## 3. Taking backups

### 3.1 Where they go

- **Default folder:** `backups/<tournament file stem>/`, next to the tournament file. For `~/Documents/tournaments/spring.db` that is `~/Documents/tournaments/backups/spring/`.
- **Changing it:** the admin can set another folder on the Backups page. It is stored in the server's picker config (`server-config.json`, new key `backup_dirs`, mapping the tournament file's resolved path to a folder), not in the tournament file. That needs no schema change, a restore never reverts it, and the damaged-file screen (§5) can still find a custom folder. No entry, or blank, means the default.
- **Creating it:** the folder is created on the first snapshot if missing.
- **The picker:** it lists only `*.db` files directly in an allowed folder, so backups in a subfolder never appear there as tournaments.

### 3.2 How a snapshot is taken

- **Method:** with SQLite's online backup API (`sqlite3.Connection.backup`), never a plain file copy. It gives a complete, consistent copy while other requests write, including writes still in the WAL.
- **Writing:** into a temporary name in the backup folder, then renamed into place. A half-written file is never left under a backup's name.
- **Permissions:** the file gets the tournament file's permission bits.
- **Name:** `<stem>-<YYYY-MM-DD>-<HHMMSS>-<reason>.db`, in the server's local time, e.g. `spring-2026-10-12-143005-interval.db`. Two snapshots in the same second get a `-2` suffix.
- **Reasons:**
  - `interval`;
  - `manual`;
  - `before-restore`;
  - the risky-step reasons in §3.4.

### 3.3 Interval snapshots

- **Timing:** a background task, started in the app's lifespan, wakes every 5 minutes.
- **Change detection:** it takes a snapshot only if the newest `audit_log` id is greater than the one recorded at the last snapshot of any reason. Every write is audited, so this sees every change. At startup the current newest id is the baseline, so a restart alone takes no snapshot; the first change after it does.
- **Off the event loop:** the snapshot runs in a worker thread.
- **Retention:** after each `interval` snapshot, only the newest 50 `interval` files in the folder are kept, and older ones are deleted. Files with any other reason are never deleted automatically.

### 3.4 Snapshots before risky steps

These requests take a snapshot after their own checks pass and before they write anything:

| Step | Reason |
|---|---|
| `POST /api/event/active-session` | `before-active-session` |
| `POST /api/schedule` (not a dry run) | `before-schedule` |
| `DELETE /api/schedule` (clears a round, with its scores) | `before-clear-schedule` |
| `POST /api/sessions/{id}/qualification/finalize` and `.../reopen` | `before-qualification` |
| `POST /api/finals/start`, `DELETE /api/finals/{id}` | `before-finals` |
| `DELETE /api/sessions/{id}` | `before-delete-session` |
| `POST`/`DELETE /api/event/game-plugin` (a real change, not a dry run or no-op) | `before-game-plugin` |
| `POST /api/sessions/{id}/awards/finalize` with `confirm` | `before-awards-finalize` |

- **A failed snapshot never blocks the step.** The step goes ahead, and the failure is recorded as the last error (§3.5).

### 3.5 Errors

- **Logging:** a failed snapshot (disk full, folder not writable, a bad custom folder) is logged.
- **Reporting:** it is kept in memory as `last_error {message, at}`, shown on the Backups page until the next successful snapshot clears it.
- **Never affects requests:** an interval failure does not stop the timer.

### 3.6 API (admin only; any other role gets 403)

- **`GET /api/backups`:** returns:
  - `folder`, the resolved path;
  - `folder_is_default`;
  - `last_backup_at`;
  - `last_error`;
  - `backups`: `[{filename, created_at, reason, size_bytes}]`, newest first.

  Only files whose names parse as backups of this tournament are listed.
- **`POST /api/backups`:** takes a `manual` snapshot now. Returns the new entry (201), or 500 with the error detail.
- **`PUT /api/backups/folder`:** body `{folder: string | null}`.
  - Null or blank resets to the default.
  - A path must be absolute, and the server must be able to create and write to it, or 422 with the reason.
- **`POST /api/backups/{filename}/restore`:** §4.

## 4. Restoring

### 4.1 Flow

1. **Find it.** `POST /api/backups/{filename}/restore` looks the file up in the backup folder only. A name with a path separator, or one not listed by `GET /api/backups`, is a 404.
2. **Check the backup.** The server opens it read-only and runs `PRAGMA quick_check` and the schema comparison from `migrations._reflected_schema_matches_models`. If either fails, it returns 409 with "This backup is damaged." or "This backup was made by an older build and can't be restored." Nothing changes.
3. **Save the current state.** It takes a `before-restore` snapshot of the current file. If that fails, the restore is refused with 500, because the current state could not be saved.
4. **Record and restart.** It writes `pending_restore {target, source}` to the picker config and returns 202 `{status: "restarting"}` (the picker's existing `RestartingResponse`). It then restarts the process with the existing delayed `os.execve` restart used by the picker.
5. **Swap at startup.** On startup, before any engine opens the file, `_startup()` sees `pending_restore` whose `target` is the path it is about to open. It:
   1. copies `source` over `target`;
   2. deletes `target`'s `-wal` and `-shm` files;
   3. sets the copy's permission bits from the old file;
   4. clears `pending_restore`.

   A pending restore whose target is a different path is cleared and ignored. If the copy fails, the original file is untouched, because the copy goes to a temporary name and then a rename. The error is printed, and startup continues with the original file. The same applies to a pending restore skipped as stale: the reason is also saved as `last_restore_error` (`{message, at}`) in the picker config, `GET /api/backups` returns it once as `restore_error` and clears it, so the admin page can say why the data didn't change.
6. **Reload.** The admin app waits with `useRestartPoll` and reloads. Because the server restarts from the normal app into the normal app, the existing "is the picker route there?" check can't tell old from new. `GET /api/time-sync` (no login) therefore also returns a `boot_id`, a random id fixed for the life of the process. The page reads it before restoring, and `useRestartPoll`'s new `"restarted"` target waits until a different `boot_id` answers.

### 4.2 What a restore takes back

Everything goes back to the backup's moment, including the following, and the confirm dialog says so:

- auth sessions, so any device, this one included, may need to log in again;
- admitted scoring devices;
- role passwords.

The backup folder setting is not in the tournament file, so it stays as it is.

## 5. Damaged file at startup

- **The check:** `_startup()` runs `PRAGMA quick_check` on the resolved tournament file before `create_app()`.
- **On failure:** it builds the picker app in "damaged" mode, passing the damaged path, instead of exiting.
- **`GET /api/picker/damaged`:** returns `{path, backups: [...]}` in that mode, using that file's backup folder (its custom folder from the picker config, else the default), and 404 otherwise.
- **`POST /api/picker/restore`** with `{filename}`: restores one of those backups. It runs the same checks as §4.1 steps 1-2, copies with the same temporary-name-and-rename swap, then restarts into the normal app. There is no `before-restore` snapshot; the damaged file is instead renamed to `<stem>-<timestamp>-damaged.db` in the backup folder, so nothing is deleted.
- **Login:** these two endpoints have no login, like the rest of the picker (its accepted risk is in `server/CLAUDE.md`). They only act on the damaged file's own backups.
- **The picker page:** shows "<file> is damaged and can't be opened. Restore it from a backup." with the backup list and a Restore button per backup, above the usual picker content.

## 6. Admin UI

- **Navigation:** a new admin-only nav item **Backups**, at `/backups`.
- **Page contents:**
  - **Folder:** the resolved path, with **Change** (an input plus Save, showing the server's 422 reason) and **Use default** (hidden while the default is in use).
  - **Status:** "Last backup at 2:35 PM", or "No backups yet". If `last_error` is set, an `alert alert-danger` with the message and time.
  - **Restore error:** if `restore_error` is returned (a startup swap failed or was cancelled), an `alert alert-danger` says "The last restore didn't complete: <reason>".
  - **Back up now:** a button. It shows the server error if the backup fails.
  - **Backups table,** newest first: time (local), reason (translated label), size, and **Restore**.
- **Restore dialog:** `ConfirmDialog` with:
  - "Restore the backup from {time}? Everything after it is replaced. The current state is saved as a backup first.";
  - "Every device reconnects. Any device, this one included, may need to log in or be admitted again.";
  - confirm button **Restore**.

  On 202 it shows "Restoring…", disables the page's buttons, and calls `useRestartPoll`. A 409 shows its detail in the dialog.
- **Refresh:** the list refetches on focus and after Back up now. No realtime event is needed.
- **Strings:** every string goes through i18n, in English and Chinese.

## 7. Testing

### Server (pytest)

- **Snapshots:**
  - a snapshot is a valid copy that includes writes still in the WAL;
  - it has the source's permission bits;
  - it gets the right name;
  - a same-second clash gets a suffix.
- **Interval:**
  - an interval with no new audit rows takes nothing; one after a write takes one;
  - retention keeps 50 `interval` files and never deletes other reasons.
- **Risky steps:** each step in §3.4 creates its snapshot. A dry run or no-op creates none. A failing snapshot (folder not writable) still lets the step succeed and sets `last_error`.
- **API:**
  - list, back up now and folder change, including the 422 cases and the reset to the default;
  - 403 for non-admin roles on every endpoint.
- **Restore:**
  - a filename with a separator or not in the list gets 404;
  - a damaged backup or one with a mismatched schema gets 409, and nothing changes;
  - a good backup takes a `before-restore` snapshot, writes `pending_restore` and schedules the restart (restart patched out);
  - the startup swap replaces the file and removes the WAL files;
  - a pending restore for another path is ignored;
  - a failed copy leaves the original.
- **Damaged startup:**
  - a corrupted file starts the picker in damaged mode, and `GET /api/picker/damaged` lists its backups;
  - restoring through the picker swaps the file and keeps the damaged copy.

### Admin unit (Vitest)

- The Backups page:
  - its folder states, status and error states;
  - Back up now;
  - the restore dialog's text and its 409 error.
- The picker's damaged-file section.

### Playwright

On an isolated server (ports 8131/5191), because a restore restarts the server:

- **Golden path:**
  1. back up now;
  2. rename a team;
  3. restore that backup;
  4. after the reload, the old name is back and a `before-restore` backup is listed.
- **Folder:** changing the backup folder to a new path, then Back up now, lists the new backup from there, and **Use default** returns to the default folder.
