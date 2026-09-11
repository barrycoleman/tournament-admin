# Database Migrations — Design Spec

Status: approved for planning
Date: 2026-09-10

## 0. Project constraint

Nothing in this project's code, comments, documentation, file names, or
user-facing text may reference any real-world competition brand or product
name. All descriptions in this spec are written in neutral/generic terms
for that reason.

## 1. Purpose & scope

Every schema change across every prior phase of this project has gone
through `Base.metadata.create_all()`, which only ever adds new tables and
never alters existing ones. `server/CLAUDE.md`'s "Known, deliberate gaps"
section documents this explicitly and has, at each of the last two
schema-breaking changes (adding `Event.game_plugin_name`; three separate
changes to the `matches` table), given the same instruction: delete the
local `.db` file and let `create_all()` rebuild it fresh, because no real
deployed event data exists anywhere yet. That's been the correct call for
every phase so far, but it stops being correct the moment anyone actually
runs an event against this software and later upgrades to a newer
version — deleting the database would delete their tournament.

This phase adopts Alembic and puts real migrations in place, but scopes
the work honestly around what's actually true today: **there is no real
data anywhere against any historical schema shape.** Nothing in this
phase attempts to reconstruct migrations for the 24 tables' worth of
incremental history across every prior phase (auth, scoring-device
admission, multi-division/time-based scheduling, finals, and so on). That
would be speculative effort spent modeling data states that have never
existed. Instead:

- A single **baseline migration** captures the full current schema as it
  exists today, as Alembic revision zero.
- From this point forward, every future schema change ships as a real
  Alembic migration in the same commit as the model change that needs
  it — no more bare `create_all()` schema changes.
- Migrations run **automatically at server startup** — this project has
  consistently prioritized a zero-friction "download and try it"
  experience for a non-technical event organizer, and there is no
  separate "open a terminal and run a command first" moment in the
  standalone-executable distribution this project is aimed at (design
  spec §7 of the master spec).
- A `.db` file is automatically backed up immediately before any
  migration actually runs — the first piece of the master spec's
  already-planned "automatic backups before risky transitions," and a
  schema migration is about as risky as this project's transitions get.
- A pre-Alembic `.db` file that doesn't already match the current
  baseline schema exactly (some older, partial, untracked schema) is not
  a case this phase builds a migration path for — the server refuses to
  start and tells the operator to delete the file, exactly matching
  every prior phase's own established convention. This is not a new
  burden; it's the same answer this project has already given twice.

In scope:
- Adopting Alembic (`src/tournament_server/_alembic/`, `server/alembic.ini`)
  with `env.py` reading the database URL dynamically from
  `Settings.from_env()`. The script directory lives *inside* the
  installed package, not at the conventional project-root `alembic/`
  location a bare `alembic init` would suggest — packaging-readiness
  (§6/§8) requires it be addressable via `importlib.resources`, which
  only works for files inside an actual installed package.
  `server/alembic.ini` stays at the project root as a dev-time
  convenience for hand-running `alembic revision --autogenerate`; the
  running application never reads it.
- One baseline migration (`versions/`) that creates every table the
  current SQLAlchemy models declare.
- A schema-version check that runs at `create_app()` time (shared by both
  the real server and every test fixture, since they're the same entry
  point): detect the database's current state, and either apply pending
  migrations, stamp an already-matching pre-Alembic database as baseline,
  or refuse to start with a clear error.
- The automatic pre-migration backup.
- A `tm migrate` CLI subcommand as a manual/scriptable equivalent of the
  same check-and-apply step.
- Packaging-readiness: Alembic invoked via its Python API (never by
  shelling out to an `alembic` binary), migration scripts/config loaded
  via `importlib.resources` rather than assumed-relative file paths — so
  this works unchanged once a PyInstaller-frozen executable exists, even
  though packaging itself isn't built in this phase.

Explicitly out of scope / deferred:
- Reconstructing historical migrations for any pre-this-phase schema
  shape — no real data exists at any of those shapes (see above).
- The master spec's broader "automatic timestamped snapshots on a time
  interval and before risky transitions" backup system (§7) — this phase
  only builds the one pre-migration backup, which is a strict subset,
  not the general backup subsystem.
- PyInstaller packaging itself (CI matrix, code signing, the executable
  build) — a separate future phase. This phase only avoids doing anything
  that would need rework once that phase happens.
- Any admin-UI surface for viewing migration history or triggering a
  manual migration by hand — API/CLI layer only, per this project's
  existing phase-ordering (UI phases come later).
- Downgrades (`alembic downgrade`) as a supported, tested operation — the
  backup file is the recovery mechanism for a bad migration, not a
  scripted downgrade path.

## 2. Schema-version tracking

Alembic's standard mechanism: a single-row `alembic_version` table
holding the current revision id. This project's convention of "one
process, one SQLite file per event" means there is exactly one such table
per `.db` file, tracking that file's own schema state independently of
any other event's database.

**The baseline migration** (`versions/0001_baseline.py` — an illustrative
filename; the generated migration's actual hash-based filename is fine)
is generated once, up front, via `alembic revision --autogenerate` run
against a genuinely empty database (an already-`create_all()`'d database
would diff as empty against matching metadata, producing no migration at
all), then reviewed by hand before being committed. It creates all 24
tables this project's models currently declare (`alliances`,
`alliance_teams`, `audit_log`, `auth_sessions`, `bracket_alliances`,
`bracket_alliance_teams`, `bracket_matchups`, `divisions`, `events`,
`fields`, `field_sets`, `finals_brackets`, `finals_results`, `matches`,
`sessions`, `session_participation`, `rankings`, `ranking_configurations`,
`role_credentials`, `schedule_generations`, `score_records`,
`scoring_devices`, `signing_keys`, `teams`) exactly as they exist today —
this is a snapshot, not a replay of history. `audit_log` is declared
directly on `Base` in `audit.py`, outside the `models/` package, but is
always imported by the running app and therefore part of the real schema
this baseline must capture.

## 3. Startup flow

A new function, `ensure_schema_current(engine: Engine, db_path: str) ->
None`, replaces the current `init_db(engine)` call in `create_app()`.
It runs once per `create_app()` invocation, before the app starts serving
requests (and before test fixtures hand back a `TestClient`, since they
share this same code path):

1. **Does `alembic_version` exist in this database?**
   - **No**, and the database is otherwise completely empty (no
     tables at all — a brand-new file) → this is a fresh install. Apply
     every migration from scratch (`alembic upgrade head`), which for
     today's history is just the one baseline migration.
   - **No**, but the database already has tables → this is a
     pre-Alembic database. Compare its live schema (via SQLAlchemy
     `Inspector`) against `Base.metadata`'s declared tables and columns:
     - **Exact match** → stamp it at the baseline revision
       (`alembic stamp head`) without re-running the baseline migration's
       `CREATE TABLE` statements (they'd fail against tables that already
       exist). This is the expected case for every existing dev/test
       database created against today's models.
     - **Any mismatch** (missing or extra table, missing or extra
       column) → raise a startup error naming the mismatch and stop
       before the app finishes constructing:
       ```
       ERROR: <db_path>'s schema doesn't match any known version
       (pre-Alembic, and doesn't match the current baseline schema).
       No migration path exists for this file. If it holds no data you
       need, delete it and restart to create a fresh one.
       ```
   - **Yes** → this database is already Alembic-tracked. Compare its
     current revision to the latest available migration:
     - **Already at head** → nothing to do.
     - **Behind head** → back up the file (§4), then
       `alembic upgrade head`.
2. Return control to `create_app()`, which proceeds exactly as it does
   today (discovering plugins, registering routers, etc.).

`ensure_schema_current` is the only place any of this logic lives —
`create_app()` itself just calls it in place of today's `init_db(engine)`
call, keeping the split between "how do I get to a current schema" and
"how do I wire up the app" clean.

## 4. Pre-migration backup

Immediately before step 3's "behind head" branch actually calls
`alembic upgrade head` (never for the "already at head," "fresh install,"
or "stamp and go" branches — there's nothing to protect against in those
cases), copy the `.db` file to
`<db_path>.pre-migration-<UTC timestamp>.bak` (e.g.
`tournament.db.pre-migration-20260910-143022.bak`), using a plain
filesystem copy of the file — SQLite's own backup API isn't needed here
since the engine hasn"t started serving requests yet and nothing else has
the file open for writing at this point. No retention/cleanup policy for
these backup files in this phase (see §9) — they accumulate; an operator
can delete old ones manually.

## 5. `tm migrate` CLI subcommand

Added to the existing `tm` CLI (`src/tournament_server/cli.py`, alongside
`test-plugin`): `tm migrate [--db-path PATH]` (defaulting to
`Settings.from_env().db_path`, matching how the server itself resolves
its database path). Runs the exact same `ensure_schema_current` function
the server calls automatically at startup, and prints what it did (in
sync already / stamped as baseline / applied N migrations / refused with
the schema-mismatch error above). This exists for scripting, Docker
entrypoints, or an operator who wants to migrate a database before
switching versions without needing to start the full server — it is not
required for normal operation, since startup already does this
automatically.

## 6. Packaging-readiness

Two choices made now, specifically so adopting Alembic doesn't need
rework once PyInstaller packaging (a separate future phase) exists:

- **Invoke Alembic via its Python API**
  (`alembic.command.upgrade(alembic_cfg, "head")`,
  `alembic.command.stamp(alembic_cfg, "head")`), never by shelling out to
  an `alembic` command-line binary. A frozen executable can't assume a
  separate `alembic` binary is reachable on `PATH`; the Python API has no
  such dependency since Alembic itself is just an importable library this
  project already depends on.
- **Load migration scripts and config via `importlib.resources`**, not a
  path built by hand relative to `__file__` or the working directory —
  the same class of fragility this project has already hit once (the
  plugin system's `TOURNAMENT_PLUGINS_ROOT` default resolves relative to
  wherever the process was launched, a documented packaging-phase gap per
  the master spec's §10). `env.py`'s `Config` object gets its
  `script_location` resolved this way so it works identically whether
  running from a source checkout or a bundled executable.

## 7. Test suite integration

`create_app()` is the single entry point both the real server and every
test fixture (`client`, `cooperative_client`, `captain_pick_client`, and
the handful of tests that construct their own `TestClient` directly)
already share. Rather than special-case "tests use `create_all()`,
production uses Alembic" — which would let the two silently drift apart
with nothing to catch it — `ensure_schema_current` runs unconditionally
for every `create_app()` call, test or production. Every test in the
~319-test suite therefore already exercises the real migration path
(specifically, the "fresh install, apply everything from scratch" branch,
since each test builds a brand-new temp-file SQLite database) on every
run, which is what keeps the baseline migration and the live models
guaranteed to match — a manual "did I remember to update both" step is
never the only thing standing between them.

## 8. File layout & dependencies

- **New dependency**: `alembic` (added to `pyproject.toml`'s main
  `dependencies`, not `dev` — it's needed at runtime, not just for
  testing, since migrations run automatically at startup).
- `server/alembic.ini` — Alembic's config file, at the project root as a
  dev-time convenience only (see §1); its `script_location` points into
  the package. `sqlalchemy.url` is left blank/unused here; `env.py`
  overrides it programmatically from `Settings.from_env().db_path` so the
  already-existing `TOURNAMENT_DB_PATH` environment variable keeps being
  the single source of truth for where the database lives.
- `src/tournament_server/_alembic/env.py` — the environment script
  Alembic runs on every invocation; imports `tournament_server.models`
  and `tournament_server.audit` (registering all tables against
  `Base.metadata`, exactly like `app.py` already does — `audit_log` is
  declared on `Base` in `audit.py`, outside `models/`) and points at the
  dynamically-resolved database URL.
- `src/tournament_server/_alembic/script.py.mako` — Alembic's default
  migration template, unmodified.
- `src/tournament_server/_alembic/versions/` — one file per migration,
  starting with the single baseline migration this phase adds.
- `src/tournament_server/migrations.py` (new) — `ensure_schema_current`
  and the pre-migration backup helper live here, not inline in `app.py`,
  matching this project's existing pattern of keeping `app.py` a thin
  wiring layer (compare `audit.py`, `device_auth.py`).

## 9. Testing

**New coverage**, all exercised via real temp-file SQLite databases (no
mocking), matching this project's testing policy:
- A brand-new, empty `.db` file: `create_app()` succeeds, and the
  resulting database has every table `Base.metadata` declares plus an
  `alembic_version` table at the head revision.
- A pre-Alembic database created via a raw `Base.metadata.create_all()`
  call (simulating a database from an old version of this project,
  before this phase existed) that exactly matches the current schema:
  `create_app()` succeeds, stamps it at head, and does **not** attempt to
  re-run the baseline migration's `CREATE TABLE` statements (which would
  fail against existing tables).
- A pre-Alembic database with a schema that does **not** match (e.g.
  missing one column from one table, simulating genuinely old data):
  `create_app()` raises the documented error and does not start.
- An already-Alembic-tracked database sitting one migration behind head
  (simulated by constructing a second, throwaway "next" migration in the
  test itself): `create_app()` applies it, and a backup file matching the
  `<db_path>.pre-migration-<timestamp>.bak` naming pattern now exists
  containing the pre-migration schema.
- An already-Alembic-tracked database already at head: `create_app()`
  succeeds and does **not** create a backup file (nothing was migrated).
- `tm migrate` (via the CLI's existing test pattern, calling `cli.main`
  directly) reports each of the above outcomes correctly and exits 0 for
  every case except the schema-mismatch refusal, which exits non-zero.
- A drift-detection test: generate a migration diff via Alembic's
  autogenerate machinery between a database built by `alembic upgrade
  head` (running only the checked-in migrations) and a database built by
  `Base.metadata.create_all()`, and assert the diff is empty. This is
  the test that would fail the moment a future phase changes a model
  without also writing the matching migration — the single guard against
  the two ever silently diverging.

## 10. Deferred / open items

- Reconstructing migrations for any pre-this-phase schema shape — no
  real data exists at any of those shapes, per §1.
- The master spec's general "automatic timestamped snapshots on an
  interval and before other risky transitions" backup system (§7 of the
  master spec) — only the one pre-migration backup is built here.
- PyInstaller packaging itself — a separate future phase; this phase only
  avoids choices that would need rework once it happens.
- Backup file retention/cleanup — backups accumulate with no automatic
  pruning in this phase.
- `alembic downgrade` as a supported, tested rollback path — the backup
  file is the recovery mechanism, not a scripted downgrade.
- Any admin-UI surface for migration status/history.
