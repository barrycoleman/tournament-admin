# Qualification & Practice Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin configure a session's Fields/FieldSets and generate its practice/qualification match schedule via a pluggable schedule-generator, with two built-in generators (`simple_random`, `balanced`).

**Architecture:** Generalize the existing game-plugin registry into a kind-parameterized registry shared by game and scheduler plugins; add Field/FieldSet/ScheduleGeneration data model; add a `POST /api/schedule` / `DELETE /api/schedule` resource that validates a scheduler plugin's output structurally before persisting Match/Alliance rows, mirroring the validate-before-persist discipline already used for score submission.

**Tech Stack:** Python 3.11+, FastAPI, SQLAlchemy 2.0, SQLite, Pydantic v2, pytest.

**Spec:** `docs/superpowers/specs/2026-08-29-qualification-and-practice-scheduling-design.md` (the "Phase 4 spec"). Also read `docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md` (the "master spec") for project-wide context.

## Global Constraints

- No brand names anywhere (code, comments, docs, file names, user-facing text) — master spec §0.
- Python 3.11+, FastAPI, SQLAlchemy 2.0 synchronous `Mapped`/`mapped_column` style, one SQLite file per event — matches existing codebase.
- No Alembic/migrations — this phase changes the `matches` table's schema again (on top of Phase 3's `events` table change); a pre-Phase-4 database is recreated (delete the `.db` file), not migrated.
- Every session-scoped GET endpoint takes `session_id: int = Depends(get_session_id)` (defaults to the event's active session) — existing convention, followed by the new Field/FieldSet GET endpoints.
- All new endpoints return proper 404/422/409 errors via `HTTPException`, validated before any DB write — the pattern already fixed into `matches.py`/`scores.py` during Phase 3's final review.
- Deletions that should appear in the audit log MUST go through ORM `db.delete(obj)`, never bulk `Table.delete()` Core statements — `audit.py`'s mapper-level `after_delete` events only fire for ORM-level operations, and master spec §8 requires every mutation (including this phase's schedule-clearing) to be audited.
- `generate_schedule`'s signature in the Phase 4 spec is corrected in this plan to include `teams_per_alliance` (see Task 5) — the original 5-argument signature can't work without it, since the scheduler must know how many teams go in each alliance, and that's a property of the event's selected *game* plugin (`match_format()["teams_per_alliance"]`), not something the scheduler itself decides. This is a plan-time correction, applied the same way Phase 1 corrected a spec/plan mismatch found while writing that plan.

---

### Task 1: Generalize the plugin registry for multiple plugin kinds

**Files:**
- Modify: `src/tournament_server/plugin_registry/loader.py`
- Modify: `src/tournament_server/plugin_registry/discovery.py`
- Modify: `src/tournament_server/plugin_registry/zip_install.py`
- Modify: `src/tournament_server/routers/plugins.py`
- Modify: `src/tournament_server/deps.py`
- Modify: `src/tournament_server/services/ranking.py`
- Modify: `src/tournament_server/app.py`
- Test: `tests/test_plugin_loader.py` (additive)
- Test: `tests/test_plugin_discovery.py` (additive)
- Test: `tests/test_plugin_registry_generic.py` (new)

**Interfaces:**
- Produces: `PluginKind` dataclass (`kind: str, folder_name: str, required_functions: tuple[str, ...]`), `GAME_PLUGIN_KIND`, `SCHEDULER_PLUGIN_KIND` constants, `LoadedPlugin` dataclass (`name, version, display_name, folder, module`), `load_plugin(plugin_dir: Path, kind: PluginKind) -> LoadedPlugin`, `discover_plugins(plugins_root: Path, kind: PluginKind) -> dict[str, LoadedPlugin]`, `install_plugin_zip(zip_bytes: bytes, plugins_root: Path, kind: PluginKind = GAME_PLUGIN_KIND) -> LoadedPlugin` — all in `plugin_registry`, consumed by every later task that touches scheduler plugins.
- Consumes: nothing new (only refactors existing Phase 2 code).

This task changes the internal shape of the registry but preserves every existing public entry point's signature (`load_game_plugin(plugin_dir)`, `discover_game_plugins(plugins_root)`, `install_plugin_zip(zip_bytes, plugins_root)` with the 3rd arg defaulted) — **no existing test in the repo should need to change.** Run the full suite before and after this task; the "before" count is your regression baseline.

- [ ] **Step 1: Rewrite `loader.py` with a generic, kind-parameterized loader**

Replace the entire contents of `src/tournament_server/plugin_registry/loader.py` with:

```python
from __future__ import annotations

import importlib.util
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

from tournament_server.plugin_registry.errors import PluginLoadError
from tournament_server.plugin_registry.manifest import load_manifest

REQUIRED_GAME_PLUGIN_FUNCTIONS = (
    "match_format",
    "scoresheet_schema",
    "calculate_score",
    "validate",
    "rank_teams",
    "skills_scoresheet_schema",
    "calculate_skills_score",
)

REQUIRED_SCHEDULER_PLUGIN_FUNCTIONS = ("generate_schedule",)


@dataclass(frozen=True)
class PluginKind:
    kind: str
    folder_name: str
    required_functions: tuple[str, ...]


GAME_PLUGIN_KIND = PluginKind(
    kind="game", folder_name="games", required_functions=REQUIRED_GAME_PLUGIN_FUNCTIONS
)
SCHEDULER_PLUGIN_KIND = PluginKind(
    kind="scheduler",
    folder_name="schedulers",
    required_functions=REQUIRED_SCHEDULER_PLUGIN_FUNCTIONS,
)


@dataclass
class LoadedPlugin:
    name: str
    version: str
    display_name: str
    folder: Path
    module: ModuleType


def _import_plugin_module(plugin_dir: Path, module_key: str) -> ModuleType:
    module_path = plugin_dir / "plugin.py"
    if not module_path.exists():
        raise PluginLoadError(f"{plugin_dir} has no plugin.py")
    spec = importlib.util.spec_from_file_location(module_key, module_path)
    if spec is None or spec.loader is None:
        raise PluginLoadError(f"could not load plugin module at {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_key] = module
    try:
        spec.loader.exec_module(module)
    except BaseException as exc:
        del sys.modules[module_key]
        raise PluginLoadError(f"error executing {module_path}: {exc}") from exc
    return module


def _check_required_functions(
    module: ModuleType, module_key: str, required_functions: tuple[str, ...]
) -> None:
    missing = [
        name
        for name in required_functions
        if not callable(getattr(module, name, None))
    ]
    if missing:
        sys.modules.pop(module_key, None)
        raise PluginLoadError(
            f"plugin module is missing required functions: {', '.join(missing)}"
        )


def load_plugin(plugin_dir: Path, kind: PluginKind) -> LoadedPlugin:
    manifest = load_manifest(plugin_dir)
    if manifest.kind != kind.kind:
        raise PluginLoadError(
            f"{plugin_dir} declares kind={manifest.kind!r}, expected {kind.kind!r}"
        )
    module_key = f"tournament_server_plugin_{manifest.name}"
    module = _import_plugin_module(plugin_dir, module_key)
    _check_required_functions(module, module_key, kind.required_functions)
    return LoadedPlugin(
        name=manifest.name,
        version=manifest.version,
        display_name=manifest.display_name,
        folder=plugin_dir,
        module=module,
    )


def load_game_plugin(plugin_dir: Path) -> LoadedPlugin:
    return load_plugin(plugin_dir, GAME_PLUGIN_KIND)


def load_scheduler_plugin(plugin_dir: Path) -> LoadedPlugin:
    return load_plugin(plugin_dir, SCHEDULER_PLUGIN_KIND)
```

(`LoadedGamePlugin` is renamed to `LoadedPlugin` — the distinction now lives in which registry/folder a plugin came from, not its Python type. No test imports `LoadedGamePlugin` by name, only `services/ranking.py` and `deps.py` type-hint with it — both fixed in this task.)

- [ ] **Step 2: Rewrite `discovery.py` generically**

Replace the entire contents of `src/tournament_server/plugin_registry/discovery.py` with:

```python
from __future__ import annotations

import sys
from pathlib import Path

from tournament_server.plugin_registry.errors import PluginLoadError
from tournament_server.plugin_registry.loader import (
    GAME_PLUGIN_KIND,
    SCHEDULER_PLUGIN_KIND,
    LoadedPlugin,
    PluginKind,
    load_plugin,
)


def discover_plugins(plugins_root: Path, kind: PluginKind) -> dict[str, LoadedPlugin]:
    kind_root = plugins_root / kind.folder_name
    registry: dict[str, LoadedPlugin] = {}
    if not kind_root.is_dir():
        return registry

    for entry in sorted(kind_root.iterdir()):
        if not entry.is_dir():
            continue
        try:
            plugin = load_plugin(entry, kind)
        except PluginLoadError as exc:
            print(f"warning: skipping plugin folder {entry}: {exc}", file=sys.stderr)
            continue
        registry[plugin.name] = plugin
    return registry


def discover_game_plugins(plugins_root: Path) -> dict[str, LoadedPlugin]:
    return discover_plugins(plugins_root, GAME_PLUGIN_KIND)


def discover_scheduler_plugins(plugins_root: Path) -> dict[str, LoadedPlugin]:
    return discover_plugins(plugins_root, SCHEDULER_PLUGIN_KIND)
```

- [ ] **Step 3: Generalize `zip_install.py` with a defaulted `kind` parameter**

Replace the entire contents of `src/tournament_server/plugin_registry/zip_install.py` with:

```python
from __future__ import annotations

import io
import json
import shutil
import zipfile
from pathlib import Path

from tournament_server.plugin_registry.errors import (
    PluginAlreadyExistsError,
    PluginInstallError,
    PluginLoadError,
)
from tournament_server.plugin_registry.loader import (
    GAME_PLUGIN_KIND,
    LoadedPlugin,
    PluginKind,
    load_plugin,
)
from tournament_server.plugin_registry.manifest import parse_manifest


def install_plugin_zip(
    zip_bytes: bytes, plugins_root: Path, kind: PluginKind = GAME_PLUGIN_KIND
) -> LoadedPlugin:
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as exc:
        raise PluginInstallError(f"not a valid zip file: {exc}") from exc

    with zf:
        try:
            manifest_raw = zf.read("manifest.json")
        except KeyError as exc:
            raise PluginInstallError(
                "zip does not contain a manifest.json at its root"
            ) from exc
        except Exception as exc:
            raise PluginInstallError(
                f"could not read manifest.json from zip: {exc}"
            ) from exc

        try:
            manifest_data = json.loads(manifest_raw)
        except json.JSONDecodeError as exc:
            raise PluginInstallError(f"manifest.json is not valid JSON: {exc}") from exc

        try:
            manifest = parse_manifest(manifest_data)
        except PluginLoadError as exc:
            raise PluginInstallError(str(exc)) from exc

        if manifest.kind != kind.kind:
            raise PluginInstallError(
                f"expected a {kind.kind!r} plugin manifest, got kind={manifest.kind!r}"
            )

        target_dir = plugins_root / kind.folder_name / manifest.name
        if target_dir.exists():
            raise PluginAlreadyExistsError(
                f"a plugin named {manifest.name!r} is already installed"
            )

        target_dir.mkdir(parents=True)
        try:
            zf.extractall(target_dir)
        except Exception as exc:
            shutil.rmtree(target_dir, ignore_errors=True)
            raise PluginInstallError(f"could not extract zip contents: {exc}") from exc

    try:
        return load_plugin(target_dir, kind)
    except PluginLoadError as exc:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise PluginInstallError(f"installed plugin failed to load: {exc}") from exc
```

- [ ] **Step 4: Add scheduler routes to `routers/plugins.py`**

In `src/tournament_server/routers/plugins.py`, add the import and a second router, leaving the existing `router`/`list_game_plugins`/`upload_game_plugin` completely unchanged:

```python
from tournament_server.plugin_registry.loader import SCHEDULER_PLUGIN_KIND
```

(add alongside the existing imports), then append at the end of the file:

```python
scheduler_router = APIRouter(prefix="/api/plugins/schedulers", tags=["plugins"])


@scheduler_router.get("")
def list_scheduler_plugins(request: Request) -> list[dict[str, str]]:
    registry = request.app.state.scheduler_plugins
    return [
        {"name": p.name, "version": p.version, "display_name": p.display_name}
        for p in registry.values()
    ]


@scheduler_router.post("", status_code=201)
def upload_scheduler_plugin(request: Request, file: UploadFile) -> dict[str, str]:
    zip_bytes = file.file.read()
    plugins_root = request.app.state.plugins_root
    try:
        plugin = install_plugin_zip(zip_bytes, plugins_root, SCHEDULER_PLUGIN_KIND)
    except PluginAlreadyExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except PluginInstallError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    request.app.state.scheduler_plugins[plugin.name] = plugin
    return {
        "name": plugin.name,
        "version": plugin.version,
        "display_name": plugin.display_name,
    }
```

- [ ] **Step 5: Update `deps.py` and `services/ranking.py` for the renamed type**

In `src/tournament_server/deps.py`, change:

```python
from tournament_server.plugin_registry.loader import LoadedGamePlugin
```

to:

```python
from tournament_server.plugin_registry.loader import LoadedPlugin
```

and change the `get_game_plugin_for_event` return type annotation from `-> LoadedGamePlugin:` to `-> LoadedPlugin:`.

In `src/tournament_server/services/ranking.py`, change:

```python
from tournament_server.plugin_registry.loader import LoadedGamePlugin
```

to:

```python
from tournament_server.plugin_registry.loader import LoadedPlugin
```

and change `plugin: LoadedGamePlugin` to `plugin: LoadedPlugin` in `recompute_rankings`'s signature.

- [ ] **Step 6: Wire scheduler plugin discovery and the new router into `app.py`**

In `src/tournament_server/app.py`, change:

```python
from tournament_server.plugin_registry.discovery import discover_game_plugins
```

to:

```python
from tournament_server.plugin_registry.discovery import (
    discover_game_plugins,
    discover_scheduler_plugins,
)
```

Add after `app.state.game_plugins = discover_game_plugins(app.state.plugins_root)`:

```python
    app.state.scheduler_plugins = discover_scheduler_plugins(app.state.plugins_root)
```

Add after `app.include_router(plugins.router)`:

```python
    app.include_router(plugins.scheduler_router)
```

- [ ] **Step 7: Run the full existing suite — must pass unchanged**

Run: `.venv/bin/pytest tests/ -v`
Expected: every test that passed before this task still passes, same count minus zero. If anything fails, the refactor broke behavior — fix it before proceeding; do not modify a pre-existing test's assertions to make it pass.

- [ ] **Step 8: Add generic-path tests to the existing plugin test files**

Append to `tests/test_plugin_loader.py`:

```python
from tournament_server.plugin_registry.loader import (
    GAME_PLUGIN_KIND,
    SCHEDULER_PLUGIN_KIND,
    load_plugin,
)


def test_load_plugin_generic_matches_load_game_plugin():
    plugin = load_plugin(FIXTURE_EXAMPLE_PLUGIN, GAME_PLUGIN_KIND)
    assert plugin.name == "example-game"
    assert plugin.version == "1.0.0"


def test_load_plugin_rejects_mismatched_kind():
    with pytest.raises(PluginLoadError, match="expected 'scheduler'"):
        load_plugin(FIXTURE_EXAMPLE_PLUGIN, SCHEDULER_PLUGIN_KIND)
```

Append to `tests/test_plugin_discovery.py`:

```python
from tournament_server.plugin_registry.discovery import discover_scheduler_plugins


def test_discover_scheduler_plugins_empty_root_returns_empty_dict(tmp_path):
    registry = discover_scheduler_plugins(tmp_path / "plugins")
    assert registry == {}
```

Create `tests/test_plugin_registry_generic.py`:

```python
import io
import json
import zipfile

from tournament_server.plugin_registry.discovery import discover_scheduler_plugins
from tournament_server.plugin_registry.loader import SCHEDULER_PLUGIN_KIND
from tournament_server.plugin_registry.zip_install import install_plugin_zip


def _build_scheduler_zip(name: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr(
            "manifest.json",
            json.dumps(
                {
                    "name": name,
                    "version": "1.0.0",
                    "kind": "scheduler",
                    "display_name": "Test Scheduler",
                }
            ),
        )
        zf.writestr("plugin.py", "def generate_schedule(**kwargs):\n    return []\n")
    return buffer.getvalue()


def test_install_plugin_zip_installs_scheduler_kind_under_schedulers_folder(tmp_path):
    zip_bytes = _build_scheduler_zip("stub-scheduler")
    plugins_root = tmp_path / "plugins"

    plugin = install_plugin_zip(zip_bytes, plugins_root, SCHEDULER_PLUGIN_KIND)

    assert plugin.name == "stub-scheduler"
    assert (plugins_root / "schedulers" / "stub-scheduler" / "manifest.json").exists()

    registry = discover_scheduler_plugins(plugins_root)
    assert set(registry) == {"stub-scheduler"}
```

- [ ] **Step 9: Run the new tests**

Run: `.venv/bin/pytest tests/test_plugin_loader.py tests/test_plugin_discovery.py tests/test_plugin_registry_generic.py -v`
Expected: all pass, including every pre-existing test in the first two files.

- [ ] **Step 10: Commit**

```bash
git add src/tournament_server/plugin_registry/loader.py \
        src/tournament_server/plugin_registry/discovery.py \
        src/tournament_server/plugin_registry/zip_install.py \
        src/tournament_server/routers/plugins.py \
        src/tournament_server/deps.py \
        src/tournament_server/services/ranking.py \
        src/tournament_server/app.py \
        tests/test_plugin_loader.py \
        tests/test_plugin_discovery.py \
        tests/test_plugin_registry_generic.py
git commit -m "Generalize plugin registry to support scheduler plugins alongside game plugins"
```

---

### Task 2: Generalize conformance/CLI by kind, and build the `simple_random` scheduler plugin

**Files:**
- Modify: `src/tournament_server/plugin_registry/conformance.py`
- Modify: `src/tournament_server/cli.py`
- Create: `plugins/schedulers/simple_random/manifest.json`
- Create: `plugins/schedulers/simple_random/plugin.py`
- Modify: `tests/conftest.py`
- Test: `tests/test_scheduler_plugins.py` (new)

**Interfaces:**
- Consumes: `PluginKind`, `GAME_PLUGIN_KIND`, `SCHEDULER_PLUGIN_KIND`, `load_plugin` from Task 1.
- Produces: `run_conformance_checks(plugin_dir: Path) -> ConformanceReport` now dispatches on manifest kind (used unchanged by `cli.py`'s `tm test-plugin`, and by Task 5/7's tests). The real, committed `plugins/schedulers/simple_random` plugin, whose `generate_schedule(teams, target_matches_per_team, teams_per_alliance, fields, field_sets, cross_session_pairing_history, constraints) -> matches` signature and return shape are consumed by Task 5's endpoint and Task 7's `balanced` plugin (same contract).

- [ ] **Step 1: Restructure `conformance.py` to dispatch by plugin kind**

In `src/tournament_server/plugin_registry/conformance.py`, change the import line:

```python
from tournament_server.plugin_registry.loader import load_game_plugin
```

to:

```python
from tournament_server.plugin_registry.loader import (
    GAME_PLUGIN_KIND,
    SCHEDULER_PLUGIN_KIND,
    load_plugin,
)
from tournament_server.plugin_registry.manifest import load_manifest

_KNOWN_KINDS = {
    GAME_PLUGIN_KIND.kind: GAME_PLUGIN_KIND,
    SCHEDULER_PLUGIN_KIND.kind: SCHEDULER_PLUGIN_KIND,
}
```

Then replace the `run_conformance_checks` function (currently lines 52-123 — from `def run_conformance_checks(plugin_dir: Path) -> ConformanceReport:` through the line before `def _check_match_format`) with:

```python
def run_conformance_checks(plugin_dir: Path) -> ConformanceReport:
    try:
        manifest = load_manifest(plugin_dir)
    except PluginLoadError as exc:
        return ConformanceReport(
            plugin_name=None, checks=[CheckResult("plugin loads", False, str(exc))]
        )

    kind = _KNOWN_KINDS.get(manifest.kind)
    if kind is None:
        return ConformanceReport(
            plugin_name=None,
            checks=[
                CheckResult(
                    "plugin loads", False, f"unknown plugin kind {manifest.kind!r}"
                )
            ],
        )

    try:
        plugin = load_plugin(plugin_dir, kind)
    except PluginLoadError as exc:
        return ConformanceReport(
            plugin_name=None, checks=[CheckResult("plugin loads", False, str(exc))]
        )

    if manifest.kind == "game":
        return _run_game_checks(plugin)
    return _run_scheduler_checks(plugin)


def _run_game_checks(plugin) -> ConformanceReport:
    checks: list[CheckResult] = [CheckResult("plugin loads", True)]

    checks.append(
        _safe_check("match_format() shape", lambda: _check_match_format(plugin.module))
    )

    schema_result = _safe_check(
        "scoresheet_schema() shape",
        lambda: _check_scoresheet_schema(plugin.module, "scoresheet_schema"),
    )
    checks.append(schema_result)

    skills_schema_result = _safe_check(
        "skills_scoresheet_schema() shape",
        lambda: _check_scoresheet_schema(plugin.module, "skills_scoresheet_schema"),
    )
    checks.append(skills_schema_result)

    if schema_result.passed:
        checks.append(
            _safe_check(
                "calculate_score() determinism",
                lambda: _check_calculate_score(plugin.module, "calculate_score"),
            )
        )
        checks.append(
            _safe_check("validate() shape", lambda: _check_validate(plugin.module))
        )
    else:
        checks.append(
            CheckResult(
                "calculate_score() determinism",
                False,
                "skipped: scoresheet_schema() is invalid",
            )
        )
        checks.append(
            CheckResult(
                "validate() shape", False, "skipped: scoresheet_schema() is invalid"
            )
        )

    if skills_schema_result.passed:
        checks.append(
            _safe_check(
                "calculate_skills_score() determinism",
                lambda: _check_calculate_score(plugin.module, "calculate_skills_score"),
            )
        )
    else:
        checks.append(
            CheckResult(
                "calculate_skills_score() determinism",
                False,
                "skipped: skills_scoresheet_schema() is invalid",
            )
        )

    checks.append(
        _safe_check("rank_teams() structure", lambda: _check_rank_teams(plugin.module))
    )

    return ConformanceReport(plugin_name=plugin.name, checks=checks)


def _run_scheduler_checks(plugin) -> ConformanceReport:
    checks: list[CheckResult] = [CheckResult("plugin loads", True)]
    checks.append(
        _safe_check(
            "generate_schedule() shape",
            lambda: _check_generate_schedule(plugin.module),
        )
    )
    return ConformanceReport(plugin_name=plugin.name, checks=checks)
```

(This is the same body the old `run_conformance_checks` had from `checks: list[CheckResult] = [CheckResult("plugin loads", True)]` onward — just moved into `_run_game_checks` taking the already-loaded `plugin` instead of loading it itself.)

- [ ] **Step 2: Add the scheduler conformance check function**

Append to the end of `src/tournament_server/plugin_registry/conformance.py`:

```python
def _check_generate_schedule(module: Any) -> CheckResult:
    teams = [{"team_id": i, "organization": None} for i in range(1, 5)]
    field_sets = [{"field_set_id": 1, "name": "Main Fields"}]
    fields = [{"field_id": 1, "field_set_id": 1}, {"field_id": 2, "field_set_id": 1}]

    result = module.generate_schedule(
        teams=teams,
        target_matches_per_team=2,
        teams_per_alliance=2,
        fields=fields,
        field_sets=field_sets,
        cross_session_pairing_history={},
        constraints={"excluded_team_ids": []},
    )

    if not isinstance(result, list):
        return CheckResult("generate_schedule() shape", False, "must return a list")

    for match in result:
        if not isinstance(match, dict):
            return CheckResult(
                "generate_schedule() shape", False, "each match must be a dict"
            )
        missing = {"time_slot", "field_set_id", "alliances"} - match.keys()
        if missing:
            return CheckResult(
                "generate_schedule() shape",
                False,
                f"match missing keys: {sorted(missing)}",
            )
        alliances = match["alliances"]
        if not isinstance(alliances, list) or len(alliances) != 2:
            return CheckResult(
                "generate_schedule() shape",
                False,
                "each match must have exactly 2 alliances",
            )
        stations = set()
        for alliance in alliances:
            if "station" not in alliance or "team_ids" not in alliance:
                return CheckResult(
                    "generate_schedule() shape",
                    False,
                    "alliance missing 'station' or 'team_ids'",
                )
            if not alliance["team_ids"]:
                return CheckResult(
                    "generate_schedule() shape",
                    False,
                    "alliance team_ids must be non-empty",
                )
            stations.add(alliance["station"])
        if stations != {"red", "blue"}:
            return CheckResult(
                "generate_schedule() shape",
                False,
                f"alliance stations must be exactly red/blue, got {sorted(stations)}",
            )

    return CheckResult("generate_schedule() shape", True)
```

- [ ] **Step 3: Update `cli.py`'s help text to be kind-neutral**

In `src/tournament_server/cli.py`, change:

```python
    test_plugin_parser = subparsers.add_parser(
        "test-plugin", help="Run conformance checks against a game plugin folder"
    )
```

to:

```python
    test_plugin_parser = subparsers.add_parser(
        "test-plugin", help="Run conformance checks against a plugin folder"
    )
```

- [ ] **Step 4: Run the existing conformance/CLI tests — must pass unchanged**

Run: `.venv/bin/pytest tests/test_plugin_conformance.py tests/test_cli.py -v`
Expected: all pass unchanged (game-plugin conformance behavior is identical, just reached through `_run_game_checks` now).

- [ ] **Step 5: Create the `simple_random` scheduler plugin's manifest**

Create `plugins/schedulers/simple_random/manifest.json`:

```json
{
  "name": "simple_random",
  "version": "1.0.0",
  "kind": "scheduler",
  "display_name": "Simple Random"
}
```

- [ ] **Step 6: Write `simple_random`'s `generate_schedule`**

Create `plugins/schedulers/simple_random/plugin.py`:

```python
from __future__ import annotations

import random
from typing import Any


def generate_schedule(
    teams: list[dict[str, Any]],
    target_matches_per_team: int,
    teams_per_alliance: int,
    fields: list[dict[str, Any]],
    field_sets: list[dict[str, Any]],
    cross_session_pairing_history: dict[Any, dict[str, int]],
    constraints: dict[str, Any],
) -> list[dict[str, Any]]:
    excluded = set(constraints.get("excluded_team_ids", []))
    team_ids = [t["team_id"] for t in teams if t["team_id"] not in excluded]

    alliance_size = teams_per_alliance
    match_size = alliance_size * 2
    if len(team_ids) < match_size:
        return []

    field_set_ids = sorted({fs["field_set_id"] for fs in field_sets})
    if not field_set_ids:
        return []

    total_matches = (len(team_ids) * target_matches_per_team) // match_size
    if total_matches < 1:
        return []

    appearances = {team_id: 0 for team_id in team_ids}
    matches: list[dict[str, Any]] = []
    time_slot = 0
    matches_made = 0

    while matches_made < total_matches:
        used_this_slot: set[int] = set()
        for field_set_id in field_set_ids:
            if matches_made >= total_matches:
                break
            available = [t for t in team_ids if t not in used_this_slot]
            if len(available) < match_size:
                break

            available.sort(key=lambda t: (appearances[t], random.random()))
            chosen = available[:match_size]
            random.shuffle(chosen)
            for team_id in chosen:
                appearances[team_id] += 1
                used_this_slot.add(team_id)

            alliances = []
            remaining = list(chosen)
            for station in ("red", "blue"):
                alliances.append(
                    {"station": station, "team_ids": remaining[:alliance_size]}
                )
                remaining = remaining[alliance_size:]

            matches.append(
                {
                    "time_slot": time_slot,
                    "field_set_id": field_set_id,
                    "alliances": alliances,
                }
            )
            matches_made += 1

        if not used_this_slot:
            break
        time_slot += 1

    return matches
```

(The `used_this_slot` tracking is what guarantees the concurrency-safety invariant Task 5's endpoint will check: within one `time_slot`, no team is picked into more than one match, since every field_set in that slot draws only from teams not yet used in it. The `if not used_this_slot: break` before incrementing `time_slot` prevents an infinite loop once too few teams remain for even one more match.)

- [ ] **Step 7: Wire `simple_random` into the test `client` fixture**

In `tests/conftest.py`, add below `FIXTURE_EXAMPLE_PLUGIN`:

```python
SIMPLE_RANDOM_SCHEDULER_PLUGIN = (
    Path(__file__).parent.parent / "plugins" / "schedulers" / "simple_random"
)
```

Replace the body of the `client` fixture with:

```python
@pytest.fixture()
def client(tmp_path) -> TestClient:
    db_path = str(tmp_path / "test.db")
    plugins_root = tmp_path / "plugins"

    games_target = plugins_root / "games" / "example-game"
    games_target.parent.mkdir(parents=True)
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, games_target)

    schedulers_target = plugins_root / "schedulers" / "simple_random"
    schedulers_target.parent.mkdir(parents=True)
    shutil.copytree(SIMPLE_RANDOM_SCHEDULER_PLUGIN, schedulers_target)

    app = create_app(db_path=db_path, plugins_root=str(plugins_root))
    return TestClient(app)
```

- [ ] **Step 8: Run the full suite — must pass unchanged**

Run: `.venv/bin/pytest tests/ -v`
Expected: same pass count as Task 1's end, plus nothing new failing. (No test yet asserts on `/api/plugins/schedulers` listing `simple_random`, but every `client`-based test now has it pre-seeded — this is why the full suite, not just the plugin tests, must be re-run here.)

- [ ] **Step 9: Add discovery/zip-install/conformance/CLI tests for `simple_random`**

Create `tests/test_scheduler_plugins.py`:

```python
from pathlib import Path

from plugin_helpers import zip_fixture_plugin
from tournament_server.cli import main
from tournament_server.plugin_registry.conformance import run_conformance_checks
from tournament_server.plugin_registry.discovery import discover_scheduler_plugins
from tournament_server.plugin_registry.loader import (
    SCHEDULER_PLUGIN_KIND,
    load_plugin,
)
from tournament_server.plugin_registry.zip_install import install_plugin_zip

SIMPLE_RANDOM_PLUGIN = (
    Path(__file__).parent.parent / "plugins" / "schedulers" / "simple_random"
)


def test_simple_random_loads_and_declares_scheduler_kind():
    plugin = load_plugin(SIMPLE_RANDOM_PLUGIN, SCHEDULER_PLUGIN_KIND)
    assert plugin.name == "simple_random"
    assert callable(plugin.module.generate_schedule)


def test_simple_random_discovered_from_a_plugins_root(tmp_path):
    import shutil

    target = tmp_path / "plugins" / "schedulers" / "simple_random"
    target.parent.mkdir(parents=True)
    shutil.copytree(SIMPLE_RANDOM_PLUGIN, target)

    registry = discover_scheduler_plugins(tmp_path / "plugins")
    assert set(registry) == {"simple_random"}


def test_simple_random_installs_via_zip(tmp_path):
    zip_bytes = zip_fixture_plugin(SIMPLE_RANDOM_PLUGIN)
    plugin = install_plugin_zip(zip_bytes, tmp_path / "plugins", SCHEDULER_PLUGIN_KIND)
    assert plugin.name == "simple_random"


def test_simple_random_passes_conformance():
    report = run_conformance_checks(SIMPLE_RANDOM_PLUGIN)
    assert report.passed, [c for c in report.checks if not c.passed]


def test_simple_random_produces_valid_schedule_shape():
    plugin = load_plugin(SIMPLE_RANDOM_PLUGIN, SCHEDULER_PLUGIN_KIND)
    teams = [{"team_id": i, "organization": None} for i in range(1, 9)]
    field_sets = [{"field_set_id": 1, "name": "Main Fields"}]
    fields = [{"field_id": 1, "field_set_id": 1}, {"field_id": 2, "field_set_id": 1}]

    matches = plugin.module.generate_schedule(
        teams=teams,
        target_matches_per_team=3,
        teams_per_alliance=2,
        fields=fields,
        field_sets=field_sets,
        cross_session_pairing_history={},
        constraints={"excluded_team_ids": []},
    )

    assert matches
    teams_by_slot: dict[int, set[int]] = {}
    for match in matches:
        slot_teams = teams_by_slot.setdefault(match["time_slot"], set())
        for alliance in match["alliances"]:
            for team_id in alliance["team_ids"]:
                assert team_id not in slot_teams, (
                    f"team {team_id} double-booked in time_slot {match['time_slot']}"
                )
                slot_teams.add(team_id)


def test_cli_test_plugin_passes_for_simple_random(capsys):
    exit_code = main(["test-plugin", str(SIMPLE_RANDOM_PLUGIN)])
    assert exit_code == 0
    assert "All checks passed" in capsys.readouterr().out
```

(`test_simple_random_produces_valid_schedule_shape` reuses `load_plugin` — already imported at the top of this file — to get a real, callable `generate_schedule` and directly asserts the concurrency-safety invariant: no team appears twice within one `time_slot`.)

- [ ] **Step 10: Run the new tests**

Run: `.venv/bin/pytest tests/test_scheduler_plugins.py tests/test_plugin_conformance.py tests/test_cli.py -v`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add src/tournament_server/plugin_registry/conformance.py \
        src/tournament_server/cli.py \
        plugins/schedulers/simple_random/manifest.json \
        plugins/schedulers/simple_random/plugin.py \
        tests/conftest.py \
        tests/test_scheduler_plugins.py
git commit -m "Add kind-dispatching conformance checks and the simple_random scheduler plugin"
```

---

### Task 3: Field & FieldSet models, schemas, and CRUD endpoints

**Files:**
- Create: `src/tournament_server/models/field_set.py`
- Create: `src/tournament_server/models/field.py`
- Modify: `src/tournament_server/models/__init__.py`
- Create: `src/tournament_server/schemas/field_set.py`
- Create: `src/tournament_server/schemas/field.py`
- Create: `src/tournament_server/routers/field_sets.py`
- Create: `src/tournament_server/routers/fields.py`
- Modify: `src/tournament_server/app.py`
- Test: `tests/test_field_sets.py` (new)
- Test: `tests/test_fields.py` (new)

**Interfaces:**
- Produces: `FieldSet(id, session_id, name)`, `Field(id, field_set_id, name)` models; `POST/GET /api/field-sets`, `POST/GET /api/fields` — consumed by Task 5's schedule-generation endpoint (reads `FieldSet`/`Field` rows for a session) and Task 4 (`Match.field_id` FKs to `Field.id`).
- Consumes: `get_db`, `get_session_id` from `deps.py` (existing).

- [ ] **Step 1: Write the FieldSet model**

Create `src/tournament_server/models/field_set.py`:

```python
from __future__ import annotations

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class FieldSet(Base):
    __tablename__ = "field_sets"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    name: Mapped[str] = mapped_column(String(200))
```

- [ ] **Step 2: Write the Field model**

Create `src/tournament_server/models/field.py`:

```python
from __future__ import annotations

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class Field(Base):
    __tablename__ = "fields"

    id: Mapped[int] = mapped_column(primary_key=True)
    field_set_id: Mapped[int] = mapped_column(ForeignKey("field_sets.id"))
    name: Mapped[str] = mapped_column(String(200))
```

- [ ] **Step 3: Register both models in `models/__init__.py`**

Replace the contents of `src/tournament_server/models/__init__.py` with:

```python
from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.division import Division
from tournament_server.models.event import Event
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.match import Match
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.ranking import Ranking
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team

__all__ = [
    "Alliance",
    "AllianceTeam",
    "Division",
    "Event",
    "Field",
    "FieldSet",
    "Match",
    "Ranking",
    "ScoreRecord",
    "SessionParticipation",
    "TournamentSession",
    "Team",
]
```

(A model not listed here never gets a table via `Base.metadata.create_all()` — this step is easy to forget and the failure mode is a confusing `no such table` at runtime, not an import error.)

- [ ] **Step 4: Write the schemas**

Create `src/tournament_server/schemas/field_set.py`:

```python
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class FieldSetCreate(BaseModel):
    session_id: int
    name: str


class FieldSetRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    session_id: int
    name: str
```

Create `src/tournament_server/schemas/field.py`:

```python
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class FieldCreate(BaseModel):
    session_id: int
    name: str
    field_set_id: int | None = None


class FieldRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    field_set_id: int
    name: str
```

- [ ] **Step 5: Write the FieldSet router**

Create `src/tournament_server/routers/field_sets.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_session_id
from tournament_server.models.field_set import FieldSet
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.field_set import FieldSetCreate, FieldSetRead

router = APIRouter(prefix="/api/field-sets", tags=["field-sets"])


@router.post("", response_model=FieldSetRead, status_code=201)
def create_field_set(payload: FieldSetCreate, db: Session = Depends(get_db)) -> FieldSet:
    if db.get(TournamentSession, payload.session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    field_set = FieldSet(session_id=payload.session_id, name=payload.name)
    db.add(field_set)
    db.commit()
    db.refresh(field_set)
    return field_set


@router.get("", response_model=list[FieldSetRead])
def list_field_sets(
    session_id: int = Depends(get_session_id), db: Session = Depends(get_db)
) -> list[FieldSet]:
    return list(
        db.execute(
            select(FieldSet).where(FieldSet.session_id == session_id)
        ).scalars().all()
    )
```

- [ ] **Step 6: Write the Field router, with the auto-default-FieldSet rule**

Create `src/tournament_server/routers/fields.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_session_id
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.field import FieldCreate, FieldRead

router = APIRouter(prefix="/api/fields", tags=["fields"])


@router.post("", response_model=FieldRead, status_code=201)
def create_field(payload: FieldCreate, db: Session = Depends(get_db)) -> Field:
    if db.get(TournamentSession, payload.session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")

    field_set_id = payload.field_set_id
    if field_set_id is None:
        existing_sets = db.execute(
            select(FieldSet).where(FieldSet.session_id == payload.session_id)
        ).scalars().all()
        if len(existing_sets) == 0:
            default_set = FieldSet(session_id=payload.session_id, name="Main Fields")
            db.add(default_set)
            db.flush()
            field_set_id = default_set.id
        elif len(existing_sets) == 1:
            field_set_id = existing_sets[0].id
        else:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Multiple FieldSets exist for this session; field_set_id "
                    "must be specified"
                ),
            )
    else:
        field_set = db.get(FieldSet, field_set_id)
        if field_set is None or field_set.session_id != payload.session_id:
            raise HTTPException(status_code=404, detail="FieldSet not found")

    field = Field(field_set_id=field_set_id, name=payload.name)
    db.add(field)
    db.commit()
    db.refresh(field)
    return field


@router.get("", response_model=list[FieldRead])
def list_fields(
    session_id: int = Depends(get_session_id), db: Session = Depends(get_db)
) -> list[Field]:
    field_set_ids = [
        row.id
        for row in db.execute(
            select(FieldSet).where(FieldSet.session_id == session_id)
        ).scalars().all()
    ]
    if not field_set_ids:
        return []
    return list(
        db.execute(
            select(Field).where(Field.field_set_id.in_(field_set_ids))
        ).scalars().all()
    )
```

- [ ] **Step 7: Wire both routers into `app.py`**

In `src/tournament_server/app.py`, add `field_sets` and `fields` to the `from tournament_server.routers import (...)` block (alphabetically, matching the existing ordering), and add:

```python
    app.include_router(field_sets.router)
    app.include_router(fields.router)
```

alongside the other `app.include_router(...)` calls.

- [ ] **Step 8: Write the failing tests**

Create `tests/test_field_sets.py`:

```python
def _make_session(client) -> int:
    return client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]


def test_create_field_set(client):
    session_id = _make_session(client)
    response = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Main Fields"}
    )
    assert response.status_code == 201
    body = response.json()
    assert body["session_id"] == session_id
    assert body["name"] == "Main Fields"


def test_create_field_set_rejects_unknown_session(client):
    response = client.post(
        "/api/field-sets", json={"session_id": 999, "name": "Main Fields"}
    )
    assert response.status_code == 404


def test_list_field_sets_for_session(client):
    session_id = _make_session(client)
    client.post("/api/field-sets", json={"session_id": session_id, "name": "Odd Fields"})
    client.post("/api/field-sets", json={"session_id": session_id, "name": "Even Fields"})

    response = client.get(f"/api/field-sets?session_id={session_id}")
    assert response.status_code == 200
    names = {fs["name"] for fs in response.json()}
    assert names == {"Odd Fields", "Even Fields"}
```

Create `tests/test_fields.py`:

```python
def _make_session(client) -> int:
    return client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]


def test_create_field_with_no_field_set_creates_default(client):
    session_id = _make_session(client)
    response = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    )
    assert response.status_code == 201
    field = response.json()

    field_sets = client.get(f"/api/field-sets?session_id={session_id}").json()
    assert len(field_sets) == 1
    assert field_sets[0]["name"] == "Main Fields"
    assert field["field_set_id"] == field_sets[0]["id"]


def test_create_second_field_reuses_the_single_existing_field_set(client):
    session_id = _make_session(client)
    first = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    ).json()
    second = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 2"}
    ).json()

    assert second["field_set_id"] == first["field_set_id"]
    field_sets = client.get(f"/api/field-sets?session_id={session_id}").json()
    assert len(field_sets) == 1


def test_create_field_with_explicit_field_set(client):
    session_id = _make_session(client)
    field_set = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Odd Fields"}
    ).json()

    response = client.post(
        "/api/fields",
        json={
            "session_id": session_id,
            "name": "Field 1",
            "field_set_id": field_set["id"],
        },
    )
    assert response.status_code == 201
    assert response.json()["field_set_id"] == field_set["id"]


def test_create_field_omitting_field_set_is_ambiguous_with_two_existing(client):
    session_id = _make_session(client)
    client.post("/api/field-sets", json={"session_id": session_id, "name": "Odd Fields"})
    client.post("/api/field-sets", json={"session_id": session_id, "name": "Even Fields"})

    response = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    )
    assert response.status_code == 422


def test_create_field_rejects_unknown_field_set(client):
    session_id = _make_session(client)
    response = client.post(
        "/api/fields",
        json={"session_id": session_id, "name": "Field 1", "field_set_id": 999},
    )
    assert response.status_code == 404


def test_list_fields_for_session(client):
    session_id = _make_session(client)
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 2"})

    response = client.get(f"/api/fields?session_id={session_id}")
    assert response.status_code == 200
    names = {f["name"] for f in response.json()}
    assert names == {"Field 1", "Field 2"}
```

- [ ] **Step 9: Run the new tests, then the full suite**

Run: `.venv/bin/pytest tests/test_field_sets.py tests/test_fields.py -v`
Expected: all pass.

Run: `.venv/bin/pytest tests/ -v`
Expected: same total as Task 2's end, plus these 9 new tests, all passing.

- [ ] **Step 10: Commit**

```bash
git add src/tournament_server/models/field_set.py \
        src/tournament_server/models/field.py \
        src/tournament_server/models/__init__.py \
        src/tournament_server/schemas/field_set.py \
        src/tournament_server/schemas/field.py \
        src/tournament_server/routers/field_sets.py \
        src/tournament_server/routers/fields.py \
        src/tournament_server/app.py \
        tests/test_field_sets.py \
        tests/test_fields.py
git commit -m "Add Field/FieldSet models, schemas, and CRUD endpoints"
```

---

### Task 4: Match model changes (`field_id` FK, `time_slot`), and the `ScheduleGeneration` model

**Files:**
- Modify: `src/tournament_server/models/match.py`
- Create: `src/tournament_server/models/schedule_generation.py`
- Modify: `src/tournament_server/models/__init__.py`
- Modify: `src/tournament_server/schemas/match.py`
- Modify: `src/tournament_server/routers/matches.py`
- Modify: `tests/test_matches.py`
- Modify: `tests/test_scores.py`
- Modify: `tests/test_rankings.py`

**Interfaces:**
- Produces: `Match.field_id: int | None` (FK `fields.id`), `Match.time_slot: int | None`, `Match.schedule_generation_id: int | None` (FK `schedule_generations.id`); `ScheduleGeneration(id, session_id, division_id, round_type, scheduler_plugin_name, scheduler_plugin_version, target_matches_per_team, generated_at)` — consumed by Task 5 (creates `ScheduleGeneration` rows and FK's Matches to them) and Task 6 (deletes Matches by `round_type`/`division_id`).
- Consumes: `Field` from Task 3 (FK target).

This task changes `Match.field_id`'s type from a plain string to an `int | None` FK. Every pre-existing test that creates a match with `"field_id": "Field 1"` must be updated to `"field_id": None` — none of those tests assert on the returned `field_id` value, so this is a pure type fixup, not a behavior change.

- [ ] **Step 1: Update the Match model**

Replace the contents of `src/tournament_server/models/match.py` with:

```python
from __future__ import annotations

import datetime as dt

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime


class Match(Base):
    __tablename__ = "matches"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    round_type: Mapped[str] = mapped_column(String(20))
    match_number: Mapped[int] = mapped_column(Integer)
    field_id: Mapped[int | None] = mapped_column(ForeignKey("fields.id"), default=None)
    time_slot: Mapped[int | None] = mapped_column(Integer, default=None)
    schedule_generation_id: Mapped[int | None] = mapped_column(
        ForeignKey("schedule_generations.id"), default=None
    )
    scheduled_time: Mapped[dt.datetime | None] = mapped_column(
        UTCDateTime, default=None
    )
    status: Mapped[str] = mapped_column(String(20), default="scheduled")
```

- [ ] **Step 2: Write the ScheduleGeneration model**

Create `src/tournament_server/models/schedule_generation.py`:

```python
from __future__ import annotations

import datetime as dt

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime


class ScheduleGeneration(Base):
    __tablename__ = "schedule_generations"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    round_type: Mapped[str] = mapped_column(String(20))
    scheduler_plugin_name: Mapped[str] = mapped_column(String(200))
    scheduler_plugin_version: Mapped[str] = mapped_column(String(50))
    target_matches_per_team: Mapped[int] = mapped_column(Integer)
    generated_at: Mapped[dt.datetime] = mapped_column(UTCDateTime)
```

- [ ] **Step 3: Register `ScheduleGeneration` in `models/__init__.py`**

In `src/tournament_server/models/__init__.py`, add the import:

```python
from tournament_server.models.schedule_generation import ScheduleGeneration
```

(insert alphabetically, after `ranking` and before `score_record`) and add `"ScheduleGeneration"` to `__all__` in the same alphabetical position.

- [ ] **Step 4: Update the Match schemas**

Replace the contents of `src/tournament_server/schemas/match.py` with:

```python
from __future__ import annotations

import datetime as dt

from pydantic import BaseModel


class AllianceCreate(BaseModel):
    station: str
    team_ids: list[int]


class AllianceRead(BaseModel):
    id: int
    station: str
    team_ids: list[int]


class MatchCreate(BaseModel):
    session_id: int | None = None
    division_id: int | None = None
    round_type: str
    match_number: int
    field_id: int | None = None
    scheduled_time: dt.datetime | None = None
    alliances: list[AllianceCreate]


class MatchRead(BaseModel):
    id: int
    session_id: int
    division_id: int | None
    round_type: str
    match_number: int
    field_id: int | None
    time_slot: int | None
    scheduled_time: dt.datetime | None
    status: str
    alliances: list[AllianceRead]
```

- [ ] **Step 5: Validate `field_id` and populate `time_slot` in `routers/matches.py`**

In `src/tournament_server/routers/matches.py`, add the import:

```python
from tournament_server.models.field import Field
```

(alongside the existing model imports). In `_to_match_read`, add `time_slot=match.time_slot,` to the `MatchRead(...)` construction (any position — keyword args). In `create_match`, add a field-id validation check right after the existing division_id check:

```python
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")
    if payload.field_id is not None and db.get(Field, payload.field_id) is None:
        raise HTTPException(status_code=404, detail="Field not found")
```

(The `Match(...)` construction already passes `field_id=payload.field_id` through unchanged — no other change needed there. `time_slot` isn't set by manual match creation; it defaults to `None`, which is correct — only schedule-generated matches (Task 5) have a `time_slot`.)

- [ ] **Step 6: Fix pre-existing tests for the new `field_id` type**

In `tests/test_matches.py`, `tests/test_scores.py`, and `tests/test_rankings.py`, every occurrence of:

```python
            "field_id": "Field 1",
```

becomes:

```python
            "field_id": None,
```

(7 occurrences in `test_matches.py`, 2 in `test_scores.py`, 2 in `test_rankings.py` — none of these tests assert on the returned `field_id` value, confirmed by grepping for `["field_id"]` across all three files before this task, so this is a pure type fixup.)

- [ ] **Step 7: Add a field_id validation test, mirroring the existing division_id one**

Add to `tests/test_matches.py` (near `test_create_match_rejects_unknown_division`):

```python
def test_create_match_rejects_unknown_field(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)

    response = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": 999,
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    )
    assert response.status_code == 404
```

- [ ] **Step 8: Run the affected tests, then the full suite**

Run: `.venv/bin/pytest tests/test_matches.py tests/test_scores.py tests/test_rankings.py -v`
Expected: all pass, including the new `test_create_match_rejects_unknown_field`.

Run: `.venv/bin/pytest tests/ -v`
Expected: same total as Task 3's end, plus this one new test.

- [ ] **Step 9: Commit**

```bash
git add src/tournament_server/models/match.py \
        src/tournament_server/models/schedule_generation.py \
        src/tournament_server/models/__init__.py \
        src/tournament_server/schemas/match.py \
        src/tournament_server/routers/matches.py \
        tests/test_matches.py \
        tests/test_scores.py \
        tests/test_rankings.py
git commit -m "Change Match.field_id to a real FK and add time_slot/schedule_generation_id"
```

---

### Task 5: `POST /api/schedule` — pairing history, plugin invocation, structural validation, persistence

**Files:**
- Create: `src/tournament_server/services/scheduling.py`
- Create: `src/tournament_server/schemas/schedule.py`
- Create: `src/tournament_server/routers/schedule.py`
- Modify: `src/tournament_server/app.py`
- Test: `tests/test_schedule.py` (new)

**Interfaces:**
- Consumes: `Field`/`FieldSet` (Task 3), `Match.time_slot`/`schedule_generation_id`/`ScheduleGeneration` (Task 4), `get_game_plugin_for_event` (existing, `deps.py`), the `simple_random` plugin (Task 2, pre-seeded by `conftest.py`).
- Produces: `build_pairing_history(db, event_id) -> dict[frozenset[int], dict[str, int]]` (consumed by Task 7's `balanced` plugin tests, indirectly, since `balanced` receives this same shape); `POST /api/schedule` — consumed by Task 6 (the `DELETE /api/schedule` counterpart lives in the same router file).

- [ ] **Step 1: Write the cross-session pairing history builder**

Create `src/tournament_server/services/scheduling.py`:

```python
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.match import Match
from tournament_server.models.session import TournamentSession


def build_pairing_history(
    db: Session, event_id: int
) -> dict[frozenset[int], dict[str, int]]:
    session_ids = [
        row.id
        for row in db.execute(
            select(TournamentSession).where(TournamentSession.event_id == event_id)
        ).scalars().all()
    ]
    if not session_ids:
        return {}

    matches = db.execute(
        select(Match).where(Match.session_id.in_(session_ids))
    ).scalars().all()

    history: dict[frozenset[int], dict[str, int]] = {}

    def bump(a: int, b: int, key: str) -> None:
        pair = frozenset((a, b))
        entry = history.setdefault(pair, {"partner_count": 0, "opponent_count": 0})
        entry[key] += 1

    for match in matches:
        alliances = db.execute(
            select(Alliance).where(Alliance.match_id == match.id)
        ).scalars().all()
        if len(alliances) != 2:
            continue

        teams_by_alliance: list[list[int]] = []
        for alliance in alliances:
            team_ids = [
                row.team_id
                for row in db.execute(
                    select(AllianceTeam).where(AllianceTeam.alliance_id == alliance.id)
                ).scalars().all()
            ]
            teams_by_alliance.append(team_ids)
            for i in range(len(team_ids)):
                for j in range(i + 1, len(team_ids)):
                    bump(team_ids[i], team_ids[j], "partner_count")

        for a in teams_by_alliance[0]:
            for b in teams_by_alliance[1]:
                bump(a, b, "opponent_count")

    return history
```

- [ ] **Step 2: Write the schedule-generation request/response schemas**

Create `src/tournament_server/schemas/schedule.py`:

```python
from __future__ import annotations

from pydantic import BaseModel


class ScheduleGenerateRequest(BaseModel):
    session_id: int
    division_id: int | None = None
    round_type: str
    target_matches_per_team: int
    scheduler_plugin_name: str
    excluded_team_ids: list[int] = []


class ScheduleGenerateResponse(BaseModel):
    schedule_generation_id: int
    match_count: int
```

- [ ] **Step 3: Write the `POST /api/schedule` router**

Create `src/tournament_server/routers/schedule.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.db import utc_now
from tournament_server.deps import get_db, get_the_event
from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.division import Division
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.match import Match
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.schedule_generation import ScheduleGeneration
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.schemas.schedule import (
    ScheduleGenerateRequest,
    ScheduleGenerateResponse,
)
from tournament_server.services.scheduling import build_pairing_history

router = APIRouter(prefix="/api/schedule", tags=["schedule"])


def _validate_generated_schedule(
    generated: list, valid_field_set_ids: set[int]
) -> None:
    if not isinstance(generated, list) or not generated:
        raise HTTPException(
            status_code=422, detail="Scheduler plugin returned no matches"
        )

    teams_by_slot: dict[int, set[int]] = {}
    for entry in generated:
        if not isinstance(entry, dict):
            raise HTTPException(
                status_code=422, detail="Scheduler plugin returned a malformed match"
            )
        missing = {"time_slot", "field_set_id", "alliances"} - entry.keys()
        if missing:
            raise HTTPException(
                status_code=422,
                detail=f"Scheduler plugin returned a match missing keys: {sorted(missing)}",
            )
        if entry["field_set_id"] not in valid_field_set_ids:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Scheduler plugin returned an unknown field_set_id "
                    f"{entry['field_set_id']!r}"
                ),
            )
        alliances = entry["alliances"]
        if not isinstance(alliances, list) or len(alliances) != 2:
            raise HTTPException(
                status_code=422, detail="Each match must have exactly 2 alliances"
            )
        stations = set()
        slot_teams = teams_by_slot.setdefault(entry["time_slot"], set())
        for alliance in alliances:
            if "station" not in alliance or "team_ids" not in alliance:
                raise HTTPException(
                    status_code=422,
                    detail="Scheduler plugin returned an alliance missing 'station' or 'team_ids'",
                )
            if not alliance["team_ids"]:
                raise HTTPException(
                    status_code=422,
                    detail="Scheduler plugin returned an alliance with no teams",
                )
            stations.add(alliance["station"])
            for team_id in alliance["team_ids"]:
                if team_id in slot_teams:
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            f"Scheduler plugin double-booked team {team_id} in "
                            f"time_slot {entry['time_slot']}"
                        ),
                    )
                slot_teams.add(team_id)
        if stations != {"red", "blue"}:
            raise HTTPException(
                status_code=422,
                detail=f"Alliance stations must be exactly red/blue, got {sorted(stations)}",
            )


@router.post("", response_model=ScheduleGenerateResponse, status_code=201)
def generate_schedule(
    payload: ScheduleGenerateRequest, request: Request, db: Session = Depends(get_db)
) -> ScheduleGenerateResponse:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if event.game_plugin_name is None:
        raise HTTPException(
            status_code=422, detail="No game plugin has been selected for this event"
        )
    game_plugin = request.app.state.game_plugins.get(event.game_plugin_name)
    if game_plugin is None:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Event's selected game plugin {event.game_plugin_name!r} is not "
                "currently loaded"
            ),
        )

    if db.get(TournamentSession, payload.session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")

    scheduler_plugin = request.app.state.scheduler_plugins.get(
        payload.scheduler_plugin_name
    )
    if scheduler_plugin is None:
        raise HTTPException(
            status_code=404,
            detail=f"Scheduler plugin {payload.scheduler_plugin_name!r} is not installed",
        )

    existing_query = select(Match).where(
        Match.session_id == payload.session_id, Match.round_type == payload.round_type
    )
    if payload.division_id is None:
        existing_query = existing_query.where(Match.division_id.is_(None))
    else:
        existing_query = existing_query.where(Match.division_id == payload.division_id)
    if db.execute(existing_query).scalars().first() is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                "Matches already exist for this session/division/round_type; "
                "clear them with DELETE /api/schedule before regenerating"
            ),
        )

    participation_query = select(SessionParticipation).where(
        SessionParticipation.session_id == payload.session_id,
        SessionParticipation.checked_in.is_(True),
    )
    team_ids_in_session = [
        row.team_id for row in db.execute(participation_query).scalars().all()
    ]
    team_query = select(Team).where(Team.id.in_(team_ids_in_session))
    if payload.division_id is None:
        team_query = team_query.where(Team.division_id.is_(None))
    else:
        team_query = team_query.where(Team.division_id == payload.division_id)
    teams = db.execute(team_query).scalars().all()

    field_sets = db.execute(
        select(FieldSet).where(FieldSet.session_id == payload.session_id)
    ).scalars().all()
    if not field_sets:
        raise HTTPException(status_code=422, detail="Session has no FieldSets configured")
    fields = db.execute(
        select(Field).where(Field.field_set_id.in_([fs.id for fs in field_sets]))
    ).scalars().all()
    if not fields:
        raise HTTPException(status_code=422, detail="Session has no Fields configured")

    match_format = game_plugin.module.match_format()
    teams_per_alliance = match_format["teams_per_alliance"]

    pairing_history = build_pairing_history(db, event.id)

    try:
        generated = scheduler_plugin.module.generate_schedule(
            teams=[{"team_id": t.id, "organization": t.organization} for t in teams],
            target_matches_per_team=payload.target_matches_per_team,
            teams_per_alliance=teams_per_alliance,
            fields=[{"field_id": f.id, "field_set_id": f.field_set_id} for f in fields],
            field_sets=[{"field_set_id": fs.id, "name": fs.name} for fs in field_sets],
            cross_session_pairing_history=pairing_history,
            constraints={"excluded_team_ids": payload.excluded_team_ids},
        )
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Scheduler plugin could not generate a schedule: {exc}",
        )

    _validate_generated_schedule(generated, {fs.id for fs in field_sets})

    generation = ScheduleGeneration(
        session_id=payload.session_id,
        division_id=payload.division_id,
        round_type=payload.round_type,
        scheduler_plugin_name=scheduler_plugin.name,
        scheduler_plugin_version=scheduler_plugin.version,
        target_matches_per_team=payload.target_matches_per_team,
        generated_at=utc_now(),
    )
    db.add(generation)
    db.flush()

    fields_by_set: dict[int, list[int]] = {}
    for f in fields:
        fields_by_set.setdefault(f.field_set_id, []).append(f.id)
    for field_ids in fields_by_set.values():
        field_ids.sort()
    next_field_index: dict[int, int] = {fs_id: 0 for fs_id in fields_by_set}

    created_matches = []
    for match_number, entry in enumerate(generated, start=1):
        field_set_id = entry["field_set_id"]
        field_ids_for_set = fields_by_set[field_set_id]
        field_id = field_ids_for_set[next_field_index[field_set_id] % len(field_ids_for_set)]
        next_field_index[field_set_id] += 1

        match = Match(
            session_id=payload.session_id,
            division_id=payload.division_id,
            round_type=payload.round_type,
            match_number=match_number,
            field_id=field_id,
            time_slot=entry["time_slot"],
            schedule_generation_id=generation.id,
        )
        db.add(match)
        db.flush()
        for alliance_entry in entry["alliances"]:
            alliance = Alliance(match_id=match.id, station=alliance_entry["station"])
            db.add(alliance)
            db.flush()
            for team_id in alliance_entry["team_ids"]:
                db.add(AllianceTeam(alliance_id=alliance.id, team_id=team_id))
        created_matches.append(match)

    db.commit()

    return ScheduleGenerateResponse(
        schedule_generation_id=generation.id, match_count=len(created_matches)
    )
```

- [ ] **Step 4: Wire the router into `app.py`**

In `src/tournament_server/app.py`, add `schedule` to the `from tournament_server.routers import (...)` block, and add:

```python
    app.include_router(schedule.router)
```

- [ ] **Step 5: Write the tests**

Create `tests/test_schedule.py`:

```python
def _setup_ready_session(client, num_teams: int = 8) -> tuple[int, list[int]]:
    client.post("/api/event", json={"name": "Regional Qualifier"})

    plugins = client.get("/api/plugins/games").json()
    game_plugin_name = plugins[0]["name"]
    client.post("/api/event/game-plugin", json={"name": game_plugin_name})

    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    team_ids = []
    for i in range(num_teams):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        team_ids.append(team_id)
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )

    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 2"})

    return session_id, team_ids


def test_generate_schedule_creates_matches(client):
    session_id, team_ids = _setup_ready_session(client)

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["match_count"] > 0

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert len(matches) == body["match_count"]
    for match in matches:
        assert match["round_type"] == "qualification"
        assert match["field_id"] is not None
        assert match["time_slot"] is not None
        assert len(match["alliances"]) == 2


def test_generate_schedule_rejects_when_matches_already_exist(client):
    session_id, _ = _setup_ready_session(client)
    payload = {
        "session_id": session_id,
        "round_type": "qualification",
        "target_matches_per_team": 3,
        "scheduler_plugin_name": "simple_random",
    }
    client.post("/api/schedule", json=payload)

    response = client.post("/api/schedule", json=payload)
    assert response.status_code == 409


def test_generate_schedule_rejects_unknown_scheduler_plugin(client):
    session_id, _ = _setup_ready_session(client)
    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "does-not-exist",
        },
    )
    assert response.status_code == 404


def test_generate_schedule_rejects_double_booking_plugin_output(client):
    session_id, team_ids = _setup_ready_session(client)

    import types

    from tournament_server.plugin_registry.loader import LoadedPlugin

    def bad_generate_schedule(**kwargs):
        field_set_id = kwargs["field_sets"][0]["field_set_id"]
        return [
            {
                "time_slot": 0,
                "field_set_id": field_set_id,
                "alliances": [
                    {"station": "red", "team_ids": [team_ids[0], team_ids[1]]},
                    {"station": "blue", "team_ids": [team_ids[2], team_ids[3]]},
                ],
            },
            {
                "time_slot": 0,
                "field_set_id": field_set_id,
                "alliances": [
                    {"station": "red", "team_ids": [team_ids[0], team_ids[4]]},
                    {"station": "blue", "team_ids": [team_ids[5], team_ids[6]]},
                ],
            },
        ]

    stub = LoadedPlugin(
        name="simple_random",
        version="1.0.0",
        display_name="Simple Random",
        folder=None,
        module=types.SimpleNamespace(generate_schedule=bad_generate_schedule),
    )
    client.app.state.scheduler_plugins["simple_random"] = stub

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 422
    assert "double-booked" in response.json()["detail"]
```

(`test_generate_schedule_rejects_double_booking_plugin_output` swaps `simple_random`'s registry entry for a stub module whose `generate_schedule` deliberately reuses `team_ids[0]` in two matches sharing `time_slot=0` — this is what proves the endpoint's own structural validation catches a broken/malicious plugin, independent of whether the real `simple_random` ever produces that output.)

- [ ] **Step 6: Run the tests**

Run: `.venv/bin/pytest tests/test_schedule.py -v`
Expected: all 4 pass.

Run: `.venv/bin/pytest tests/ -v`
Expected: same total as Task 4's end, plus these 4.

- [ ] **Step 7: Commit**

```bash
git add src/tournament_server/services/scheduling.py \
        src/tournament_server/schemas/schedule.py \
        src/tournament_server/routers/schedule.py \
        src/tournament_server/app.py \
        tests/test_schedule.py
git commit -m "Add POST /api/schedule: pairing history, plugin invocation, structural validation"
```

---

### Task 6: `DELETE /api/schedule`

**Files:**
- Modify: `src/tournament_server/routers/schedule.py`
- Test: `tests/test_schedule.py`

**Interfaces:**
- Consumes: everything from Task 5 (same router file, same test file).
- Produces: `DELETE /api/schedule?session_id=&division_id=&round_type=` — no later task depends on this.

- [ ] **Step 1: Add the clear-schedule endpoint**

In `src/tournament_server/routers/schedule.py`, add the import:

```python
from tournament_server.models.ranking import Ranking
from tournament_server.models.score_record import ScoreRecord
```

(alongside the existing model imports), then append at the end of the file:

```python
@router.delete("")
def clear_schedule(
    session_id: int = Query(...),
    division_id: int | None = Query(None),
    round_type: str = Query(...),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    match_query = select(Match).where(
        Match.session_id == session_id, Match.round_type == round_type
    )
    if division_id is None:
        match_query = match_query.where(Match.division_id.is_(None))
    else:
        match_query = match_query.where(Match.division_id == division_id)
    matches = db.execute(match_query).scalars().all()

    for match in matches:
        alliances = db.execute(
            select(Alliance).where(Alliance.match_id == match.id)
        ).scalars().all()
        for alliance in alliances:
            for record in db.execute(
                select(ScoreRecord).where(ScoreRecord.alliance_id == alliance.id)
            ).scalars().all():
                db.delete(record)
            for alliance_team in db.execute(
                select(AllianceTeam).where(AllianceTeam.alliance_id == alliance.id)
            ).scalars().all():
                db.delete(alliance_team)
            db.delete(alliance)
        db.delete(match)

    ranking_query = select(Ranking).where(Ranking.session_id == session_id)
    if division_id is None:
        ranking_query = ranking_query.where(Ranking.division_id.is_(None))
    else:
        ranking_query = ranking_query.where(Ranking.division_id == division_id)
    for ranking in db.execute(ranking_query).scalars().all():
        db.delete(ranking)

    db.commit()
    return {"matches_deleted": len(matches)}
```

(This uses ORM `db.delete(obj)` for every row, one at a time, rather than a bulk `Table.delete()` statement — required so `audit.py`'s mapper-level `after_delete` events fire and each deletion is captured in the audit log, per this plan's Global Constraints. At hobby-tournament scale — dozens to low hundreds of matches per session — this is not a performance concern.)

- [ ] **Step 2: Write the tests**

Append to `tests/test_schedule.py`:

```python
def test_clear_schedule_deletes_matches_and_rankings(client):
    session_id, team_ids = _setup_ready_session(client)
    client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
        },
    )
    matches_before = client.get(f"/api/matches?session_id={session_id}").json()
    match = matches_before[0]
    for alliance in match["alliances"]:
        client.post(
            f"/api/matches/{match['id']}/alliances/{alliance['id']}/score",
            json={"data": {"high_balls": 1, "low_balls": 1}},
        )

    rankings_before = client.get(f"/api/rankings?session_id={session_id}").json()
    assert rankings_before != []  # the completed match above must have produced rankings

    response = client.delete(
        "/api/schedule",
        params={"session_id": session_id, "round_type": "qualification"},
    )
    assert response.status_code == 200
    assert response.json()["matches_deleted"] == len(matches_before)

    remaining_matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert remaining_matches == []

    rankings_after = client.get(f"/api/rankings?session_id={session_id}").json()
    assert rankings_after == []


def test_clear_schedule_allows_regeneration_afterward(client):
    session_id, team_ids = _setup_ready_session(client)
    payload = {
        "session_id": session_id,
        "round_type": "qualification",
        "target_matches_per_team": 3,
        "scheduler_plugin_name": "simple_random",
    }
    client.post("/api/schedule", json=payload)
    client.delete(
        "/api/schedule",
        params={"session_id": session_id, "round_type": "qualification"},
    )

    response = client.post("/api/schedule", json=payload)
    assert response.status_code == 201
```

- [ ] **Step 3: Run the tests**

Run: `.venv/bin/pytest tests/test_schedule.py -v`
Expected: all 6 pass.

Run: `.venv/bin/pytest tests/ -v`
Expected: same total as Task 5's end, plus these 2.

- [ ] **Step 4: Commit**

```bash
git add src/tournament_server/routers/schedule.py tests/test_schedule.py
git commit -m "Add DELETE /api/schedule to clear matches and stale rankings"
```

---

### Task 7: The `balanced` scheduler plugin

**Files:**
- Create: `plugins/schedulers/balanced/manifest.json`
- Create: `plugins/schedulers/balanced/plugin.py`
- Modify: `tests/conftest.py`
- Modify: `tests/test_scheduler_plugins.py`

**Interfaces:**
- Consumes: the same `generate_schedule` contract as `simple_random` (Task 2), including `cross_session_pairing_history`'s shape from Task 5's `build_pairing_history`.
- Produces: nothing later tasks depend on — this is the last plugin-content task.

- [ ] **Step 1: Write `balanced`'s manifest**

Create `plugins/schedulers/balanced/manifest.json`:

```json
{
  "name": "balanced",
  "version": "1.0.0",
  "kind": "scheduler",
  "display_name": "Balanced (avoids repeat pairings)"
}
```

- [ ] **Step 2: Write `balanced`'s `generate_schedule`**

Create `plugins/schedulers/balanced/plugin.py`:

```python
from __future__ import annotations

import random
from typing import Any


def generate_schedule(
    teams: list[dict[str, Any]],
    target_matches_per_team: int,
    teams_per_alliance: int,
    fields: list[dict[str, Any]],
    field_sets: list[dict[str, Any]],
    cross_session_pairing_history: dict[Any, dict[str, int]],
    constraints: dict[str, Any],
) -> list[dict[str, Any]]:
    excluded = set(constraints.get("excluded_team_ids", []))
    team_ids = [t["team_id"] for t in teams if t["team_id"] not in excluded]
    organization_by_team = {t["team_id"]: t.get("organization") for t in teams}

    alliance_size = teams_per_alliance
    match_size = alliance_size * 2
    if len(team_ids) < match_size:
        return []

    field_set_ids = sorted({fs["field_set_id"] for fs in field_sets})
    if not field_set_ids:
        return []

    total_matches = (len(team_ids) * target_matches_per_team) // match_size
    if total_matches < 1:
        return []

    partner_counts: dict[frozenset[int], int] = {}
    opponent_counts: dict[frozenset[int], int] = {}
    for pair, counts in cross_session_pairing_history.items():
        partner_counts[pair] = counts.get("partner_count", 0)
        opponent_counts[pair] = counts.get("opponent_count", 0)

    def pair_key(a: int, b: int) -> frozenset[int]:
        return frozenset((a, b))

    def group_cost(group: list[int]) -> float:
        cost = 0.0
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                a, b = group[i], group[j]
                key = pair_key(a, b)
                same_alliance = (i // alliance_size) == (j // alliance_size)
                if same_alliance:
                    cost += partner_counts.get(key, 0) * 2
                    org_a = organization_by_team.get(a)
                    org_b = organization_by_team.get(b)
                    if org_a is not None and org_a == org_b:
                        cost += 5
                else:
                    cost += opponent_counts.get(key, 0)
        return cost

    def record_group(group: list[int]) -> None:
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                a, b = group[i], group[j]
                key = pair_key(a, b)
                same_alliance = (i // alliance_size) == (j // alliance_size)
                if same_alliance:
                    partner_counts[key] = partner_counts.get(key, 0) + 1
                else:
                    opponent_counts[key] = opponent_counts.get(key, 0) + 1

    appearances = {team_id: 0 for team_id in team_ids}
    matches: list[dict[str, Any]] = []
    time_slot = 0
    matches_made = 0
    attempts_per_match = 20

    while matches_made < total_matches:
        used_this_slot: set[int] = set()
        for field_set_id in field_set_ids:
            if matches_made >= total_matches:
                break
            available = [t for t in team_ids if t not in used_this_slot]
            if len(available) < match_size:
                break

            available.sort(key=lambda t: appearances[t])
            pool = available[: min(len(available), match_size * 3)]
            if len(pool) < match_size:
                pool = available

            best_group: list[int] | None = None
            best_cost: float | None = None
            for _ in range(attempts_per_match):
                candidate = random.sample(pool, match_size)
                cost = group_cost(candidate)
                if best_cost is None or cost < best_cost:
                    best_cost = cost
                    best_group = candidate

            chosen = best_group
            record_group(chosen)
            for team_id in chosen:
                appearances[team_id] += 1
                used_this_slot.add(team_id)

            alliances = []
            remaining = list(chosen)
            for station in ("red", "blue"):
                alliances.append(
                    {"station": station, "team_ids": remaining[:alliance_size]}
                )
                remaining = remaining[alliance_size:]

            matches.append(
                {
                    "time_slot": time_slot,
                    "field_set_id": field_set_id,
                    "alliances": alliances,
                }
            )
            matches_made += 1

        if not used_this_slot:
            break
        time_slot += 1

    return matches
```

- [ ] **Step 3: Wire `balanced` into the test `client` fixture**

In `tests/conftest.py`, add below `SIMPLE_RANDOM_SCHEDULER_PLUGIN`:

```python
BALANCED_SCHEDULER_PLUGIN = (
    Path(__file__).parent.parent / "plugins" / "schedulers" / "balanced"
)
```

In the `client` fixture, add after the `simple_random` copy block:

```python
    balanced_target = plugins_root / "schedulers" / "balanced"
    balanced_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(BALANCED_SCHEDULER_PLUGIN, balanced_target)
```

(`parents=True, exist_ok=True` because `schedulers_target.parent` was already created by the `simple_random` copy above it.)

- [ ] **Step 4: Run the full suite — must pass unchanged**

Run: `.venv/bin/pytest tests/ -v`
Expected: same total as Task 6's end (no test yet exercises `balanced` specifically, but every `client`-based test now has it pre-seeded too).

- [ ] **Step 5: Add tests proving `balanced` avoids repeats where the alternative is forced**

Append to `tests/test_scheduler_plugins.py`:

```python
BALANCED_PLUGIN = Path(__file__).parent.parent / "plugins" / "schedulers" / "balanced"


def test_balanced_passes_conformance():
    report = run_conformance_checks(BALANCED_PLUGIN)
    assert report.passed, [c for c in report.checks if not c.passed]


def test_balanced_avoids_the_only_repeat_pairing_when_an_alternative_exists():
    random.seed(0)
    plugin = load_plugin(BALANCED_PLUGIN, SCHEDULER_PLUGIN_KIND)
    module = plugin.module

    teams = [{"team_id": i, "organization": None} for i in (1, 2, 3, 4)]
    field_sets = [{"field_set_id": 1, "name": "Main Fields"}]
    fields = [{"field_id": 1, "field_set_id": 1}]

    # Every pairing among {1,2,3,4} has partnered twice already, except {1,2},
    # which has never partnered. With only one match to generate, `balanced`
    # should pick {1,2} as alliance-mates (the {1,2} vs {3,4} split) over
    # either alternative split, since that's the only split whose two
    # same-alliance pairs don't include a repeat partner.
    all_pairs = [(1, 2), (1, 3), (1, 4), (2, 3), (2, 4), (3, 4)]
    pairing_history = {
        frozenset(pair): {"partner_count": 2, "opponent_count": 0}
        for pair in all_pairs
    }
    pairing_history[frozenset((1, 2))] = {"partner_count": 0, "opponent_count": 0}

    matches = module.generate_schedule(
        teams=teams,
        target_matches_per_team=1,
        teams_per_alliance=2,
        fields=fields,
        field_sets=field_sets,
        cross_session_pairing_history=pairing_history,
        constraints={"excluded_team_ids": []},
    )

    assert len(matches) == 1
    alliance_team_sets = [set(a["team_ids"]) for a in matches[0]["alliances"]]
    assert {1, 2} in alliance_team_sets
```

Add `import random` to the top of `tests/test_scheduler_plugins.py` — `run_conformance_checks`, `load_plugin`, and `SCHEDULER_PLUGIN_KIND` are already imported there from Task 2.

- [ ] **Step 6: Run the new tests**

Run: `.venv/bin/pytest tests/test_scheduler_plugins.py -v`
Expected: all pass, including the two new `balanced` tests.

- [ ] **Step 7: Commit**

```bash
git add plugins/schedulers/balanced/manifest.json \
        plugins/schedulers/balanced/plugin.py \
        tests/conftest.py \
        tests/test_scheduler_plugins.py
git commit -m "Add the balanced scheduler plugin (pairing-history-aware)"
```

---

### Task 8: Documentation

**Files:**
- Modify: `server/CLAUDE.md` (repo-relative path: `CLAUDE.md` from the `server/` directory this plan's Global Constraints assume as CWD)

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing (documentation only).

- [ ] **Step 1: Update the "Plugin system" section**

In `CLAUDE.md`'s "## Plugin system" section, replace the first paragraph:

```markdown
A game plugin is a folder — `plugins/games/<name>/` — containing
`manifest.json` (`name`, `version`, `kind: "game"`, `display_name`) and
`plugin.py`, which must define seven module-level functions:
`match_format`, `scoresheet_schema`, `calculate_score`, `validate`,
`rank_teams`, `skills_scoresheet_schema`, `calculate_skills_score`. See
`tournament_server/plugin_registry/loader.py`'s
`REQUIRED_GAME_PLUGIN_FUNCTIONS` for the authoritative list, and
`tests/fixtures/plugins/games/example-game/plugin.py` for a complete
working example.
```

with:

```markdown
A plugin is a folder — `plugins/<games-or-schedulers>/<name>/` —
containing `manifest.json` (`name`, `version`, `kind`, `display_name`) and
`plugin.py`. Two plugin kinds exist, sharing one generic registry
(`plugin_registry/loader.py`'s `PluginKind`, `load_plugin`,
`discover_plugins`): a **game** plugin (`kind: "game"`, folder
`plugins/games/<name>/`) must define seven module-level functions —
`match_format`, `scoresheet_schema`, `calculate_score`, `validate`,
`rank_teams`, `skills_scoresheet_schema`, `calculate_skills_score` (see
`GAME_PLUGIN_KIND` for the authoritative list, and
`tests/fixtures/plugins/games/example-game/plugin.py` for a complete
working example); a **scheduler** plugin (`kind: "scheduler"`, folder
`plugins/schedulers/<name>/`) must define one — `generate_schedule` (see
`SCHEDULER_PLUGIN_KIND`, and `plugins/schedulers/simple_random/plugin.py`
for a complete working example).
```

- [ ] **Step 2: Add a "Scheduling" section**

After the existing "## Match & scoring" section in `CLAUDE.md`, add:

```markdown
## Scheduling

Every Field belongs to exactly one FieldSet (`field_set_id` is required,
never nullable). FieldSets in the same session run concurrently; fields
within one FieldSet process matches sequentially — only one match is ever
active per FieldSet at a time. `POST /api/fields` auto-creates a default
`"Main Fields"` FieldSet when a session has none yet, and requires an
explicit `field_set_id` once a session has more than one (ambiguous
otherwise).

`POST /api/schedule` generates a full practice/qualification schedule for
one `(session_id, division_id, round_type)` combination in a single call,
via a scheduler plugin's `generate_schedule()`. It 409s if matches already
exist for that combination — regenerating requires an explicit
`DELETE /api/schedule` first, which also deletes that division's `Ranking`
rows (a scoped fix for the general stale-ranking-row cleanup gap noted
under Match & scoring above — this action makes that gap immediately
visible, so it's addressed here specifically). The scheduler plugin
decides who plays whom and which FieldSet/time_slot each match runs in; the
core server assigns `match_number` and the literal `field_id` afterward
(round-robin within each match's FieldSet) — see `services/scheduling.py`
for the cross-session pairing-history query the plugin receives, and
`routers/schedule.py`'s `_validate_generated_schedule` for the structural
checks (correct alliance shape, no team double-booked within a
`time_slot`) applied to whatever the plugin returns, before anything is
persisted — the same validate-before-persist discipline used for score
submission.

Two scheduler plugins ship in this repo, at `plugins/schedulers/`:
`simple_random` (random, no optimization) and `balanced` (avoids repeat
partner/opponent pairings and same-organization pairings using pairing
history from every session in the event, falling back to minimizing the
worst repeat count once every unique pairing is exhausted). Both are real
plugins, not core code — a custom generator can replace either by
following the same `generate_schedule` contract.

Elimination brackets are a separate, later phase — no plugin contract for
bracket progression exists yet.
```

- [ ] **Step 3: Update the Testing section**

In `CLAUDE.md`'s "## Testing" section, replace the sentence about the `client` fixture pre-seeding a plugin:

```markdown
The fixture also pre-seeds the `example-game` fixture plugin
into that `plugins_root` before the app starts, so it's discoverable at
startup like a real installed plugin — tests that need a *different*
starting registry state (e.g. an empty one, or one containing a
specific other plugin) should build their own `create_app()`/`TestClient`
instance directly rather than relying on `client`, the way
`test_list_game_plugins_discovers_at_startup` in
`test_plugins_router.py` already does. Follow the `client` pattern for
anything else exercising the HTTP API: real calls through `TestClient`,
real temporary files underneath.
```

with:

```markdown
The fixture also pre-seeds the `example-game` game plugin and the
`simple_random`/`balanced` scheduler plugins into that `plugins_root`
before the app starts, so all three are discoverable at startup like real
installed plugins — tests that need a *different* starting registry state
(e.g. an empty one, or one containing a specific other plugin) should
build their own `create_app()`/`TestClient` instance directly rather than
relying on `client`, the way `test_list_game_plugins_discovers_at_startup`
in `test_plugins_router.py` already does. Follow the `client` pattern for
anything else exercising the HTTP API: real calls through `TestClient`,
real temporary files underneath.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "Document scheduling in server/CLAUDE.md"
```
