# Plugin System Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the game-scoring plugin system: a documented plugin
contract, folder-based discovery at startup, zip-based install via an
admin endpoint, and a `tm test-plugin` conformance tool — plus a minimal
working example plugin used to exercise all of it end to end.

**Architecture:** A game plugin is a folder with a `manifest.json` and a
`plugin.py` exposing seven module-level functions. The server loads
plugins by dynamically importing `plugin.py` via `importlib`, scans
`plugins/games/*/` at startup, and accepts new plugins at runtime as
zip uploads that get validated, extracted, and hot-registered — no
restart required. A separate `tm` CLI lets a plugin author run the same
conformance checks locally before distributing a zip.

**Tech Stack:** Same as Phase 1 (Python >= 3.11, FastAPI, SQLAlchemy 2.0
sync, Pydantic v2, pytest, httpx), plus one addition: `python-multipart`,
which FastAPI's `UploadFile`/multipart form handling requires at runtime
(it raises a `RuntimeError` otherwise) — this was missed when the plan
was first written and corrected during Task 5's review; see that task's
ledger entry. Everything else — `zipfile`, `importlib`, `argparse` — is
standard library.

**Spec:** `docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md`
(§5.1 game plugin contract, §7 zip packaging/installation, and the
conformance-testing part of §9 — checksums and the static capability
scan from §9 are explicitly out of scope for this plan; see Global
Constraints).

## Global Constraints

- Never reference any real-world competition brand or product name
  anywhere in code, comments, docstrings, commit messages, file/variable/
  class names, or documentation.
- Every backend feature ships with pytest tests in the same change that
  introduces it.
- A game plugin folder is `plugins/games/<name>/` containing
  `manifest.json` and `plugin.py`.
- A game plugin's `plugin.py` must define exactly these seven
  module-level callables: `match_format`, `scoresheet_schema`,
  `calculate_score`, `validate`, `rank_teams`, `skills_scoresheet_schema`,
  `calculate_skills_score`.
- A manifest's `name` field must match `^[A-Za-z0-9][A-Za-z0-9_-]*$` —
  it's used directly as a filesystem folder name, so this also closes a
  path-traversal risk from an untrusted upload.
- The plugin registry is keyed by `name` only — one active version per
  name at a time. Multiple simultaneous versions of the same name are
  not supported in this phase; a new season's ruleset ships under a new
  plugin name instead (matching the reference tool's own per-season
  naming convention, e.g. distinct names per year rather than one name
  with many live versions).
- A plugin zip has `manifest.json` and `plugin.py` at its root (no
  wrapping folder) — the install destination folder name comes from the
  manifest's `name` field, never from anything embedded in the zip.
- Startup discovery is fail-soft: a broken plugin folder already on disk
  is skipped with a warning, not a crash. Zip install is fail-loud: a
  bad upload is rejected outright with a clear error.
- Out of scope for this plan (deferred to later plans): checksum
  computation/verification and the static capability scan from spec §9
  — this plan's `tm test-plugin` runs contract-conformance checks only.
  Scheduler plugins (spec §5.2) are a separate later plan too.

## File Structure

```
server/
  pyproject.toml                                    # add [project.scripts]
  src/tournament_server/
    cli.py                                            # `tm` CLI entrypoint
    settings.py                                        # add plugins_root
    app.py                                              # wire in plugin discovery + router
    plugin_registry/
      __init__.py
      errors.py            # PluginError, PluginLoadError, PluginInstallError, PluginAlreadyExistsError
      manifest.py           # PluginManifest, parse_manifest(), load_manifest()
      loader.py              # LoadedGamePlugin, load_game_plugin()
      discovery.py            # discover_game_plugins()
      zip_install.py           # install_plugin_zip()
      conformance.py            # CheckResult, ConformanceReport, run_conformance_checks()
    routers/
      plugins.py             # GET/POST /api/plugins/games
  tests/
    conftest.py               # modify: client fixture gets an isolated plugins_root
    plugin_helpers.py          # zip_fixture_plugin() test helper
    fixtures/plugins/games/
      example-game/
        manifest.json
        plugin.py
      broken-plugin/
        manifest.json
        plugin.py             # missing `validate` on purpose
    test_plugin_manifest.py
    test_plugin_loader.py
    test_plugin_discovery.py
    test_plugins_router.py
    test_plugin_zip_install.py
    test_plugin_conformance.py
    test_cli.py
```

Each `plugin_registry/` module owns one responsibility: manifests, the
Python-module loading mechanism, folder scanning, zip installation, and
conformance checking are five separate concerns kept in five separate
files, all built on the same `manifest.py`/`loader.py` primitives.

---

### Task 1: Plugin manifest parsing

**Files:**
- Create: `server/src/tournament_server/plugin_registry/__init__.py`
  (empty)
- Create: `server/src/tournament_server/plugin_registry/errors.py`
- Create: `server/src/tournament_server/plugin_registry/manifest.py`
- Create: `server/tests/fixtures/plugins/games/example-game/manifest.json`
- Test: `server/tests/test_plugin_manifest.py`

**Interfaces:**
- Produces: `tournament_server.plugin_registry.errors.PluginError` (base
  class), `.PluginLoadError`, `.PluginInstallError` (subclasses
  `PluginError`), `.PluginAlreadyExistsError` (subclasses
  `PluginInstallError`). Every later task raises/catches these.
- Produces: `tournament_server.plugin_registry.manifest.PluginManifest`
  — a dataclass with `name: str, version: str, kind: str,
  display_name: str`.
- Produces: `parse_manifest(data: dict) -> PluginManifest` (validates a
  parsed-JSON dict) and `load_manifest(plugin_dir: Path) -> PluginManifest`
  (reads `plugin_dir / "manifest.json"` and calls `parse_manifest`).
  Both raise `PluginLoadError` on any problem. Task 2 calls
  `load_manifest`; Task 5 (zip install) calls `parse_manifest` directly
  on data read from inside a zip.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_plugin_manifest.py`:

```python
from pathlib import Path

import pytest

from tournament_server.plugin_registry.errors import PluginLoadError
from tournament_server.plugin_registry.manifest import load_manifest, parse_manifest

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)


def test_load_manifest_success():
    manifest = load_manifest(FIXTURE_EXAMPLE_PLUGIN)
    assert manifest.name == "example-game"
    assert manifest.version == "1.0.0"
    assert manifest.kind == "game"
    assert manifest.display_name == "Example Scoring Game"


def test_load_manifest_missing_file_raises(tmp_path):
    with pytest.raises(PluginLoadError, match="manifest.json"):
        load_manifest(tmp_path)


def test_parse_manifest_rejects_unsafe_name():
    with pytest.raises(PluginLoadError, match="name"):
        parse_manifest(
            {
                "name": "../../etc",
                "version": "1.0.0",
                "kind": "game",
                "display_name": "Bad",
            }
        )


def test_parse_manifest_rejects_missing_version():
    with pytest.raises(PluginLoadError, match="version"):
        parse_manifest({"name": "ok-name", "kind": "game", "display_name": "OK"})
```

Create `server/tests/fixtures/plugins/games/example-game/manifest.json`:

```json
{
  "name": "example-game",
  "version": "1.0.0",
  "kind": "game",
  "display_name": "Example Scoring Game"
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/test_plugin_manifest.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named
'tournament_server.plugin_registry'` (the package doesn't exist yet).

- [ ] **Step 3: Implement errors and manifest parsing**

Create `server/src/tournament_server/plugin_registry/__init__.py` (empty
file).

Create `server/src/tournament_server/plugin_registry/errors.py`:

```python
from __future__ import annotations


class PluginError(Exception):
    """Base class for all plugin-registry errors."""


class PluginLoadError(PluginError):
    """Raised when a plugin's manifest or module can't be loaded/validated."""


class PluginInstallError(PluginError):
    """Raised when a plugin zip upload is malformed or invalid."""


class PluginAlreadyExistsError(PluginInstallError):
    """Raised when installing a plugin whose name is already installed."""
```

Create `server/src/tournament_server/plugin_registry/manifest.py`:

```python
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tournament_server.plugin_registry.errors import PluginLoadError

_VALID_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


@dataclass
class PluginManifest:
    name: str
    version: str
    kind: str
    display_name: str


def parse_manifest(data: dict[str, Any]) -> PluginManifest:
    name = data.get("name")
    if not isinstance(name, str) or not _VALID_NAME_RE.match(name):
        raise PluginLoadError(
            "manifest 'name' must be a non-empty string of letters, "
            f"numbers, hyphens, or underscores (got {name!r})"
        )
    version = data.get("version")
    if not isinstance(version, str) or not version:
        raise PluginLoadError(
            f"manifest 'version' must be a non-empty string (got {version!r})"
        )
    kind = data.get("kind")
    if not isinstance(kind, str) or not kind:
        raise PluginLoadError(
            f"manifest 'kind' must be a non-empty string (got {kind!r})"
        )
    display_name = data.get("display_name")
    if not isinstance(display_name, str) or not display_name:
        raise PluginLoadError(
            f"manifest 'display_name' must be a non-empty string "
            f"(got {display_name!r})"
        )
    return PluginManifest(
        name=name, version=version, kind=kind, display_name=display_name
    )


def load_manifest(plugin_dir: Path) -> PluginManifest:
    manifest_path = plugin_dir / "manifest.json"
    if not manifest_path.exists():
        raise PluginLoadError(f"{plugin_dir} has no manifest.json")
    try:
        data = json.loads(manifest_path.read_text())
    except json.JSONDecodeError as exc:
        raise PluginLoadError(f"{manifest_path} is not valid JSON: {exc}")
    return parse_manifest(data)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/test_plugin_manifest.py -v
```

Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src/tournament_server/plugin_registry server/tests/test_plugin_manifest.py server/tests/fixtures
git commit -m "$(cat <<'EOF'
Add plugin manifest parsing

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Plugin module loader

**Files:**
- Create: `server/src/tournament_server/plugin_registry/loader.py`
- Create: `server/tests/fixtures/plugins/games/example-game/plugin.py`
- Create: `server/tests/fixtures/plugins/games/broken-plugin/manifest.json`
- Create: `server/tests/fixtures/plugins/games/broken-plugin/plugin.py`
- Test: `server/tests/test_plugin_loader.py`

**Interfaces:**
- Consumes: `tournament_server.plugin_registry.manifest.load_manifest`,
  `.PluginManifest` (Task 1); `tournament_server.plugin_registry.errors.PluginLoadError`
  (Task 1).
- Produces: `tournament_server.plugin_registry.loader.LoadedGamePlugin` —
  a dataclass with `name: str, version: str, display_name: str,
  folder: Path, module: ModuleType`.
- Produces: `REQUIRED_GAME_PLUGIN_FUNCTIONS` — a tuple of the 7 required
  function names (also referenced by Task 6's conformance checks as the
  authoritative list, imported from here rather than redefined).
- Produces: `load_game_plugin(plugin_dir: Path) -> LoadedGamePlugin`.
  Tasks 3 (discovery), 5 (zip install), and 6 (conformance) all call
  this.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_plugin_loader.py`:

```python
from pathlib import Path

import pytest

from tournament_server.plugin_registry.errors import PluginLoadError
from tournament_server.plugin_registry.loader import load_game_plugin

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)
FIXTURE_BROKEN_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "broken-plugin"
)


def test_load_game_plugin_success():
    plugin = load_game_plugin(FIXTURE_EXAMPLE_PLUGIN)
    assert plugin.name == "example-game"
    assert plugin.version == "1.0.0"
    assert plugin.display_name == "Example Scoring Game"
    assert callable(plugin.module.calculate_score)


def test_load_game_plugin_computes_real_score():
    plugin = load_game_plugin(FIXTURE_EXAMPLE_PLUGIN)
    score = plugin.module.calculate_score(
        {"high_balls": 2, "low_balls": 3, "auto_winner": "red"}
    )
    assert score == 2 * 3 + 3 * 1 + 10


def test_load_game_plugin_missing_function_raises():
    with pytest.raises(PluginLoadError, match="validate"):
        load_game_plugin(FIXTURE_BROKEN_PLUGIN)
```

Create `server/tests/fixtures/plugins/games/example-game/plugin.py`:

```python
from __future__ import annotations

from typing import Any


def match_format() -> dict[str, Any]:
    return {
        "alliance_count": 2,
        "teams_per_alliance": 2,
        "autonomous_seconds": 15,
        "driver_seconds": 105,
        "round_types": ["practice", "qualification", "elimination"],
    }


def scoresheet_schema() -> list[dict[str, Any]]:
    return [
        {
            "name": "high_balls",
            "label": "High Balls",
            "data_type": "integer",
            "widget": "counter",
            "min": 0,
            "max": 20,
            "step": 1,
            "options": None,
            "icon": None,
            "scope": "alliance",
            "default": 0,
        },
        {
            "name": "low_balls",
            "label": "Low Balls",
            "data_type": "integer",
            "widget": "counter",
            "min": 0,
            "max": 20,
            "step": 1,
            "options": None,
            "icon": None,
            "scope": "alliance",
            "default": 0,
        },
        {
            "name": "parked",
            "label": "Robot Parked",
            "data_type": "boolean",
            "widget": "toggle",
            "min": None,
            "max": None,
            "step": None,
            "options": None,
            "icon": None,
            "scope": "team",
            "default": False,
        },
        {
            "name": "auto_winner",
            "label": "Autonomous Winner",
            "data_type": "enum",
            "widget": "radio",
            "min": None,
            "max": None,
            "step": None,
            "options": ["red", "blue", "tie"],
            "icon": None,
            "scope": "alliance",
            "default": "tie",
        },
    ]


def calculate_score(scoresheet: dict[str, Any]) -> int:
    score = scoresheet.get("high_balls", 0) * 3 + scoresheet.get("low_balls", 0) * 1
    if scoresheet.get("auto_winner") != "tie":
        score += 10
    return score


def validate(scoresheet: dict[str, Any]) -> list[str]:
    violations = []
    if scoresheet.get("high_balls", 0) > 20:
        violations.append("high_balls cannot exceed 20")
    if scoresheet.get("low_balls", 0) > 20:
        violations.append("low_balls cannot exceed 20")
    return violations


def rank_teams(team_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(
        team_results,
        key=lambda r: (
            -r["win_points"],
            -r["strength_of_schedule"],
            -r["tiebreaker_seed"],
        ),
    )
    return [{**r, "rank": i + 1} for i, r in enumerate(ordered)]


def skills_scoresheet_schema() -> list[dict[str, Any]]:
    return [
        {
            "name": "objects_scored",
            "label": "Objects Scored",
            "data_type": "integer",
            "widget": "counter",
            "min": 0,
            "max": 30,
            "step": 1,
            "options": None,
            "icon": None,
            "scope": "team",
            "default": 0,
        },
    ]


def calculate_skills_score(scoresheet: dict[str, Any]) -> int:
    return scoresheet.get("objects_scored", 0) * 2
```

Create `server/tests/fixtures/plugins/games/broken-plugin/manifest.json`:

```json
{
  "name": "broken-plugin",
  "version": "1.0.0",
  "kind": "game",
  "display_name": "Broken Plugin"
}
```

Create `server/tests/fixtures/plugins/games/broken-plugin/plugin.py` (a
plugin missing the required `validate` function, on purpose):

```python
from __future__ import annotations

from typing import Any


def match_format() -> dict[str, Any]:
    return {
        "alliance_count": 2,
        "teams_per_alliance": 2,
        "autonomous_seconds": 15,
        "driver_seconds": 105,
        "round_types": ["practice", "qualification", "elimination"],
    }


def scoresheet_schema() -> list[dict[str, Any]]:
    return [
        {
            "name": "points",
            "label": "Points",
            "data_type": "integer",
            "widget": "counter",
            "min": 0,
            "max": 10,
            "step": 1,
            "options": None,
            "icon": None,
            "scope": "alliance",
            "default": 0,
        },
    ]


def calculate_score(scoresheet: dict[str, Any]) -> int:
    return scoresheet.get("points", 0)


# validate() is intentionally missing.


def rank_teams(team_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(team_results, key=lambda r: -r["win_points"])
    return [{**r, "rank": i + 1} for i, r in enumerate(ordered)]


def skills_scoresheet_schema() -> list[dict[str, Any]]:
    return [
        {
            "name": "points",
            "label": "Points",
            "data_type": "integer",
            "widget": "counter",
            "min": 0,
            "max": 10,
            "step": 1,
            "options": None,
            "icon": None,
            "scope": "team",
            "default": 0,
        },
    ]


def calculate_skills_score(scoresheet: dict[str, Any]) -> int:
    return scoresheet.get("points", 0)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/test_plugin_loader.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named
'tournament_server.plugin_registry.loader'`.

- [ ] **Step 3: Implement the loader**

Create `server/src/tournament_server/plugin_registry/loader.py`:

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


@dataclass
class LoadedGamePlugin:
    name: str
    version: str
    display_name: str
    folder: Path
    module: ModuleType


def _import_plugin_module(plugin_dir: Path, plugin_name: str) -> ModuleType:
    module_path = plugin_dir / "plugin.py"
    if not module_path.exists():
        raise PluginLoadError(f"{plugin_dir} has no plugin.py")
    module_key = f"tournament_server_plugin_{plugin_name}"
    spec = importlib.util.spec_from_file_location(module_key, module_path)
    if spec is None or spec.loader is None:
        raise PluginLoadError(f"could not load plugin module at {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_key] = module
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        del sys.modules[module_key]
        raise PluginLoadError(f"error executing {module_path}: {exc}") from exc
    return module


def _check_required_functions(module: ModuleType) -> None:
    missing = [
        name
        for name in REQUIRED_GAME_PLUGIN_FUNCTIONS
        if not callable(getattr(module, name, None))
    ]
    if missing:
        raise PluginLoadError(
            f"plugin module is missing required functions: {', '.join(missing)}"
        )


def load_game_plugin(plugin_dir: Path) -> LoadedGamePlugin:
    manifest = load_manifest(plugin_dir)
    if manifest.kind != "game":
        raise PluginLoadError(
            f"{plugin_dir} declares kind={manifest.kind!r}, expected 'game'"
        )
    module = _import_plugin_module(plugin_dir, manifest.name)
    _check_required_functions(module)
    return LoadedGamePlugin(
        name=manifest.name,
        version=manifest.version,
        display_name=manifest.display_name,
        folder=plugin_dir,
        module=module,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/test_plugin_manifest.py tests/test_plugin_loader.py -v
```

Expected: PASS (all tests in both files).

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src/tournament_server/plugin_registry/loader.py server/tests/test_plugin_loader.py server/tests/fixtures
git commit -m "$(cat <<'EOF'
Add plugin module loader with a working example plugin fixture

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Plugin discovery

**Files:**
- Create: `server/src/tournament_server/plugin_registry/discovery.py`
- Test: `server/tests/test_plugin_discovery.py`

**Interfaces:**
- Consumes: `tournament_server.plugin_registry.loader.LoadedGamePlugin`,
  `.load_game_plugin` (Task 2); `tournament_server.plugin_registry.errors.PluginLoadError`
  (Task 1).
- Produces: `discover_game_plugins(plugins_root: Path) -> dict[str, LoadedGamePlugin]`
  — scans `plugins_root / "games" / *`, keyed by plugin name. Task 4
  calls this at app startup.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_plugin_discovery.py`:

```python
import shutil
from pathlib import Path

from tournament_server.plugin_registry.discovery import discover_game_plugins

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)
FIXTURE_BROKEN_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "broken-plugin"
)


def test_discover_game_plugins_finds_valid_plugin(tmp_path):
    target = tmp_path / "plugins" / "games" / "example-game"
    target.parent.mkdir(parents=True)
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, target)

    registry = discover_game_plugins(tmp_path / "plugins")

    assert set(registry) == {"example-game"}
    assert registry["example-game"].version == "1.0.0"


def test_discover_game_plugins_empty_root_returns_empty_dict(tmp_path):
    registry = discover_game_plugins(tmp_path / "plugins")
    assert registry == {}


def test_discover_game_plugins_skips_broken_folder_but_keeps_good_one(tmp_path):
    games_root = tmp_path / "plugins" / "games"
    games_root.mkdir(parents=True)
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, games_root / "example-game")
    shutil.copytree(FIXTURE_BROKEN_PLUGIN, games_root / "broken-plugin")

    registry = discover_game_plugins(tmp_path / "plugins")

    assert set(registry) == {"example-game"}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/test_plugin_discovery.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named
'tournament_server.plugin_registry.discovery'`.

- [ ] **Step 3: Implement discovery**

Create `server/src/tournament_server/plugin_registry/discovery.py`:

```python
from __future__ import annotations

import sys
from pathlib import Path

from tournament_server.plugin_registry.errors import PluginLoadError
from tournament_server.plugin_registry.loader import LoadedGamePlugin, load_game_plugin


def discover_game_plugins(plugins_root: Path) -> dict[str, LoadedGamePlugin]:
    games_root = plugins_root / "games"
    registry: dict[str, LoadedGamePlugin] = {}
    if not games_root.is_dir():
        return registry

    for entry in sorted(games_root.iterdir()):
        if not entry.is_dir():
            continue
        try:
            plugin = load_game_plugin(entry)
        except PluginLoadError as exc:
            print(f"warning: skipping plugin folder {entry}: {exc}", file=sys.stderr)
            continue
        registry[plugin.name] = plugin
    return registry
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/test_plugin_discovery.py -v
```

Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src/tournament_server/plugin_registry/discovery.py server/tests/test_plugin_discovery.py
git commit -m "$(cat <<'EOF'
Add plugin discovery (folder scan, fail-soft on broken plugins)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire plugin discovery into the app, add a listing endpoint

**Files:**
- Modify: `server/src/tournament_server/settings.py`
- Modify: `server/src/tournament_server/app.py`
- Modify: `server/tests/conftest.py`
- Create: `server/src/tournament_server/routers/plugins.py` (GET only —
  Task 5 adds POST)
- Test: `server/tests/test_plugins_router.py`

**Interfaces:**
- Consumes: `tournament_server.plugin_registry.discovery.discover_game_plugins`
  (Task 3).
- Produces: `Settings.plugins_root: str` (new field, default
  `"./plugins"`, env var `TOURNAMENT_PLUGINS_ROOT`).
- Produces: `create_app(db_path: str | None = None, plugins_root: str | None = None) -> FastAPI`
  — the `plugins_root` parameter is new; `app.state.plugins_root: Path`
  and `app.state.game_plugins: dict[str, LoadedGamePlugin]` are new
  attributes every later task (Task 5's install endpoint, and any
  future scoring code) reads/writes.
- Produces route: `GET /api/plugins/games`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_plugins_router.py`:

```python
import shutil
from pathlib import Path

from fastapi.testclient import TestClient

from tournament_server.app import create_app

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)


def test_list_game_plugins_empty(client):
    response = client.get("/api/plugins/games")
    assert response.status_code == 200
    assert response.json() == []


def test_list_game_plugins_discovers_at_startup(tmp_path):
    plugins_root = tmp_path / "plugins"
    target = plugins_root / "games" / "example-game"
    target.parent.mkdir(parents=True)
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, target)

    app = create_app(
        db_path=str(tmp_path / "test.db"), plugins_root=str(plugins_root)
    )
    test_client = TestClient(app)

    response = test_client.get("/api/plugins/games")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["name"] == "example-game"
    assert body[0]["version"] == "1.0.0"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/test_plugins_router.py -v
```

Expected: FAIL — `404 Not Found` for `/api/plugins/games` (route doesn't
exist yet).

- [ ] **Step 3: Implement the settings field, app wiring, and router**

Replace `server/src/tournament_server/settings.py` in full:

```python
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Settings:
    db_path: str = "./tournament.db"
    plugins_root: str = "./plugins"

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            db_path=os.environ.get("TOURNAMENT_DB_PATH", "./tournament.db"),
            plugins_root=os.environ.get("TOURNAMENT_PLUGINS_ROOT", "./plugins"),
        )
```

Create `server/src/tournament_server/routers/plugins.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Request

router = APIRouter(prefix="/api/plugins/games", tags=["plugins"])


@router.get("")
def list_game_plugins(request: Request) -> list[dict[str, str]]:
    registry = request.app.state.game_plugins
    return [
        {"name": p.name, "version": p.version, "display_name": p.display_name}
        for p in registry.values()
    ]
```

Replace `server/src/tournament_server/app.py` in full:

```python
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request

from tournament_server import audit  # noqa: F401  (registers AuditLog + hooks)
from tournament_server import models  # noqa: F401  (registers all tables)
from tournament_server.db import init_db, make_engine, make_session_factory
from tournament_server.plugin_registry.discovery import discover_game_plugins
from tournament_server.routers import (
    audit_log,
    divisions,
    event,
    participation,
    plugins,
    sessions,
    teams,
)
from tournament_server.settings import Settings


def create_app(
    db_path: str | None = None, plugins_root: str | None = None
) -> FastAPI:
    settings = Settings.from_env()
    if db_path is not None:
        settings.db_path = db_path
    if plugins_root is not None:
        settings.plugins_root = plugins_root

    engine = make_engine(settings.db_path)
    session_factory = make_session_factory(engine)
    init_db(engine)

    app = FastAPI(title="Tournament Server")
    app.state.session_factory = session_factory
    app.state.plugins_root = Path(settings.plugins_root)
    app.state.game_plugins = discover_game_plugins(app.state.plugins_root)

    @app.middleware("http")
    async def actor_middleware(request: Request, call_next):
        with audit.actor_scope(request.headers.get("x-actor-name", "admin")):
            return await call_next(request)

    app.include_router(event.router)
    app.include_router(sessions.router)
    app.include_router(divisions.router)
    app.include_router(teams.router)
    app.include_router(participation.router)
    app.include_router(audit_log.router)
    app.include_router(plugins.router)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
```

Replace `server/tests/conftest.py` in full:

```python
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tournament_server.app import create_app


@pytest.fixture()
def client(tmp_path) -> TestClient:
    db_path = str(tmp_path / "test.db")
    plugins_root = str(tmp_path / "plugins")
    app = create_app(db_path=db_path, plugins_root=plugins_root)
    return TestClient(app)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/ -v
```

Expected: PASS (all tests across every file, including every Phase 1
test — the `client` fixture change must not break anything since an
empty/nonexistent `plugins_root` yields an empty plugin registry).

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src/tournament_server/settings.py server/src/tournament_server/app.py server/src/tournament_server/routers/plugins.py server/tests/conftest.py server/tests/test_plugins_router.py
git commit -m "$(cat <<'EOF'
Wire plugin discovery into app startup, add GET /api/plugins/games

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Zip-based plugin installation

**Files:**
- Create: `server/src/tournament_server/plugin_registry/zip_install.py`
- Create: `server/tests/plugin_helpers.py`
- Modify: `server/src/tournament_server/routers/plugins.py` (add POST)
- Test: `server/tests/test_plugin_zip_install.py`
- Test: `server/tests/test_plugins_router.py` (append POST tests)

**Interfaces:**
- Consumes: `tournament_server.plugin_registry.manifest.parse_manifest`
  (Task 1); `.loader.LoadedGamePlugin`, `.load_game_plugin` (Task 2);
  `.errors.PluginInstallError`, `.PluginAlreadyExistsError`,
  `.PluginLoadError` (Task 1).
- Produces: `install_plugin_zip(zip_bytes: bytes, plugins_root: Path) -> LoadedGamePlugin`.
- Produces: `zip_fixture_plugin(fixture_dir: Path) -> bytes` (test
  helper, importable as `from plugin_helpers import zip_fixture_plugin`
  since `tests/` has no `__init__.py` and pytest's default import mode
  puts each test file's directory on `sys.path`).
- Produces route: `POST /api/plugins/games` (multipart file upload).

- [ ] **Step 1: Write the failing tests**

Create `server/tests/plugin_helpers.py`:

```python
from __future__ import annotations

import io
import zipfile
from pathlib import Path


def zip_fixture_plugin(fixture_dir: Path) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        for path in fixture_dir.rglob("*"):
            if path.is_file():
                zf.write(path, arcname=path.relative_to(fixture_dir))
    return buffer.getvalue()
```

Create `server/tests/test_plugin_zip_install.py`:

```python
import io
import zipfile
from pathlib import Path

import pytest

from plugin_helpers import zip_fixture_plugin
from tournament_server.plugin_registry.errors import (
    PluginAlreadyExistsError,
    PluginInstallError,
)
from tournament_server.plugin_registry.zip_install import install_plugin_zip

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)


def test_install_plugin_zip_extracts_and_loads(tmp_path):
    zip_bytes = zip_fixture_plugin(FIXTURE_EXAMPLE_PLUGIN)
    plugins_root = tmp_path / "plugins"

    plugin = install_plugin_zip(zip_bytes, plugins_root)

    assert plugin.name == "example-game"
    assert (plugins_root / "games" / "example-game" / "manifest.json").exists()


def test_install_plugin_zip_refuses_duplicate_name(tmp_path):
    zip_bytes = zip_fixture_plugin(FIXTURE_EXAMPLE_PLUGIN)
    plugins_root = tmp_path / "plugins"
    install_plugin_zip(zip_bytes, plugins_root)

    with pytest.raises(PluginAlreadyExistsError):
        install_plugin_zip(zip_bytes, plugins_root)


def test_install_plugin_zip_rejects_missing_manifest(tmp_path):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("plugin.py", "# no manifest here")

    with pytest.raises(PluginInstallError):
        install_plugin_zip(buffer.getvalue(), tmp_path / "plugins")


def test_install_plugin_zip_rejects_bad_zip_bytes(tmp_path):
    with pytest.raises(PluginInstallError):
        install_plugin_zip(b"not a zip", tmp_path / "plugins")
```

Append to `server/tests/test_plugins_router.py`:

```python
from plugin_helpers import zip_fixture_plugin


def test_upload_game_plugin_installs_and_lists_immediately(client):
    zip_bytes = zip_fixture_plugin(FIXTURE_EXAMPLE_PLUGIN)

    response = client.post(
        "/api/plugins/games",
        files={"file": ("example-game.zip", zip_bytes, "application/zip")},
    )
    assert response.status_code == 201
    assert response.json()["name"] == "example-game"

    listed = client.get("/api/plugins/games").json()
    assert len(listed) == 1
    assert listed[0]["name"] == "example-game"


def test_upload_duplicate_plugin_name_returns_409(client):
    zip_bytes = zip_fixture_plugin(FIXTURE_EXAMPLE_PLUGIN)
    client.post(
        "/api/plugins/games",
        files={"file": ("example-game.zip", zip_bytes, "application/zip")},
    )

    response = client.post(
        "/api/plugins/games",
        files={"file": ("example-game.zip", zip_bytes, "application/zip")},
    )
    assert response.status_code == 409


def test_upload_malformed_zip_returns_422(client):
    response = client.post(
        "/api/plugins/games",
        files={"file": ("bad.zip", b"not a zip file", "application/zip")},
    )
    assert response.status_code == 422
```

(This appends below the existing two tests and the `FIXTURE_EXAMPLE_PLUGIN`
constant already defined at the top of the file from Task 4 — add the
new `from plugin_helpers import zip_fixture_plugin` import line at the
top of the file alongside the existing imports, not inside a function.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/test_plugin_zip_install.py tests/test_plugins_router.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named
'tournament_server.plugin_registry.zip_install'` for the unit tests, and
`405 Method Not Allowed` (or a fixture/import error) for the new router
tests since `POST /api/plugins/games` doesn't exist yet.

- [ ] **Step 3: Implement zip install and the POST endpoint**

Create `server/src/tournament_server/plugin_registry/zip_install.py`:

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
from tournament_server.plugin_registry.loader import LoadedGamePlugin, load_game_plugin
from tournament_server.plugin_registry.manifest import parse_manifest


def install_plugin_zip(zip_bytes: bytes, plugins_root: Path) -> LoadedGamePlugin:
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as exc:
        raise PluginInstallError(f"not a valid zip file: {exc}")

    with zf:
        try:
            manifest_raw = zf.read("manifest.json")
        except KeyError:
            raise PluginInstallError(
                "zip does not contain a manifest.json at its root"
            )
        try:
            manifest_data = json.loads(manifest_raw)
        except json.JSONDecodeError as exc:
            raise PluginInstallError(f"manifest.json is not valid JSON: {exc}")

        try:
            manifest = parse_manifest(manifest_data)
        except PluginLoadError as exc:
            raise PluginInstallError(str(exc))

        if manifest.kind != "game":
            raise PluginInstallError(
                f"expected a 'game' plugin manifest, got kind={manifest.kind!r}"
            )

        target_dir = plugins_root / "games" / manifest.name
        if target_dir.exists():
            raise PluginAlreadyExistsError(
                f"a plugin named {manifest.name!r} is already installed"
            )

        target_dir.mkdir(parents=True)
        zf.extractall(target_dir)

    try:
        return load_game_plugin(target_dir)
    except PluginLoadError as exc:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise PluginInstallError(f"installed plugin failed to load: {exc}")
```

Replace `server/src/tournament_server/routers/plugins.py` in full:

```python
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, UploadFile

from tournament_server.plugin_registry.errors import (
    PluginAlreadyExistsError,
    PluginInstallError,
)
from tournament_server.plugin_registry.zip_install import install_plugin_zip

router = APIRouter(prefix="/api/plugins/games", tags=["plugins"])


@router.get("")
def list_game_plugins(request: Request) -> list[dict[str, str]]:
    registry = request.app.state.game_plugins
    return [
        {"name": p.name, "version": p.version, "display_name": p.display_name}
        for p in registry.values()
    ]


@router.post("", status_code=201)
async def upload_game_plugin(request: Request, file: UploadFile) -> dict[str, str]:
    zip_bytes = await file.read()
    plugins_root = request.app.state.plugins_root
    try:
        plugin = install_plugin_zip(zip_bytes, plugins_root)
    except PluginAlreadyExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except PluginInstallError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    request.app.state.game_plugins[plugin.name] = plugin
    return {
        "name": plugin.name,
        "version": plugin.version,
        "display_name": plugin.display_name,
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/ -v
```

Expected: PASS (all tests across every file).

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src/tournament_server/plugin_registry/zip_install.py server/src/tournament_server/routers/plugins.py server/tests/plugin_helpers.py server/tests/test_plugin_zip_install.py server/tests/test_plugins_router.py
git commit -m "$(cat <<'EOF'
Add zip-based plugin installation with hot-registration

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Plugin conformance checks

**Files:**
- Create: `server/src/tournament_server/plugin_registry/conformance.py`
- Test: `server/tests/test_plugin_conformance.py`

**Interfaces:**
- Consumes: `tournament_server.plugin_registry.loader.load_game_plugin`,
  `.REQUIRED_GAME_PLUGIN_FUNCTIONS` (Task 2); `.errors.PluginLoadError`
  (Task 1).
- Produces: `tournament_server.plugin_registry.conformance.CheckResult`
  — a dataclass with `name: str, passed: bool, message: str = ""`.
- Produces: `ConformanceReport` — a dataclass with `plugin_name: str | None,
  checks: list[CheckResult]` and a `passed` property (`all(c.passed for
  c in checks)`).
- Produces: `run_conformance_checks(plugin_dir: Path) -> ConformanceReport`.
  Task 7's CLI calls this.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_plugin_conformance.py`:

```python
from __future__ import annotations

import json
from pathlib import Path

from tournament_server.plugin_registry.conformance import run_conformance_checks

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)
FIXTURE_BROKEN_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "broken-plugin"
)

_TEMPLATE = '''
def match_format():
    return {{
        "alliance_count": 2,
        "teams_per_alliance": 2,
        "autonomous_seconds": 15,
        "driver_seconds": 105,
        "round_types": ["practice", "qualification", "elimination"],
    }}


def scoresheet_schema():
{scoresheet_schema_body}

def calculate_score(scoresheet):
{calculate_score_body}

def validate(scoresheet):
    return []


def rank_teams(team_results):
    ordered = sorted(team_results, key=lambda r: -r["win_points"])
    return [{{**r, "rank": i + 1}} for i, r in enumerate(ordered)]


def skills_scoresheet_schema():
    return [{{"name": "x", "label": "X", "data_type": "integer", "widget": "counter",
             "min": 0, "max": 10, "step": 1, "options": None, "icon": None,
             "scope": "team", "default": 0}}]


def calculate_skills_score(scoresheet):
    return int(scoresheet.get("x", 0))
'''

_DEFAULT_SCORESHEET_SCHEMA_BODY = (
    "    return [{'name': 'high_balls', 'label': 'High Balls', "
    "'data_type': 'integer', 'widget': 'counter', 'min': 0, 'max': 20, "
    "'step': 1, 'options': None, 'icon': None, 'scope': 'alliance', "
    "'default': 0}]\n"
)
_DEFAULT_CALCULATE_SCORE_BODY = "    return scoresheet.get('high_balls', 0)\n"


def _write_variant_plugin(
    tmp_path,
    scoresheet_schema_body: str = _DEFAULT_SCORESHEET_SCHEMA_BODY,
    calculate_score_body: str = _DEFAULT_CALCULATE_SCORE_BODY,
) -> None:
    (tmp_path / "manifest.json").write_text(
        json.dumps(
            {
                "name": "variant-plugin",
                "version": "1.0.0",
                "kind": "game",
                "display_name": "Variant Plugin",
            }
        )
    )
    (tmp_path / "plugin.py").write_text(
        _TEMPLATE.format(
            scoresheet_schema_body=scoresheet_schema_body,
            calculate_score_body=calculate_score_body,
        )
    )


def test_example_plugin_passes_all_checks():
    report = run_conformance_checks(FIXTURE_EXAMPLE_PLUGIN)
    assert report.passed, [c for c in report.checks if not c.passed]


def test_broken_plugin_fails_on_missing_function():
    report = run_conformance_checks(FIXTURE_BROKEN_PLUGIN)
    assert not report.passed
    failing = [c for c in report.checks if not c.passed]
    assert any("validate" in c.message for c in failing)


def test_calculate_score_must_return_int(tmp_path):
    _write_variant_plugin(
        tmp_path,
        calculate_score_body="    return float(scoresheet.get('high_balls', 0))\n",
    )
    report = run_conformance_checks(tmp_path)
    failing = [c for c in report.checks if not c.passed]
    assert any("calculate_score" in c.name and "int" in c.message for c in failing)


def test_scoresheet_schema_missing_key_fails(tmp_path):
    _write_variant_plugin(
        tmp_path,
        scoresheet_schema_body=(
            "    return [{'name': 'x', 'label': 'X', 'data_type': 'integer', "
            "'widget': 'counter', 'scope': 'alliance', 'default': 0}]\n"
        ),
    )
    report = run_conformance_checks(tmp_path)
    failing = [c for c in report.checks if not c.passed]
    assert any("scoresheet_schema" in c.name for c in failing)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/test_plugin_conformance.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named
'tournament_server.plugin_registry.conformance'`.

- [ ] **Step 3: Implement conformance checks**

Create `server/src/tournament_server/plugin_registry/conformance.py`:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from tournament_server.plugin_registry.errors import PluginLoadError
from tournament_server.plugin_registry.loader import load_game_plugin

VALID_DATA_TYPES = {"integer", "boolean", "enum"}
VALID_WIDGETS = {"toggle", "counter", "select", "radio"}
VALID_SCOPES = {"alliance", "team"}
_REQUIRED_FIELD_KEYS = {
    "name",
    "label",
    "data_type",
    "widget",
    "min",
    "max",
    "step",
    "options",
    "icon",
    "scope",
    "default",
}


@dataclass
class CheckResult:
    name: str
    passed: bool
    message: str = ""


@dataclass
class ConformanceReport:
    plugin_name: str | None
    checks: list[CheckResult] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return all(c.passed for c in self.checks)


def run_conformance_checks(plugin_dir: Path) -> ConformanceReport:
    try:
        plugin = load_game_plugin(plugin_dir)
    except PluginLoadError as exc:
        return ConformanceReport(
            plugin_name=None,
            checks=[CheckResult("plugin loads", False, str(exc))],
        )

    checks: list[CheckResult] = [CheckResult("plugin loads", True)]
    checks.append(_check_match_format(plugin.module))
    checks.append(_check_scoresheet_schema(plugin.module, "scoresheet_schema"))
    checks.append(_check_scoresheet_schema(plugin.module, "skills_scoresheet_schema"))
    checks.append(_check_calculate_score(plugin.module, "calculate_score"))
    checks.append(_check_calculate_score(plugin.module, "calculate_skills_score"))
    checks.append(_check_validate(plugin.module))
    checks.append(_check_rank_teams(plugin.module))

    return ConformanceReport(plugin_name=plugin.name, checks=checks)


def _check_match_format(module: Any) -> CheckResult:
    result = module.match_format()
    required_keys = {
        "alliance_count",
        "teams_per_alliance",
        "autonomous_seconds",
        "driver_seconds",
        "round_types",
    }
    missing = required_keys - result.keys()
    if missing:
        return CheckResult(
            "match_format() shape", False, f"missing keys: {sorted(missing)}"
        )
    if not isinstance(result["round_types"], list) or not result["round_types"]:
        return CheckResult(
            "match_format() shape", False, "round_types must be a non-empty list"
        )
    return CheckResult("match_format() shape", True)


def _check_scoresheet_schema(module: Any, function_name: str) -> CheckResult:
    fields = getattr(module, function_name)()
    if not isinstance(fields, list) or not fields:
        return CheckResult(
            f"{function_name}() shape", False, "must be a non-empty list"
        )
    for field_def in fields:
        missing = _REQUIRED_FIELD_KEYS - field_def.keys()
        if missing:
            return CheckResult(
                f"{function_name}() shape",
                False,
                f"field {field_def.get('name', '?')!r} missing keys: "
                f"{sorted(missing)}",
            )
        if field_def["data_type"] not in VALID_DATA_TYPES:
            return CheckResult(
                f"{function_name}() shape",
                False,
                f"field {field_def['name']!r} has invalid data_type "
                f"{field_def['data_type']!r}",
            )
        if field_def["widget"] not in VALID_WIDGETS:
            return CheckResult(
                f"{function_name}() shape",
                False,
                f"field {field_def['name']!r} has invalid widget "
                f"{field_def['widget']!r}",
            )
        if field_def["scope"] not in VALID_SCOPES:
            return CheckResult(
                f"{function_name}() shape",
                False,
                f"field {field_def['name']!r} has invalid scope "
                f"{field_def['scope']!r}",
            )
        if field_def["data_type"] == "enum" and not field_def.get("options"):
            return CheckResult(
                f"{function_name}() shape",
                False,
                f"enum field {field_def['name']!r} must declare options",
            )
    return CheckResult(f"{function_name}() shape", True)


def _sample_scoresheet(module: Any, function_name: str) -> dict[str, Any]:
    schema_fn_name = (
        "scoresheet_schema"
        if function_name == "calculate_score"
        else "skills_scoresheet_schema"
    )
    fields = getattr(module, schema_fn_name)()
    return {f["name"]: f["default"] for f in fields}


def _check_calculate_score(module: Any, function_name: str) -> CheckResult:
    fn = getattr(module, function_name)
    sample = _sample_scoresheet(module, function_name)
    first = fn(sample)
    second = fn(sample)
    if first != second:
        return CheckResult(
            f"{function_name}() determinism",
            False,
            "calling with the same input twice produced different results",
        )
    if not isinstance(first, int):
        return CheckResult(
            f"{function_name}() determinism",
            False,
            f"must return an int, got {type(first).__name__}",
        )
    return CheckResult(f"{function_name}() determinism", True)


def _check_validate(module: Any) -> CheckResult:
    sample = _sample_scoresheet(module, "calculate_score")
    result = module.validate(sample)
    if not isinstance(result, list):
        return CheckResult("validate() shape", False, "must return a list")
    return CheckResult("validate() shape", True)


def _check_rank_teams(module: Any) -> CheckResult:
    sample = [
        {
            "team_id": 1,
            "win_points": 4,
            "strength_of_schedule": 1.0,
            "tiebreaker_seed": 100,
        },
        {
            "team_id": 2,
            "win_points": 6,
            "strength_of_schedule": 2.0,
            "tiebreaker_seed": 200,
        },
        {
            "team_id": 3,
            "win_points": 4,
            "strength_of_schedule": 3.0,
            "tiebreaker_seed": 300,
        },
    ]
    result = module.rank_teams(sample)
    if len(result) != len(sample):
        return CheckResult(
            "rank_teams() structure", False, "must return one entry per input team"
        )
    ranks = sorted(r["rank"] for r in result)
    if ranks != list(range(1, len(sample) + 1)):
        return CheckResult(
            "rank_teams() structure",
            False,
            f"ranks must be exactly 1..{len(sample)} with no gaps or "
            f"duplicates, got {ranks}",
        )
    team_ids = {r["team_id"] for r in result}
    if team_ids != {r["team_id"] for r in sample}:
        return CheckResult(
            "rank_teams() structure", False, "must not add, drop, or change team_ids"
        )
    return CheckResult("rank_teams() structure", True)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/test_plugin_conformance.py -v
```

Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src/tournament_server/plugin_registry/conformance.py server/tests/test_plugin_conformance.py
git commit -m "$(cat <<'EOF'
Add plugin conformance checks

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `tm test-plugin` CLI

**Files:**
- Create: `server/src/tournament_server/cli.py`
- Modify: `server/pyproject.toml` (add `[project.scripts]`)
- Test: `server/tests/test_cli.py`

**Interfaces:**
- Consumes: `tournament_server.plugin_registry.conformance.run_conformance_checks`
  (Task 6).
- Produces: `main(argv: list[str] | None = None) -> int` and `run() -> None`
  (calls `sys.exit(main())`). `[project.scripts]` points at `run`, so
  installing the package gives a `tm` command on PATH.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_cli.py`:

```python
from pathlib import Path

from tournament_server.cli import main

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)
FIXTURE_BROKEN_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "broken-plugin"
)


def test_test_plugin_command_exits_zero_on_good_plugin(capsys):
    exit_code = main(["test-plugin", str(FIXTURE_EXAMPLE_PLUGIN)])
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "All checks passed" in captured.out


def test_test_plugin_command_exits_nonzero_on_broken_plugin(capsys):
    exit_code = main(["test-plugin", str(FIXTURE_BROKEN_PLUGIN)])
    assert exit_code == 1
    captured = capsys.readouterr()
    assert "FAIL" in captured.out
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/test_cli.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named
'tournament_server.cli'`.

- [ ] **Step 3: Implement the CLI**

Create `server/src/tournament_server/cli.py`:

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
        "test-plugin", help="Run conformance checks against a game plugin folder"
    )
    test_plugin_parser.add_argument("path", type=str)

    args = parser.parse_args(argv)

    if args.command == "test-plugin":
        return _run_test_plugin(Path(args.path))

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


def run() -> None:
    sys.exit(main())


if __name__ == "__main__":
    run()
```

Update `server/pyproject.toml` — add a `[project.scripts]` table (insert
after the `[project]` table's `dependencies` list, before
`[project.optional-dependencies]`):

```toml
[project.scripts]
tm = "tournament_server.cli:run"
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pip install -e ".[dev]" -q
.venv/bin/pytest tests/test_cli.py -v
```

Expected: PASS (both tests). Reinstalling with `pip install -e` picks up
the new `[project.scripts]` entry so the `tm` command also becomes
available at `.venv/bin/tm` — verify with:

```bash
.venv/bin/tm test-plugin tests/fixtures/plugins/games/example-game
echo "exit code: $?"
```

Expected: prints per-check PASS lines and "All checks passed for
'example-game'.", exit code 0.

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src/tournament_server/cli.py server/pyproject.toml server/tests/test_cli.py
git commit -m "$(cat <<'EOF'
Add `tm test-plugin` CLI

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Docs and final verification

**Files:**
- Modify: `server/CLAUDE.md`

**Interfaces:**
- Consumes: nothing new — this task documents Tasks 1–7's output.
- Produces: nothing new for later tasks to consume; it's documentation.

- [ ] **Step 1: Update `server/CLAUDE.md`**

Add a new section (insert it after the existing "## Layout" section and
before "## Known, deliberate gaps in this phase"):

```markdown
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
```

- [ ] **Step 2: Run the full test suite one final time**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/ -v
```

Expected: PASS — every test from every task in this plan, all green,
alongside every Phase 1 test still passing unchanged.

- [ ] **Step 3: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/CLAUDE.md
git commit -m "$(cat <<'EOF'
Document the plugin system in server/CLAUDE.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
