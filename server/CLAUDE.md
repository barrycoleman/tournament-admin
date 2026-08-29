# Server-specific instructions

This is the core tournament server: FastAPI + SQLAlchemy 2.0 + SQLite,
one process and one database file per event. The full architecture is in
`../docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md`;
the root `../CLAUDE.md` has the project-wide constraints (no brand names,
mandatory testing policy) that apply here too.

## Local development

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/ -v
python -m tournament_server.main   # runs the dev server on 127.0.0.1:8000
```

## Layout

- `models/` — one SQLAlchemy model per file, one table each.
- `schemas/` — Pydantic request/response schemas, one file per resource,
  matching the `models/` file it serves.
- `routers/` — one FastAPI `APIRouter` per resource.
- `audit.py` — the only place that knows how audit logging works. It
  hooks in generically via SQLAlchemy mapper events
  (`after_insert`/`after_update`/`after_delete` on `Base`, with
  `propagate=True`), so a new model defined anywhere automatically gets
  audited — nothing needs to call into `audit.py` by hand.
- `db.py` — the SQLAlchemy `Base`, engine/session-factory helpers, and
  `init_db()`. Every model module does `from tournament_server.db import Base`.

## Plugin system

A game plugin is a folder — `plugins/games/<name>/` — containing
`manifest.json` (`name`, `version`, `kind: "game"`, `display_name`) and
`plugin.py`, which must define seven module-level functions:
`match_format`, `scoresheet_schema`, `calculate_score`, `validate`,
`rank_teams`, `skills_scoresheet_schema`, `calculate_skills_score`. See
`tournament_server/plugin_registry/loader.py`'s
`REQUIRED_GAME_PLUGIN_FUNCTIONS` for the authoritative list, and
`tests/fixtures/plugins/games/example-game/plugin.py` for a complete
working example.

The server scans `<plugins_root>/games/*/` at startup
(`plugin_registry/discovery.py`) and also accepts new plugins at
runtime via `POST /api/plugins/games` (a zip with `manifest.json` and
`plugin.py` at its root — no wrapping folder). A newly installed plugin
is registered immediately; no restart is needed. Startup discovery
skips a broken plugin folder with a warning rather than crashing; a zip
upload that fails to install is rejected outright with a 409 (name
already taken) or 422 (malformed).

Before distributing a plugin, its author should run
`tm test-plugin <path-to-plugin-folder>`, which checks the plugin's
contract (required functions present, schema shapes valid, scoring
functions deterministic and int-returning, `rank_teams` produces a
clean 1..N ranking) and exits non-zero on any failure. This conformance
tool does not yet check for anything beyond the contract itself
(no checksums, no capability scanning — that hardening is a separate,
later phase per the design spec's §9).

The plugin folder root is configurable via the `TOURNAMENT_PLUGINS_ROOT`
environment variable (default `./plugins`, resolved relative to wherever
the process was launched — a known packaging-phase gap, see the design
spec's §10). The registry holds at most one active version per plugin
`name`; installing a zip whose `name` is already installed is rejected
(409), and there is currently no uninstall/replace endpoint — swapping
or removing an installed plugin is a manual filesystem operation on the
plugins directory today.

Every key in a `scoresheet_schema()`/`skills_scoresheet_schema()` field
dict must be *present*, even when its value is `None` — e.g. a
non-enum field still needs `"options": None`, not an omitted `options`
key. This is what the conformance tool and the loader both check for;
see `tests/fixtures/plugins/games/example-game/plugin.py` for the
pattern every field in that fixture follows.

## Known, deliberate gaps in this phase

- There's no real authentication yet. Requests can pass an
  `X-Actor-Name` header to identify who's making a change (used only for
  the audit log); it defaults to `"admin"`. Don't mistake this for a
  security boundary — anyone can claim to be anyone. A real
  identity/admission system is a later phase (Device/ScoringDevice
  admission is designed in the spec but not implemented in this plan).
- The plugin-install endpoint (`POST /api/plugins/games`) dynamically
  imports and executes arbitrary uploaded Python code, with the same
  "no real authentication" gap as everything above — but this one is
  qualitatively more dangerous than a CRUD endpoint, since it's a
  code-execution primitive. This was raised explicitly with the project
  owner, who accepted the risk for now (local-LAN, single-admin-in-the-
  room threat model) rather than bolt on a one-off check ahead of a real
  auth system. See the design spec's §10 for the role-based-passwords +
  JWT direction planned for that future phase.
- A Team belongs to at most one Division (nullable `division_id`), not a
  many-to-many relationship, as a deliberate YAGNI simplification — see
  the plan's Global Constraints for why.
- No Alembic/migrations yet — schema changes go through
  `Base.metadata.create_all()`, which only adds new tables, never alters
  existing ones. Introduce real migrations before the schema needs to
  change on a database that already has real event data in it.

## Testing

Most tests use the `client` fixture from `conftest.py`, which builds a
fresh `FastAPI` app against a fresh temp-file SQLite database (and an
isolated temp `plugins_root`) per test — never a shared or mocked
database. Follow that pattern for anything exercising the HTTP API: real
calls through `TestClient`, real temporary files underneath.

The `plugin_registry` subpackage also has plain unit tests (e.g.
`test_plugin_manifest.py`, `test_plugin_loader.py`,
`test_plugin_conformance.py`) that call its functions directly against
fixture plugin folders in `tests/fixtures/plugins/games/`, with no
`client`/`TestClient` involved — appropriate for logic that doesn't
touch the HTTP layer at all.
