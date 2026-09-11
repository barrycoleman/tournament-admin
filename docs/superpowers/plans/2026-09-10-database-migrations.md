# Database Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt real Alembic migrations, replacing this project's
`Base.metadata.create_all()`-only schema management, so a future schema
change can upgrade an existing deployed database instead of requiring it
to be deleted and recreated.

**Architecture:** A single baseline migration captures the current
24-table schema exactly as it exists today (no attempt to reconstruct
history — no real data exists at any prior schema shape). A new
`ensure_schema_current(engine, db_path)` function runs automatically at
every `create_app()` call (shared by the real server and every test
fixture): it detects a brand-new database and migrates it from scratch,
detects an existing pre-Alembic database that already matches today's
schema and stamps it as current, backs up and upgrades a database that's
genuinely behind head, or refuses to start with a clear error for
anything else. Alembic is invoked entirely through its Python API and
migration files are addressed via `importlib.resources`, so this works
unchanged once PyInstaller packaging (a separate future phase) exists.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + SQLite (existing stack). New
dependency: `alembic`.

**Spec:**
`docs/superpowers/specs/2026-09-10-database-migrations-design.md` (read
this in full before starting).

## Global Constraints

- No real-world competition brand or product name anywhere in code,
  comments, docs, file/variable/class names, or user-facing text (root
  `CLAUDE.md`).
- Every backend feature ships with pytest unit tests in the same change
  (root `CLAUDE.md` testing policy) — every task below ends with a test
  run.
- No attempt to reconstruct migrations for any pre-this-phase schema
  shape — no real data exists at any of those shapes (spec §1). The
  baseline migration is a snapshot of today's schema, not a replay of
  history.
- Migrations run **automatically** at every `create_app()` call (real
  server startup and every test fixture, since they share this one entry
  point) — no separate "run a command first" step required for normal
  operation (spec §1, §3). `tm migrate` is a manual/scriptable equivalent
  of the same check, not a requirement.
- A `.db` file gets a WAL-checkpointed, timestamped backup
  (`<db_path>.pre-migration-<UTC timestamp>.bak`) immediately before —
  and only before — an actual `alembic upgrade head` runs against an
  existing, behind-head database. Never for a fresh install or a
  stamp-and-go pre-Alembic match; there's nothing to protect in those
  cases (spec §4).
- A pre-Alembic database whose reflected schema doesn't exactly match
  `Base.metadata` refuses to start with a clear error naming the file —
  no best-effort reconciliation attempted (spec §1, §3).
- Alembic is invoked entirely through its **Python API**
  (`alembic.command.upgrade`/`.stamp`), never by shelling out to an
  `alembic` CLI binary. Migration scripts/config are addressed via
  `importlib.resources`, not a path built relative to `__file__` or the
  working directory (spec §6) — this is why the Alembic script directory
  lives *inside* the installed package
  (`src/tournament_server/_alembic/`), not at the conventional
  project-root location a bare `alembic init` would suggest.
- This is the first phase this project has adopted real migrations for
  — from here forward, every future schema change ships as a real
  migration alongside its model change, never a bare `create_all()`
  change.

---

## Task 1: Adopt Alembic — scaffolding + the baseline migration

**Files:**
- Modify: `pyproject.toml`
- Create: `src/tournament_server/_alembic/__init__.py`
- Create: `src/tournament_server/_alembic/env.py`
- Create: `src/tournament_server/_alembic/script.py.mako`
- Create: `src/tournament_server/_alembic/versions/__init__.py`
- Create: `src/tournament_server/_alembic/versions/<generated>_baseline.py`
  (filename assigned by Alembic when generated — see Step 6)
- Create: `alembic.ini`
- Test: `tests/test_alembic_baseline.py`

**Interfaces:**
- Produces: an Alembic script directory at
  `src/tournament_server/_alembic/` (addressable via
  `importlib.resources.files("tournament_server") / "_alembic"`) with one
  migration, whose `upgrade()` creates every table
  `tournament_server.db.Base.metadata` currently declares. Later tasks
  (2, 3, 4) build on this directory existing and being importable this
  way — no other task generates or edits migration files.

This task is scaffolding-heavy but produces one concrete, testable
deliverable: applying the generated migration to an empty database
produces today's full schema.

- [ ] **Step 1: Add the `alembic` dependency**

Edit `pyproject.toml`'s `dependencies` list:

```toml
dependencies = [
    "fastapi>=0.115,<1.0",
    "uvicorn[standard]>=0.32,<1.0",
    "sqlalchemy>=2.0,<3.0",
    "pydantic>=2.9,<3.0",
    "python-multipart>=0.0.9,<1.0",
    "pyjwt>=2.9,<3.0",
    "bcrypt>=4.2,<5.0",
    "alembic>=1.13,<2.0",
]
```

Also add package-data config so the non-`.py` template file is included
in any built distribution (harmless for the editable dev install this
project normally uses, but correct for a future real build):

```toml
[tool.setuptools.package-data]
"tournament_server._alembic" = ["script.py.mako"]
```

Run: `pip install -e ".[dev]"` (from `server/`, with the venv active)
Expected: `alembic` installs cleanly; `python3 -c "import alembic"`
raises no error.

- [ ] **Step 2: Create the package scaffolding**

Create `src/tournament_server/_alembic/__init__.py` (empty file — this
makes `_alembic` a discovered sub-package of `tournament_server`, which
is what makes `env.py` get included automatically in any build):

```python
```

Create `src/tournament_server/_alembic/versions/__init__.py` (also
empty, for the same reason — makes migration files under `versions/`
discovered automatically as they're added):

```python
```

- [ ] **Step 3: Create `src/tournament_server/_alembic/env.py`**

```python
from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from tournament_server import models  # noqa: F401  (registers all tables)
from tournament_server.db import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

- [ ] **Step 4: Create `src/tournament_server/_alembic/script.py.mako`**

Alembic's stock generic migration template, unmodified:

```mako
"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Create Date: ${create_date}

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

# revision identifiers, used by Alembic.
revision: str = ${repr(up_revision)}
down_revision: Union[str, None] = ${repr(down_revision)}
branch_labels: Union[str, Sequence[str], None] = ${repr(branch_labels)}
depends_on: Union[str, Sequence[str], None] = ${repr(depends_on)}


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    ${downgrades if downgrades else "pass"}
```

- [ ] **Step 5: Create `alembic.ini`** at `server/alembic.ini` (the
  server package root, alongside `pyproject.toml`)

This file is a **developer-time convenience only** — for running
`alembic revision --autogenerate` by hand when authoring a future
migration from a source checkout. The application itself never reads
this file (see Task 2 — `ensure_schema_current` builds its own `Config`
object programmatically). Its `sqlalchemy.url` is a plain local default
so the CLI workflow works out of the box.

```ini
[alembic]
script_location = src/tournament_server/_alembic
sqlalchemy.url = sqlite:///./tournament.db

[loggers]
keys = root,sqlalchemy,alembic

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = WARNING
handlers = console
qualname =

[logger_sqlalchemy]
level = WARNING
handlers =
qualname = sqlalchemy.engine

[logger_alembic]
level = INFO
handlers =
qualname = alembic

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
datefmt = %H:%M:%S
```

- [ ] **Step 6: Generate the baseline migration**

Run these commands from `server/` (with the venv active):

```bash
rm -f ./tournament.db
alembic -c alembic.ini revision --autogenerate -m "baseline"
```

This connects to a fresh, empty `./tournament.db` (SQLite creates it
automatically on connect) and diffs it against `target_metadata` (every
table `tournament_server.models` registers, via `env.py`'s import),
producing a migration file under
`src/tournament_server/_alembic/versions/` full of `op.create_table(...)`
calls — one per table. Alembic assigns the filename automatically (a
random hash prefix plus `_baseline.py`); that's fine, keep it as
generated.

**Review the generated file by hand** before moving on:
- It should contain exactly 24 `op.create_table(...)` calls, one for
  each of: `alliances`, `alliance_teams`, `audit_log`, `auth_sessions`,
  `bracket_alliances`, `bracket_alliance_teams`, `bracket_matchups`,
  `divisions`, `events`, `fields`, `field_sets`, `finals_brackets`,
  `finals_results`, `matches`, `sessions`, `session_participation`,
  `rankings`, `ranking_configurations`, `role_credentials`,
  `schedule_generations`, `score_records`, `scoring_devices`,
  `signing_keys`, `teams`. (`audit_log` is declared on `Base` in
  `audit.py`, outside `models/` — `env.py` must import
  `tournament_server.audit`, not just `tournament_server.models`, for
  autogenerate to see it.)
- `downgrade()` should contain the corresponding 24 `op.drop_table(...)`
  calls (Alembic generates these automatically; this phase doesn't
  require them to work, per the Global Constraints' downgrade note, but
  there's no reason to strip them either).
- There should be no unexpected `op.drop_table`/`op.alter_column` calls
  in `upgrade()` — if there are, `./tournament.db` wasn't actually empty
  when you ran the command; delete it and retry Step 6.

Clean up the throwaway database used only to generate this migration:

```bash
rm -f ./tournament.db
```

- [ ] **Step 7: Write the failing test**

Create `tests/test_alembic_baseline.py`:

```python
from __future__ import annotations

import importlib.resources as resources

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect

from tournament_server import models  # noqa: F401  (registers all tables)
from tournament_server.db import Base, make_engine


def _config_for(db_path: str) -> Config:
    config = Config()
    config.set_main_option(
        "script_location", str(resources.files("tournament_server") / "_alembic")
    )
    config.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    return config


def test_baseline_migration_creates_every_current_table(tmp_path):
    db_path = str(tmp_path / "baseline_test.db")
    engine = make_engine(db_path)
    config = _config_for(db_path)

    command.upgrade(config, "head")

    inspector = inspect(engine)
    actual_tables = set(inspector.get_table_names()) - {"alembic_version"}
    expected_tables = set(Base.metadata.tables.keys())
    assert actual_tables == expected_tables
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pytest tests/test_alembic_baseline.py -v`
Expected: PASS. (If it fails, the baseline migration from Step 6 doesn't
match the models — re-check Step 6, don't hand-edit the migration file to
force the test to pass.)

- [ ] **Step 9: Run the full existing suite to confirm no regressions**

Run: `pytest tests/ -v`
Expected: PASS (319 pre-existing + 1 new = 320). Nothing outside the new
Alembic files has changed yet.

- [ ] **Step 10: Commit**

```bash
git add pyproject.toml alembic.ini \
  src/tournament_server/_alembic/ \
  tests/test_alembic_baseline.py
git commit -m "Adopt Alembic: scaffolding and the baseline migration"
```

---

## Task 2: Core migrations module — `ensure_schema_current`

**Files:**
- Create: `src/tournament_server/migrations.py`
- Create: `tests/migration_helpers.py`
- Test: `tests/test_migrations.py`

**Interfaces:**
- Consumes: the Alembic script directory from Task 1
  (`src/tournament_server/_alembic/`); `tournament_server.db.Base`.
- Produces (all importable from `tournament_server.migrations`):
  - `class SchemaMismatchError(RuntimeError)` — raised when a database's
    schema doesn't match any known migration state.
  - `class MigrationOutcome(Enum)` — `ALREADY_CURRENT`, `FRESH_INSTALL`,
    `STAMPED_BASELINE`, `UPGRADED`.
  - `ensure_schema_current(engine: Engine, db_path: str) ->
    MigrationOutcome` — the full check-and-apply logic described in the
    spec's §3. Raises `SchemaMismatchError` for the one refusal case.
  - `_make_alembic_config(db_path: str) -> Config` and
    `_script_location() -> str` — internal helpers, but named exactly
    this way since Task 3's tests reference `_make_alembic_config`
    directly and this task's own tests monkeypatch `_script_location`.
- Produces from `tests/migration_helpers.py` (a shared test helper,
  matching this project's existing `tests/plugin_helpers.py`/
  `tests/auth_helpers.py` pattern):
  - `build_isolated_two_revision_script_dir(tmp_path: Path) -> Path` — a
    standalone, 2-revision Alembic script directory (independent of this
    project's real `_alembic/versions/`) for constructing a database
    that's genuinely one migration behind head. Task 3's CLI tests import
    this too — write it once, here, so it isn't duplicated.

Note: `ensure_schema_current` is not wired into `create_app()` yet in
this task — that's Task 3. This task tests the function directly against
a raw `Engine` and `db_path`, matching the pattern established in this
project's other core-module tasks (e.g. `device_auth.py`'s
`require_admitted_device` was built and unit-tested before being wired
into any router).

- [ ] **Step 1: Write the shared test helper**

Create `tests/migration_helpers.py`:

```python
from __future__ import annotations

from pathlib import Path

_ENV_PY = '''
from alembic import context
from sqlalchemy import engine_from_config, pool

config = context.config


def run_migrations_online():
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
'''

_REV1 = '''
revision = "rev1"
down_revision = None

from alembic import op
import sqlalchemy as sa


def upgrade():
    op.create_table("widgets", sa.Column("id", sa.Integer, primary_key=True))


def downgrade():
    op.drop_table("widgets")
'''

_REV2 = '''
revision = "rev2"
down_revision = "rev1"

from alembic import op
import sqlalchemy as sa


def upgrade():
    op.add_column("widgets", sa.Column("name", sa.String(50)))


def downgrade():
    op.drop_column("widgets", "name")
'''


def build_isolated_two_revision_script_dir(tmp_path: Path) -> Path:
    """Builds a standalone, 2-revision Alembic script directory,
    independent of this project's real `_alembic/versions/`, so a test
    can construct a database that is genuinely one migration behind head
    without ever touching the real baseline migration. Revision "rev1"
    creates a `widgets` table; "rev2" (the head) adds a `name` column to
    it — enough to prove an upgrade actually ran.
    """
    script_dir = tmp_path / "isolated_alembic"
    versions_dir = script_dir / "versions"
    versions_dir.mkdir(parents=True)
    (script_dir / "env.py").write_text(_ENV_PY)
    (versions_dir / "rev1_initial.py").write_text(_REV1)
    (versions_dir / "rev2_add_column.py").write_text(_REV2)
    return script_dir
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_migrations.py`:

```python
from __future__ import annotations

from pathlib import Path

from alembic import command
from migration_helpers import build_isolated_two_revision_script_dir
from sqlalchemy import inspect

from tournament_server import migrations
from tournament_server.db import Base, init_db, make_engine
from tournament_server.migrations import (
    MigrationOutcome,
    SchemaMismatchError,
    _make_alembic_config,
    ensure_schema_current,
)


def test_fresh_empty_database_gets_migrated_from_scratch(tmp_path):
    db_path = str(tmp_path / "fresh.db")
    engine = make_engine(db_path)

    outcome = ensure_schema_current(engine, db_path)

    assert outcome == MigrationOutcome.FRESH_INSTALL
    inspector = inspect(engine)
    actual_tables = set(inspector.get_table_names()) - {"alembic_version"}
    assert actual_tables == set(Base.metadata.tables.keys())


def test_matching_pre_alembic_database_gets_stamped(tmp_path):
    db_path = str(tmp_path / "pre_alembic.db")
    engine = make_engine(db_path)
    init_db(engine)  # simulates a database created before this phase existed

    outcome = ensure_schema_current(engine, db_path)

    assert outcome == MigrationOutcome.STAMPED_BASELINE
    inspector = inspect(engine)
    assert "alembic_version" in inspector.get_table_names()


def test_mismatched_pre_alembic_database_is_refused(tmp_path):
    db_path = str(tmp_path / "old.db")
    engine = make_engine(db_path)
    # Simulate a genuinely old schema: create every table EXCEPT one, so
    # the reflected shape can never match today's models.
    tables_to_create = [
        t for name, t in Base.metadata.tables.items() if name != "scoring_devices"
    ]
    Base.metadata.create_all(engine, tables=tables_to_create)

    raised = False
    try:
        ensure_schema_current(engine, db_path)
    except SchemaMismatchError as exc:
        raised = True
        assert db_path in str(exc)
    assert raised, "expected SchemaMismatchError"


def test_database_already_at_head_does_nothing(tmp_path):
    db_path = str(tmp_path / "current.db")
    engine = make_engine(db_path)

    ensure_schema_current(engine, db_path)  # fresh install -> now at head
    outcome = ensure_schema_current(engine, db_path)  # second call

    assert outcome == MigrationOutcome.ALREADY_CURRENT
    assert list(Path(tmp_path).glob("current.db.pre-migration-*.bak")) == []


def test_database_behind_head_gets_backed_up_and_upgraded(tmp_path, monkeypatch):
    script_dir = build_isolated_two_revision_script_dir(tmp_path)
    monkeypatch.setattr(migrations, "_script_location", lambda: str(script_dir))

    db_path = str(tmp_path / "behind.db")
    engine = make_engine(db_path)

    # Apply only rev1, leaving this database one migration behind head.
    config = _make_alembic_config(db_path)
    command.upgrade(config, "rev1")

    outcome = ensure_schema_current(engine, db_path)

    assert outcome == MigrationOutcome.UPGRADED
    backups = list(Path(tmp_path).glob("behind.db.pre-migration-*.bak"))
    assert len(backups) == 1

    inspector = inspect(engine)
    columns = {col["name"] for col in inspector.get_columns("widgets")}
    assert columns == {"id", "name"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_migrations.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named
'tournament_server.migrations'`

- [ ] **Step 3: Write `src/tournament_server/migrations.py`**

```python
from __future__ import annotations

import datetime as dt
import shutil
from enum import Enum
from importlib import resources

from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import inspect
from sqlalchemy.engine import Engine

from tournament_server.db import Base


class SchemaMismatchError(RuntimeError):
    """Raised when a database's schema doesn't match any known migration
    state — pre-Alembic and not identical to the current baseline schema."""


class MigrationOutcome(Enum):
    ALREADY_CURRENT = "already_current"
    FRESH_INSTALL = "fresh_install"
    STAMPED_BASELINE = "stamped_baseline"
    UPGRADED = "upgraded"


def _script_location() -> str:
    # Resolved via importlib.resources so this works identically whether
    # running from a source checkout or a future frozen executable.
    return str(resources.files("tournament_server") / "_alembic")


def _make_alembic_config(db_path: str) -> Config:
    config = Config()
    config.set_main_option("script_location", _script_location())
    config.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    return config


def _has_any_tables(engine: Engine) -> bool:
    return bool(inspect(engine).get_table_names())


def _reflected_schema_matches_models(engine: Engine) -> bool:
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    expected_tables = set(Base.metadata.tables.keys())
    if existing_tables != expected_tables:
        return False
    for table_name, table in Base.metadata.tables.items():
        existing_columns = {col["name"] for col in inspector.get_columns(table_name)}
        expected_columns = {col.name for col in table.columns}
        if existing_columns != expected_columns:
            return False
    return True


def _backup_path(db_path: str, now: dt.datetime) -> str:
    timestamp = now.strftime("%Y%m%d-%H%M%S")
    return f"{db_path}.pre-migration-{timestamp}.bak"


def _backup_database(engine: Engine, db_path: str) -> None:
    # Checkpoint WAL into the main file first so the copy is a complete,
    # self-consistent snapshot (this project's engines run in WAL mode —
    # see db.py's make_engine — so the main .db file alone can otherwise
    # be missing not-yet-checkpointed writes).
    with engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA wal_checkpoint(TRUNCATE)")
    shutil.copyfile(db_path, _backup_path(db_path, dt.datetime.now(dt.UTC)))


def ensure_schema_current(engine: Engine, db_path: str) -> MigrationOutcome:
    config = _make_alembic_config(db_path)
    script = ScriptDirectory.from_config(config)
    head_revision = script.get_current_head()

    with engine.connect() as connection:
        context = MigrationContext.configure(connection)
        current_heads = context.get_current_heads()

    if not current_heads:
        if not _has_any_tables(engine):
            command.upgrade(config, "head")
            return MigrationOutcome.FRESH_INSTALL
        if _reflected_schema_matches_models(engine):
            command.stamp(config, "head")
            return MigrationOutcome.STAMPED_BASELINE
        raise SchemaMismatchError(
            f"{db_path}'s schema doesn't match any known version "
            "(pre-Alembic, and doesn't match the current baseline schema). "
            "No migration path exists for this file. If it holds no data "
            "you need, delete it and restart to create a fresh one."
        )

    if current_heads == (head_revision,):
        return MigrationOutcome.ALREADY_CURRENT

    _backup_database(engine, db_path)
    command.upgrade(config, "head")
    return MigrationOutcome.UPGRADED
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_migrations.py -v`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Run the full suite**

Run: `pytest tests/ -v`
Expected: PASS (320 + 5 new = 325)

- [ ] **Step 6: Commit**

```bash
git add src/tournament_server/migrations.py tests/test_migrations.py
git commit -m "Add core migrations module: ensure_schema_current"
```

---

## Task 3: Wire into `create_app()` and add `tm migrate`

**Files:**
- Modify: `src/tournament_server/app.py`
- Modify: `src/tournament_server/cli.py`
- Test: `tests/test_cli.py`

**Interfaces:**
- Consumes: `ensure_schema_current`, `MigrationOutcome`,
  `SchemaMismatchError` (Task 2).
- Produces: `create_app()` now runs schema migration automatically
  instead of bare `create_all()`; `tm migrate [--db-path PATH]` CLI
  subcommand.

- [ ] **Step 1: Replace `init_db(engine)` with `ensure_schema_current` in `app.py`**

Edit `src/tournament_server/app.py` — change the import and the one call
site:

```python
from tournament_server.db import make_engine, make_session_factory
from tournament_server.migrations import ensure_schema_current
```

```python
    engine = make_engine(settings.db_path)
    session_factory = make_session_factory(engine)
    ensure_schema_current(engine, settings.db_path)
```

(Only the import line and this one line change — everything else in
`create_app()` is unchanged. `init_db` itself stays in `db.py` unmodified;
several existing unit tests, e.g. `tests/test_auth_core.py`, still call it
directly against a raw engine, bypassing `create_app()` entirely, and
that usage is unaffected.)

- [ ] **Step 2: Write the failing CLI tests**

Add to `tests/test_cli.py`:

```python
def test_migrate_command_reports_fresh_install(tmp_path, capsys):
    db_path = str(tmp_path / "fresh.db")

    exit_code = main(["migrate", "--db-path", db_path])

    assert exit_code == 0
    captured = capsys.readouterr()
    assert "created fresh" in captured.out


def test_migrate_command_reports_schema_mismatch(tmp_path, capsys):
    from tournament_server.db import Base, make_engine

    db_path = str(tmp_path / "old.db")
    engine = make_engine(db_path)
    tables_to_create = [
        t for name, t in Base.metadata.tables.items() if name != "scoring_devices"
    ]
    Base.metadata.create_all(engine, tables=tables_to_create)

    exit_code = main(["migrate", "--db-path", db_path])

    assert exit_code == 1
    captured = capsys.readouterr()
    assert "ERROR" in captured.out


def test_migrate_command_reports_stamped_baseline(tmp_path, capsys):
    from tournament_server.db import Base, make_engine

    db_path = str(tmp_path / "pre_alembic.db")
    engine = make_engine(db_path)
    Base.metadata.create_all(engine)

    exit_code = main(["migrate", "--db-path", db_path])

    assert exit_code == 0
    captured = capsys.readouterr()
    assert "stamped as up to date" in captured.out


def test_migrate_command_reports_already_current(tmp_path, capsys):
    db_path = str(tmp_path / "current.db")

    main(["migrate", "--db-path", db_path])
    exit_code = main(["migrate", "--db-path", db_path])

    assert exit_code == 0
    captured = capsys.readouterr()
    assert "already up to date" in captured.out


def test_migrate_command_reports_upgraded(tmp_path, capsys, monkeypatch):
    from alembic import command
    from migration_helpers import build_isolated_two_revision_script_dir

    from tournament_server import migrations
    from tournament_server.db import make_engine
    from tournament_server.migrations import _make_alembic_config

    script_dir = build_isolated_two_revision_script_dir(tmp_path)
    monkeypatch.setattr(migrations, "_script_location", lambda: str(script_dir))

    db_path = str(tmp_path / "behind.db")
    make_engine(db_path)
    config = _make_alembic_config(db_path)
    command.upgrade(config, "rev1")

    exit_code = main(["migrate", "--db-path", db_path])

    assert exit_code == 0
    captured = capsys.readouterr()
    assert "pre-migration backup was created" in captured.out
```

Note: `test_migrate_command_reports_upgraded` monkeypatches
`migrations._script_location` (not `cli`'s own namespace) since
`_run_migrate` imports `ensure_schema_current` fresh from the
`migrations` module on every call — patching the function the module
itself calls internally is what takes effect.

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/test_cli.py -v`
Expected: FAIL — `main` doesn't recognize the `migrate` command yet
(`argparse` error / `SystemExit`).

- [ ] **Step 4: Add the `migrate` subcommand to `cli.py`**

Edit `src/tournament_server/cli.py`:

```python
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from tournament_server.plugin_registry.conformance import run_conformance_checks


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tm")
    subparsers = parser.add_subparsers(dest="command", required=True)

    test_plugin_parser = subparsers.add_parser(
        "test-plugin", help="Run conformance checks against a plugin folder"
    )
    test_plugin_parser.add_argument("path", type=str)

    migrate_parser = subparsers.add_parser(
        "migrate", help="Apply any pending database schema migrations"
    )
    migrate_parser.add_argument(
        "--db-path", type=str, default=None, help="Path to the SQLite database file"
    )

    args = parser.parse_args(argv)

    if args.command == "test-plugin":
        return _run_test_plugin(Path(args.path))
    if args.command == "migrate":
        return _run_migrate(args.db_path)

    return 1


def _run_test_plugin(plugin_dir: Path) -> int:
    report = run_conformance_checks(plugin_dir)
    for check in report.checks:
        status = "PASS" if check.passed else "FAIL"
        line = f"[{status}] {check.name}"
        if check.message:
            line += f": {check.message}"
        print(line)

    if report.passed:
        print(f"\nAll checks passed for {report.plugin_name!r}.")
        return 0

    print(f"\nConformance checks FAILED for {plugin_dir}.")
    return 1


def _run_migrate(db_path: str | None) -> int:
    from tournament_server.db import make_engine
    from tournament_server.migrations import (
        MigrationOutcome,
        SchemaMismatchError,
        ensure_schema_current,
    )
    from tournament_server.settings import Settings

    resolved_db_path = db_path if db_path is not None else Settings.from_env().db_path
    engine = make_engine(resolved_db_path)

    try:
        outcome = ensure_schema_current(engine, resolved_db_path)
    except SchemaMismatchError as exc:
        print(f"ERROR: {exc}")
        return 1

    messages = {
        MigrationOutcome.ALREADY_CURRENT: f"{resolved_db_path}: schema already up to date.",
        MigrationOutcome.FRESH_INSTALL: f"{resolved_db_path}: created fresh with the current schema.",
        MigrationOutcome.STAMPED_BASELINE: (
            f"{resolved_db_path}: matched the current baseline schema; stamped as up to date."
        ),
        MigrationOutcome.UPGRADED: (
            f"{resolved_db_path}: applied pending migrations; a pre-migration backup was created."
        ),
    }
    print(messages[outcome])
    return 0


def run() -> None:
    sys.exit(main())


if __name__ == "__main__":
    run()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/test_cli.py -v`
Expected: PASS (all tests, including the five new ones)

- [ ] **Step 6: Run the full suite**

Run: `pytest tests/ -v`
Expected: PASS (325 + 5 new = 330). Every pre-existing test now runs its
`create_app()` call through `ensure_schema_current`'s "fresh install"
branch instead of bare `create_all()` — confirm nothing regressed and
note whether overall suite runtime changed meaningfully (it shouldn't;
each test already builds a fresh temp-file SQLite database, and Alembic's
added bookkeeping per test is small next to that existing per-test I/O).

- [ ] **Step 7: Commit**

```bash
git add src/tournament_server/app.py src/tournament_server/cli.py tests/test_cli.py
git commit -m "Wire ensure_schema_current into create_app(); add tm migrate"
```

---

## Task 4: The drift-detection test

**Files:**
- Test: `tests/test_alembic_drift.py`

**Interfaces:** none produced — this task is pure test coverage, the
long-term guard against migrations and models silently diverging.

If this test fails, it means the checked-in migrations don't produce the
same schema `Base.metadata` currently declares — the fix is to correct
whichever migration is out of sync (or add a missing one), never to
change this test to tolerate the difference.

- [ ] **Step 1: Write the test**

Create `tests/test_alembic_drift.py`:

```python
from __future__ import annotations

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext

from tournament_server import models  # noqa: F401  (registers all tables)
from tournament_server.db import Base, make_engine
from tournament_server.migrations import ensure_schema_current


def test_migrations_produce_a_schema_identical_to_the_current_models(tmp_path):
    db_path = str(tmp_path / "drift_check.db")
    engine = make_engine(db_path)

    ensure_schema_current(engine, db_path)  # applies the real, checked-in migrations

    with engine.connect() as connection:
        context = MigrationContext.configure(connection)
        diff = compare_metadata(context, Base.metadata)

    assert diff == [], (
        "The checked-in migrations produce a schema that differs from "
        "the current SQLAlchemy models. Generate and commit a new "
        f"migration for the following changes: {diff}"
    )
```

If `from alembic.autogenerate import compare_metadata` doesn't resolve
against the installed Alembic version, run
`python3 -c "import alembic.autogenerate as a; print([n for n in dir(a) if 'compare' in n.lower()])"`
to find the correct current name and adjust the import — the function's
job (diff a live connection's reflected schema against a `MetaData`
object) is stable across Alembic versions even if it's been renamed.

- [ ] **Step 2: Run test to verify it passes**

Run: `pytest tests/test_alembic_drift.py -v`
Expected: PASS. (A failure here means Task 1's baseline migration doesn't
actually match the models — go back and fix Task 1's migration file, not
this test.)

- [ ] **Step 3: Run the full suite**

Run: `pytest tests/ -v`
Expected: PASS (330 + 1 new = 331)

- [ ] **Step 4: Commit**

```bash
git add tests/test_alembic_drift.py
git commit -m "Add drift-detection test guarding migrations against model divergence"
```

---

## Task 5: Document migrations in `server/CLAUDE.md`

**Files:**
- Modify: `server/CLAUDE.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add a new `## Database migrations` section**

Insert immediately after the existing `## Scoring device admission`
section and before `## Known, deliberate gaps in this phase`:

```markdown
## Database migrations

Real Alembic migrations exist as of this phase (see
`docs/superpowers/specs/2026-09-10-database-migrations-design.md`). A
single baseline migration
(`src/tournament_server/_alembic/versions/`) captures the full schema
exactly as it existed the moment this phase landed — no attempt was made
to reconstruct migrations for any earlier schema shape, since no real
deployed event data has ever existed against one (every prior phase's own
"known gaps" note said the same thing: delete the `.db` file and let
`create_all()` rebuild it). From this point on, every schema change ships
as a real migration in the same commit as the model change that needs it.

`ensure_schema_current` (`migrations.py`) runs automatically on every
`create_app()` call — the real server at startup, and every test fixture
alike, since they share this one entry point. A brand-new database gets
migrated from scratch; an existing pre-Alembic database whose reflected
schema exactly matches today's models gets silently stamped at the
baseline revision (no `CREATE TABLE` re-run against tables that already
exist); a database that's genuinely behind head gets an automatic,
WAL-checkpointed, timestamped backup
(`<db_path>.pre-migration-<timestamp>.bak`) before `alembic upgrade head`
runs; and a pre-Alembic database that doesn't match anything known
refuses to start, with the same "delete the file and let it rebuild"
instruction this project has already given twice. `tm migrate` is the
same check, runnable by hand (useful for scripting or an operator who
wants to migrate before switching versions without starting the server).

Alembic is invoked entirely through its Python API (`alembic.command`),
never by shelling out to an `alembic` binary, and migration
scripts/config are addressed via `importlib.resources` rather than a
path built relative to `__file__` — both deliberate choices so this
works unchanged once PyInstaller packaging (a separate, later phase)
exists, without needing rework then. `tests/test_alembic_drift.py` is
the guard against migrations and models silently diverging: it asserts
that applying only the checked-in migrations produces a schema
byte-for-byte identical (via Alembic's own autogenerate-diff machinery)
to what `Base.metadata` declares — this is what fails, loudly, if a
future phase changes a model without also writing the matching
migration.
```

- [ ] **Step 2: Replace the stale "No Alembic/migrations yet" bullet**

In the `## Known, deliberate gaps in this phase` section, remove this
entire bullet (it's resolved, not a gap anymore):

```markdown
- No Alembic/migrations yet — schema changes go through
  `Base.metadata.create_all()`, which only adds new tables, never alters
  existing ones. **This line has already been crossed** twice: Phase 3
  added `Event.game_plugin_name` to the pre-existing `events` table, and
  this scheduling phase changed the `matches` table three more ways —
  `field_id` went from a plain string to an integer FK, and two new
  columns (`time_slot`, `schedule_generation_id`) were added. A database
  created before either of these changes will fail with a `no such
  column` (or a type-mismatch) error on first read. No real events have
  been created against this schema yet, so recreating the database is
  the correct fix today — delete the `.db` file and let `create_all()`
  build it fresh. Introduce real migrations before this project has any
  real deployed event data that can't simply be recreated.
```

Replace it with:

```markdown
- No automated cleanup of `.pre-migration-*.bak` backup files — they
  accumulate; an operator deletes old ones manually. `alembic downgrade`
  is not a supported, tested rollback path — the pre-migration backup is
  the recovery mechanism for a bad migration, not a scripted downgrade.
```

- [ ] **Step 3: Commit**

```bash
git add server/CLAUDE.md
git commit -m "Document database migrations in server/CLAUDE.md"
```

---

## Task 6: Final full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the complete test suite**

Run: `pytest tests/ -v`
Expected: PASS — every test passes (331 total), no skips.

- [ ] **Step 2: Manual end-to-end smoke test — fresh install**

```bash
rm -f tournament.db*
python -m tournament_server.main &
sleep 2
curl -s http://127.0.0.1:8000/health
kill %1
```

Expected: server boots cleanly against a fresh `.db` file (migrations ran
silently) and `/health` returns `{"status":"ok"}`. Then confirm:

```bash
python3 -c "
import sqlite3
conn = sqlite3.connect('tournament.db')
print(conn.execute('SELECT version_num FROM alembic_version').fetchone())
"
```

Expected: prints a single revision id (the baseline migration's).

- [ ] **Step 3: Manual smoke test — `tm migrate` on an already-current database**

```bash
tm migrate --db-path tournament.db
```

Expected: prints `tournament.db: schema already up to date.` and exits 0.

- [ ] **Step 4: Manual smoke test — refusal on a mismatched pre-Alembic database**

```bash
rm -f tournament.db*
python3 -c "
from tournament_server.db import Base, make_engine
engine = make_engine('tournament.db')
tables = [t for name, t in Base.metadata.tables.items() if name != 'scoring_devices']
Base.metadata.create_all(engine, tables=tables)
"
tm migrate --db-path tournament.db
echo \"exit code: \$?\"
```

Expected: prints the `ERROR: tournament.db's schema doesn't match any
known version...` message and exits 1.

- [ ] **Step 5: Clean up**

```bash
rm -f tournament.db*
```

- [ ] **Step 6: Confirm no stray references or leftover TODOs**

Run: `grep -rn "TODO\|FIXME" src/tournament_server/migrations.py
src/tournament_server/_alembic/` — expected: no output.

This task has no commit of its own — it's the final gate before
considering the branch done. If any step fails, return to the relevant
earlier task and fix it there (with its own commit) rather than patching
ad hoc here.
