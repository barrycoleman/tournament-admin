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

## Known, deliberate gaps in this phase

- There's no real authentication yet. Requests can pass an
  `X-Actor-Name` header to identify who's making a change (used only for
  the audit log); it defaults to `"admin"`. Don't mistake this for a
  security boundary — anyone can claim to be anyone. A real
  identity/admission system is a later phase (Device/ScoringDevice
  admission is designed in the spec but not implemented in this plan).
- A Team belongs to at most one Division (nullable `division_id`), not a
  many-to-many relationship, as a deliberate YAGNI simplification — see
  the plan's Global Constraints for why.
- No Alembic/migrations yet — schema changes go through
  `Base.metadata.create_all()`, which only adds new tables, never alters
  existing ones. Introduce real migrations before the schema needs to
  change on a database that already has real event data in it.

## Testing

Every test in `tests/` uses the `client` fixture from `conftest.py`,
which builds a fresh `FastAPI` app against a fresh temp-file SQLite
database per test — never a shared or mocked database. Follow that
pattern for new tests: real HTTP calls through `TestClient`, a real
(temporary) SQLite file underneath.
