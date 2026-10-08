# Skills Challenges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an event run skills challenges: the game plugin names the skills types and scores them, an admin turns skills on and sets attempts, the admin app records and corrects attempts on a session Skills page, and session and season rankings gain skills tabs. Teamwork score corrections become admin only.

**Architecture:**
- **Plugin contract:** game plugins gain a required `skills_types()`, and `skills_scoresheet_schema` / `calculate_skills_score` take the type key. The loader and the conformance tool enforce it.
- **Storage:** a `skills_settings` row per event, a nullable `sessions.skills_attempts` override, and a `skills_attempts` table. Attempt numbers are derived, never stored.
- **Pure services:** `services/skills_rules.py` (effective allowed attempts, settings validation, generic scoresheet validation) and `services/skills_ranking.py` (one pure ranking function for both scopes).
- **API:** `routers/skills.py` exposes settings, session overrides, schemas, attempts and rankings, and broadcasts `skills_changed` / `skills_settings_changed`. `routers/scores.py` refuses a non-admin re-submission.
- **Shared UI:** `frontend/packages/shared/src/scoresheet/` holds a plugin-agnostic scoresheet form. `ApiError` gains the parsed error body so 422 violations reach the form.
- **Admin UI:** an Event Setup panel, a session Skills page (attempts line, override form, record form, attempts table with filter and edit dialog), and skills tabs on Session and Season Rankings.

**Tech Stack:**
- Server: FastAPI, SQLAlchemy 2.x, Alembic, SQLite, pytest.
- Frontend: React 19, TanStack Query, react-i18next, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-skills-challenges-design.md`

## Global Constraints

From the spec, verbatim:

- Never reference any real-world competition brand or product name anywhere.
- Every backend change ships with pytest unit and integration tests against a real FastAPI `TestClient` and a real temp-file SQLite database, in the same change as the code.
- Every frontend change ships with Vitest component tests and Playwright E2E coverage of its user-facing flows, with no mocking at the HTTP/WebSocket boundary in E2E.
- Schema changes go through the project's Alembic migration mechanism.
- Every user-facing string goes through `t(...)` in both the `en` and `zh` `admin.json` files.
- Plugin interface changes update the `tm test-plugin` conformance tool, the bundled sample plugin and the test fixture plugins in the same change.

Plan conventions:

- The new migration's revision is `a7d5e2c8f1b4` and its `down_revision` is `d8e4b2a6c9f3` (the current head).
- Work on branch `skills-challenges` in the main checkout. No worktrees, no pushing, no merging.
- Commit messages are plain sentences (no `feat:` prefixes) and end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands:
  - Server tests: `cd server && .venv/bin/pytest -q` (or `uv run pytest -q` if `.venv` is absent).
  - Admin unit tests: `cd frontend && npm test --workspace apps/admin -- --run`.
  - Shared unit tests: `cd frontend && npm test --workspace packages/shared`.
  - Type check: `cd frontend && npx tsc -b apps/admin && npx tsc -p packages/shared`.
  - E2E: `cd frontend/apps/admin && npx playwright test <file>`.

## Review Focus

1. **A tablet double-tap on Save attempt** must post once, not twice. Two posts would silently use up two of the team's attempts. Pinned in Task 9: `RecordAttemptForm` test "posts once when Save is clicked twice quickly".
2. **A plugin that raises while scoring a valid sheet** gives a 422 with a readable detail, stores nothing, and does not use up an attempt. Pinned in Task 5: `test_plugin_error_while_scoring_stores_nothing`.
3. **An admin correcting an attempt for a team that has since been un-checked-in, or after the allowed number was lowered below what the team already used,** succeeds. Corrections ignore check-in and the limit. Pinned in Task 5: `test_admin_edit_ignores_check_in_and_the_limit`.
4. **A JSON `true` sent as an attempts setting** (bool is an int subclass) is rejected with 422, never stored as 1. This applies to event settings and session overrides. Pinned in Task 4: `test_settings_reject_boolean_attempts`.
5. **The attempts-table filter with surrounding spaces or regex characters** (`"  s1 "`, `"("`) trims and matches literally. It never throws, and it never hides a matching team. Pinned in Task 10: `filterAttemptRows` tests.

## Decisions where the spec is silent

The executor follows these. They are not open questions.

- **Check-in refresh on the Skills page.** The spec says the checked-in list "refreshes on the existing check-in events", but the server broadcasts no check-in events. The Skills page reads the same `["participants", sessionId]` query key the Check-In tab writes, so check-ins made in the same browser show at once. Check-ins made elsewhere show on the next refetch (window focus or remount). No new event is added.
- **One realtime channel for skills.** Every skills event reaches `/ws/active-session`: `skills_changed` always goes there, and so do both kinds of `skills_settings_changed`. Skills UI therefore listens there only (`useSkillsLiveUpdates`), filtering by `session_id`.
- **`"overall"` is a reserved type key.** It would collide with the rankings `tab=overall`, so conformance rejects it.
- **An empty session override (`{}`) is stored as `NULL`.** It means "use the event setting".
- **Season tie between equal session keys:** sessions are ordered by `(session_date is None, session_date, id)`. An undated session counts as later than any dated one.
- **Team-number order inside a shared rank** is natural order ("9" < "9A" < "10" < "A1"), on the server and in the UI (`localeCompare(..., { numeric: true })`).
- **Create-attempt check order:** 404 session → 409 skills off → 422 unknown type → 422 unknown team → 409 not checked in → 409 no attempts left → 422 scoresheet → 422 plugin scoring error. A team with no attempts left is never told about field errors.
- **Skills attempts do not block deleting a session.** The spec says deleting a session deletes its attempts. `has_scored_matches` still counts only teamwork scores.
- **Scoresheet icons** are rendered as text (`aria-hidden`) in front of the label. Option values of `enum` fields are shown as-is, because plugin labels are not translated (spec: out of scope).
- **The counter's middle box accepts typed numbers.** The − and + buttons clamp to min/max. A typed value is sent unclamped, so the server's range check (and its per-field error) stays reachable from the UI.

---

### Task 1: Plugin contract — `skills_types` and typed skills functions

**Files:**
- Modify: `server/src/tournament_server/plugin_registry/loader.py`
- Modify: `server/src/tournament_server/plugin_registry/conformance.py`
- Modify: `server/plugins/games/sample_cooperative/plugin.py`
- Modify (fixtures): `server/tests/fixtures/plugins/games/{example-game,cooperative-game,captain-pick-game,fast-timer-game,no-autonomous-game,second-game,broken-plugin}/plugin.py`
- Modify: `server/tests/test_plugin_conformance.py`, `server/tests/test_sample_cooperative_plugin.py`, `server/tests/test_plugin_loader.py`
- Docs: `server/CLAUDE.md` ("Plugin system")

**Interfaces:**
- Produces (game-plugin contract, used by every later server task):
  - `skills_types() -> list[{"key": str, "label": str}]`, in tie-break priority order.
  - `skills_scoresheet_schema(skills_type: str) -> list[dict]`
  - `calculate_skills_score(skills_type: str, scoresheet: dict) -> int`
- Produces (fixtures later tasks rely on):
  - `example-game`: types `autonomous` ("Autonomous") then `driver` ("Driver").
    - Both have `objects_scored` (integer counter, 0–30, step 1, default 0).
    - `autonomous` also has `parked` (boolean toggle, default `False`).
    - Score = `objects_scored * 2`, plus 4 for a parked autonomous run.
  - `second-game`: `skills_types()` returns `[]` (a game with no skills).
  - `sample_cooperative`: `autonomous` then `driver`, each with the single `score` counter (0–999), scored as the value.

- [ ] **Step 1: Write the failing conformance tests.** In `server/tests/test_plugin_conformance.py`:

First, update the three existing inline plugins to the new contract, or they stop loading once the loader requires `skills_types`:
- In `_TEMPLATE` (where braces are doubled for `.format`), replace the two skills functions with:

```python
def skills_types():
    return [{{"key": "driver", "label": "Driver"}}]


def skills_scoresheet_schema(skills_type):
    return [{{"name": "x", "label": "X", "data_type": "integer", "widget": "counter",
             "min": 0, "max": 10, "step": 1, "options": None, "icon": None,
             "scope": "team", "default": 0}}]


def calculate_skills_score(skills_type, scoresheet):
    return int(scoresheet.get("x", 0))
```

- In the two plain triple-quoted plugin bodies, in `test_match_format_returning_wrong_type_fails_cleanly` and `test_scoresheet_field_missing_default_skips_dependent_checks_cleanly`, make the same replacement with single braces:

```python
def skills_types():
    return [{"key": "driver", "label": "Driver"}]


def skills_scoresheet_schema(skills_type):
    return [{"name": "x", "label": "X", "data_type": "integer", "widget": "counter",
             "min": 0, "max": 10, "step": 1, "options": None, "icon": None,
             "scope": "team", "default": 0}]


def calculate_skills_score(skills_type, scoresheet):
    return int(scoresheet.get("x", 0))
```

Then append the new tests:

```python
_SKILLS_BASE = '''
def match_format():
    return {
        "alliance_count": 2,
        "teams_per_alliance": 2,
        "autonomous_seconds": 15,
        "driver_seconds": 105,
        "round_types": ["practice", "qualification", "elimination"],
        "game_model": "head_to_head",
        "alliance_selection": "captain_pick",
        "finals_format": "single_elimination",
    }


def _field(name, scope):
    return {"name": name, "label": name.upper(), "data_type": "integer", "widget": "counter",
            "min": 0, "max": 10, "step": 1, "options": None, "icon": None,
            "scope": scope, "default": 0}


def scoresheet_schema():
    return [_field("x", "alliance")]


def calculate_score(scoresheet):
    return int(scoresheet.get("x", 0))


def validate(scoresheet):
    return []


def rank_teams(team_results):
    ordered = sorted(team_results, key=lambda r: -r["win_points"])
    return [{**r, "rank": i + 1} for i, r in enumerate(ordered)]
'''

_GOOD_SKILLS = '''
def skills_types():
    return [{"key": "autonomous", "label": "Autonomous"}, {"key": "driver", "label": "Driver"}]


def skills_scoresheet_schema(skills_type):
    return [_field("x", "team")]


def calculate_skills_score(skills_type, scoresheet):
    return int(scoresheet.get("x", 0))
'''


def _write_skills_plugin(tmp_path, skills_code: str):
    (tmp_path / "manifest.json").write_text(
        json.dumps(
            {"name": "skills-variant", "version": "1.0.0", "kind": "game", "display_name": "Skills Variant"}
        )
    )
    (tmp_path / "plugin.py").write_text(_SKILLS_BASE + skills_code)
    return tmp_path


def _named(report, name):
    return next(c for c in report.checks if c.name == name)


def test_valid_skills_types_pass_with_a_check_per_type(tmp_path):
    report = run_conformance_checks(_write_skills_plugin(tmp_path, _GOOD_SKILLS))
    assert report.passed, [c for c in report.checks if not c.passed]
    names = [c.name for c in report.checks]
    assert "skills_types() shape" in names
    for key in ("autonomous", "driver"):
        assert f"skills_scoresheet_schema({key!r}) shape" in names
        assert f"calculate_skills_score({key!r}) determinism" in names


def test_an_empty_type_list_passes_and_skips_per_type_checks(tmp_path):
    code = _GOOD_SKILLS.replace(
        'return [{"key": "autonomous", "label": "Autonomous"}, {"key": "driver", "label": "Driver"}]',
        "return []",
    ).replace('return [_field("x", "team")]', "return []")
    report = run_conformance_checks(_write_skills_plugin(tmp_path, code))
    assert report.passed, [c for c in report.checks if not c.passed]
    assert not any(c.name.startswith("skills_scoresheet_schema(") for c in report.checks)
    assert not any(c.name.startswith("calculate_skills_score(") for c in report.checks)


@pytest.mark.parametrize(
    ("types_literal", "message"),
    [
        ('[{"key": "driver", "label": "Driver"}, {"key": "driver", "label": "Again"}]', "duplicate"),
        ('[{"key": "Driver", "label": "Driver"}]', "must match"),
        ('[{"key": "driver-1", "label": "Driver"}]', "must match"),
        ('[{"key": 5, "label": "Driver"}]', "must match"),
        ('[{"key": "overall", "label": "Overall"}]', "reserved"),
        ('[{"key": "driver", "label": "  "}]', "non-empty label"),
        ('[{"key": "driver", "label": 7}]', "non-empty label"),
        ('[{"key": "driver"}]', "exactly"),
        ('[{"key": "driver", "label": "Driver", "icon": None}]', "exactly"),
        ('["driver"]', "exactly"),
        ('{"key": "driver", "label": "Driver"}', "must return a list"),
    ],
)
def test_bad_skills_types_fail(tmp_path, types_literal, message):
    code = _GOOD_SKILLS.replace(
        '[{"key": "autonomous", "label": "Autonomous"}, {"key": "driver", "label": "Driver"}]', types_literal
    )
    report = run_conformance_checks(_write_skills_plugin(tmp_path, code))
    check = _named(report, "skills_types() shape")
    assert not check.passed
    assert message in check.message
    assert not report.passed


def test_an_invalid_schema_for_one_type_fails_only_that_type(tmp_path):
    code = _GOOD_SKILLS.replace(
        'return [_field("x", "team")]',
        'field = _field("x", "team")\n'
        '    if skills_type == "driver":\n'
        '        del field["default"]\n'
        "    return [field]",
    )
    report = run_conformance_checks(_write_skills_plugin(tmp_path, code))
    assert _named(report, "skills_scoresheet_schema('autonomous') shape").passed
    driver = _named(report, "skills_scoresheet_schema('driver') shape")
    assert not driver.passed
    assert "default" in driver.message
    skipped = _named(report, "calculate_skills_score('driver') determinism")
    assert not skipped.passed
    assert "skipped" in skipped.message
    assert _named(report, "calculate_skills_score('autonomous') determinism").passed


def test_non_int_skills_scoring_fails(tmp_path):
    code = _GOOD_SKILLS.replace(
        'return int(scoresheet.get("x", 0))',
        'return float(scoresheet.get("x", 0)) if skills_type == "driver" else int(scoresheet.get("x", 0))',
    )
    report = run_conformance_checks(_write_skills_plugin(tmp_path, code))
    check = _named(report, "calculate_skills_score('driver') determinism")
    assert not check.passed
    assert "int" in check.message
```

Add `import pytest` at the top of the file if it is not imported yet.

In `server/tests/test_plugin_loader.py`, append:

```python
def test_game_plugin_without_skills_types_fails_to_load(tmp_path):
    import shutil

    plugin_dir = tmp_path / "no-skills-types"
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, plugin_dir)
    manifest = json.loads((plugin_dir / "manifest.json").read_text())
    manifest["name"] = "no-skills-types"
    (plugin_dir / "manifest.json").write_text(json.dumps(manifest))
    text = (plugin_dir / "plugin.py").read_text()
    stripped = text.replace("def skills_types(", "def _not_skills_types(")
    assert stripped != text, "fixture setup did not find skills_types"
    (plugin_dir / "plugin.py").write_text(stripped)

    with pytest.raises(PluginLoadError, match="skills_types"):
        load_game_plugin(plugin_dir)
```

In `server/tests/test_sample_cooperative_plugin.py`:
- In `test_the_score_is_the_number_entered`, change the last line to `assert module.calculate_skills_score("driver", {"score": 42}) == 42`.
- Append:

```python
def test_skills_types_are_autonomous_then_driver_scored_as_entered():
    module = load_plugin(SAMPLE_PLUGIN, GAME_PLUGIN_KIND).module
    assert module.skills_types() == [
        {"key": "autonomous", "label": "Autonomous"},
        {"key": "driver", "label": "Driver"},
    ]
    for key in ("autonomous", "driver"):
        assert [f["name"] for f in module.skills_scoresheet_schema(key)] == ["score"]
        assert module.calculate_skills_score(key, {"score": 34}) == 34
```

- [ ] **Step 2: Run to verify failure.** `cd server && .venv/bin/pytest tests/test_plugin_conformance.py tests/test_plugin_loader.py tests/test_sample_cooperative_plugin.py -q`. Expected: FAIL. There is no `skills_types() shape` check, the loader does not require `skills_types`, and the sample plugin has no `skills_types`.

- [ ] **Step 3: Require `skills_types` in the loader.** In `loader.py`, make the tuple:

```python
REQUIRED_GAME_PLUGIN_FUNCTIONS = (
    "match_format",
    "scoresheet_schema",
    "calculate_score",
    "validate",
    "rank_teams",
    "skills_types",
    "skills_scoresheet_schema",
    "calculate_skills_score",
)
```

- [ ] **Step 4: Rewrite the skills part of conformance.** In `conformance.py`:

Add `import re` at the top and, beside the other constants:

```python
_SKILLS_KEY_PATTERN = re.compile(r"[a-z0-9_]+")
# "overall" names the rankings tab that sums every type, so no type may use it.
RESERVED_SKILLS_KEYS = {"overall"}
```

In `_run_game_checks`, delete the whole `skills_schema_result` block, the `checks.append(skills_schema_result)` line, and the `if skills_schema_result.passed: ... else: ...` block for `calculate_skills_score() determinism`. In their place, immediately before the `rank_teams() structure` check, add:

```python
    types_result = _safe_check("skills_types() shape", lambda: _check_skills_types(plugin.module))
    checks.append(types_result)
    if types_result.passed:
        for key in [t["key"] for t in plugin.module.skills_types()]:
            schema_check = _safe_check(
                f"skills_scoresheet_schema({key!r}) shape",
                lambda key=key: _check_skills_scoresheet_schema(plugin.module, key),
            )
            checks.append(schema_check)
            score_name = f"calculate_skills_score({key!r}) determinism"
            if schema_check.passed:
                checks.append(
                    _safe_check(score_name, lambda key=key: _check_calculate_skills_score(plugin.module, key))
                )
            else:
                checks.append(
                    CheckResult(score_name, False, f"skipped: skills_scoresheet_schema({key!r}) is invalid")
                )
```

Replace `_check_scoresheet_schema`, `_sample_scoresheet` and `_check_calculate_score` with:

```python
def _check_scoresheet_schema(module: Any, function_name: str) -> CheckResult:
    return _check_fields(f"{function_name}() shape", getattr(module, function_name)())


def _check_skills_scoresheet_schema(module: Any, key: str) -> CheckResult:
    return _check_fields(f"skills_scoresheet_schema({key!r}) shape", module.skills_scoresheet_schema(key))


def _check_fields(check_name: str, fields: Any) -> CheckResult:
    if not isinstance(fields, list) or not fields:
        return CheckResult(check_name, False, "must be a non-empty list")
    for field_def in fields:
        missing = _REQUIRED_FIELD_KEYS - field_def.keys()
        if missing:
            return CheckResult(
                check_name,
                False,
                f"field {field_def.get('name', '?')!r} missing keys: {sorted(missing)}",
            )
        if field_def["data_type"] not in VALID_DATA_TYPES:
            return CheckResult(
                check_name, False, f"field {field_def['name']!r} has invalid data_type {field_def['data_type']!r}"
            )
        if field_def["widget"] not in VALID_WIDGETS:
            return CheckResult(
                check_name, False, f"field {field_def['name']!r} has invalid widget {field_def['widget']!r}"
            )
        if field_def["scope"] not in VALID_SCOPES:
            return CheckResult(
                check_name, False, f"field {field_def['name']!r} has invalid scope {field_def['scope']!r}"
            )
        if field_def["data_type"] == "enum" and not field_def.get("options"):
            return CheckResult(check_name, False, f"enum field {field_def['name']!r} must declare options")
    return CheckResult(check_name, True)


def _defaults(fields: list[dict[str, Any]]) -> dict[str, Any]:
    return {f["name"]: f["default"] for f in fields}


def _check_deterministic_int(check_name: str, score) -> CheckResult:
    first = score()
    second = score()
    if first != second:
        return CheckResult(check_name, False, "calling with the same input twice produced different results")
    if not isinstance(first, int):
        return CheckResult(check_name, False, f"must return an int, got {type(first).__name__}")
    return CheckResult(check_name, True)


def _check_calculate_score(module: Any, function_name: str = "calculate_score") -> CheckResult:
    sample = _defaults(module.scoresheet_schema())
    return _check_deterministic_int("calculate_score() determinism", lambda: module.calculate_score(sample))


def _check_calculate_skills_score(module: Any, key: str) -> CheckResult:
    sample = _defaults(module.skills_scoresheet_schema(key))
    return _check_deterministic_int(
        f"calculate_skills_score({key!r}) determinism",
        lambda: module.calculate_skills_score(key, sample),
    )


def _check_skills_types(module: Any) -> CheckResult:
    name = "skills_types() shape"
    types = module.skills_types()
    if not isinstance(types, list):
        return CheckResult(name, False, "must return a list")
    seen: set[str] = set()
    for item in types:
        if not isinstance(item, dict) or set(item) != {"key", "label"}:
            return CheckResult(name, False, "each type must be a dict with exactly 'key' and 'label'")
        key, label = item["key"], item["label"]
        if not isinstance(key, str) or not _SKILLS_KEY_PATTERN.fullmatch(key):
            return CheckResult(name, False, f"type key {key!r} must match ^[a-z0-9_]+$")
        if key in RESERVED_SKILLS_KEYS:
            return CheckResult(name, False, f"type key {key!r} is reserved")
        if key in seen:
            return CheckResult(name, False, f"duplicate type key {key!r}")
        seen.add(key)
        if not isinstance(label, str) or not label.strip():
            return CheckResult(name, False, f"type {key!r} needs a non-empty label")
    return CheckResult(name, True)
```

`_check_validate` used `_sample_scoresheet(module, "calculate_score")`. Change its first line to `sample = _defaults(module.scoresheet_schema())`. The existing call `_check_calculate_score(plugin.module, "calculate_score")` keeps working, because the second parameter is accepted and ignored.

- [ ] **Step 5: Update the sample plugin.** In `server/plugins/games/sample_cooperative/plugin.py`, replace everything from the comment `# Skills isn't designed yet;` to the end of the file with:

```python
# Skills challenges: one team alone on the field. Autonomous is listed first,
# so its best breaks Overall ties before Driver's (see the skills spec, 2.3).


def skills_types() -> list[dict[str, str]]:
    return [
        {"key": "autonomous", "label": "Autonomous"},
        {"key": "driver", "label": "Driver"},
    ]


def skills_scoresheet_schema(skills_type: str) -> list[dict[str, Any]]:
    # Both types are a single number entered by the referee.
    return [_score_field("team")]


def calculate_skills_score(skills_type: str, scoresheet: dict[str, Any]) -> int:
    return int(scoresheet.get("score", 0))
```

- [ ] **Step 6: Update the fixture plugins.**
- **`example-game/plugin.py`:** replace both skills functions with:

```python
def skills_types() -> list[dict[str, str]]:
    return [
        {"key": "autonomous", "label": "Autonomous"},
        {"key": "driver", "label": "Driver"},
    ]


def _objects_field() -> dict[str, Any]:
    return {
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
    }


def skills_scoresheet_schema(skills_type: str) -> list[dict[str, Any]]:
    fields = [_objects_field()]
    if skills_type == "autonomous":
        fields.append(
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
            }
        )
    return fields


def calculate_skills_score(skills_type: str, scoresheet: dict[str, Any]) -> int:
    score = scoresheet.get("objects_scored", 0) * 2
    if skills_type == "autonomous" and scoresheet.get("parked"):
        score += 4
    return score
```

- **`cooperative-game`, `captain-pick-game`, `fast-timer-game`, `no-autonomous-game`, `broken-plugin`:**
  - Change the signatures to `def skills_scoresheet_schema(skills_type: str) -> list[dict[str, Any]]:` and `def calculate_skills_score(skills_type: str, scoresheet: dict[str, Any]) -> int:`. Leave both bodies unchanged.
  - Add, directly above `skills_scoresheet_schema`:

```python
def skills_types() -> list[dict[str, str]]:
    return [{"key": "driver", "label": "Driver"}]
```

  `broken-plugin` must still be missing only `validate`, so it gets `skills_types` too.
- **`second-game`:** make the same signature changes, and add:

```python
def skills_types() -> list[dict[str, str]]:
    # A game with no skills challenges.
    return []
```

- [ ] **Step 7: Run to verify the tests pass.** `.venv/bin/pytest tests/test_plugin_conformance.py tests/test_plugin_loader.py tests/test_sample_cooperative_plugin.py tests/test_cli.py tests/test_plugin_discovery.py tests/test_plugins_router.py -q`. Expected: all pass.

- [ ] **Step 8: Run the whole server suite.** `.venv/bin/pytest -q`. Expected: all pass. Nothing outside the plugin registry calls the skills functions yet.

- [ ] **Step 9: Document.** In `server/CLAUDE.md` "Plugin system", change "must define seven module-level functions" to "must define eight module-level functions". Add `skills_types` to the list after `rank_teams`, and add this paragraph after the list's paragraph:

> Skills challenges: `skills_types()` returns the game's skills types as `[{"key", "label"}]` in tie-break priority order. Keys are unique, match `^[a-z0-9_]+$`, and must not be `overall` (the rankings tab that sums every type). An empty list means the game has no skills. `skills_scoresheet_schema(skills_type)` and `calculate_skills_score(skills_type, scoresheet)` take the type key. Conformance checks the types' shape, then each type's schema and its scoring (an int, deterministic on the defaults sheet), and skips the per-type checks for an empty list. The sample game has `autonomous` then `driver`, each a single `score` counter.

- [ ] **Step 10: Commit.**

```bash
git add server/src/tournament_server/plugin_registry server/plugins/games/sample_cooperative/plugin.py server/tests/fixtures/plugins/games server/tests/test_plugin_conformance.py server/tests/test_plugin_loader.py server/tests/test_sample_cooperative_plugin.py server/CLAUDE.md
git commit -m "Let game plugins name their skills types and score each one

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Skills tables, session override column, migration, session deletion

**Files:**
- Create: `server/src/tournament_server/models/skills.py`
- Modify: `server/src/tournament_server/models/session.py`, `server/src/tournament_server/models/__init__.py`
- Create: `server/src/tournament_server/_alembic/versions/a7d5e2c8f1b4_add_skills_challenges.py`
- Modify: `server/src/tournament_server/services/deletion.py`
- Test: `server/tests/test_migrations.py`, `server/tests/test_session_delete.py`

**Interfaces:**
- Produces:
  - `models.skills.SkillsSettings` with `event_id: int`, `enabled: bool` (default `False`) and `attempts: dict[str, int]` (default `{}`).
  - `models.skills.SkillsAttempt` with `id`, `session_id`, `team_id`, `skills_type: str`, `data_json: str`, `score: int`, `plugin_name`, `plugin_version`, `recorded_at` and `updated_at` (`dt.datetime`, UTC). It has index `ix_skills_attempts_session_team_type`.
  - `TournamentSession.skills_attempts: dict[str, int] | None`
  - `services.deletion.delete_session` also deletes the session's `SkillsAttempt` rows.

- [ ] **Step 1: Write the failing tests.** Append to `server/tests/test_migrations.py`:

```python
def test_skills_migration_adds_tables_and_leaves_sessions_without_override(tmp_path):
    db_path = str(tmp_path / "skills.db")
    command.upgrade(_make_alembic_config(db_path), "d8e4b2a6c9f3")  # the revision before
    raw_engine = create_engine(f"sqlite:///{db_path}")
    with raw_engine.connect() as connection:
        connection.execute(
            text("INSERT INTO events (id, name, created_at) VALUES (1, 'League', '2026-01-01 00:00:00')")
        )
        connection.execute(text("INSERT INTO sessions (id, event_id, label) VALUES (1, 1, 'Saturday')"))
        connection.commit()
    raw_engine.dispose()

    engine = make_engine(db_path)
    assert ensure_schema_current(engine, db_path) == MigrationOutcome.UPGRADED
    inspector = inspect(engine)
    assert {"skills_settings", "skills_attempts"} <= set(inspector.get_table_names())
    assert "ix_skills_attempts_session_team_type" in {
        index["name"] for index in inspector.get_indexes("skills_attempts")
    }
    with engine.connect() as connection:
        override = connection.execute(text("SELECT skills_attempts FROM sessions WHERE id = 1")).scalar_one()
    assert override is None
```

Append to `server/tests/test_session_delete.py`:

```python
def test_delete_session_removes_its_skills_attempts(client):
    from tournament_server.models.skills import SkillsAttempt

    _setup_event(client)
    session_id, team_ids = _scheduled_session(client)
    other_id, other_team_ids = _scheduled_session(client, "Sunday")
    db = client.app.state.session_factory()
    try:
        for sid, team_id in ((session_id, team_ids[0]), (other_id, other_team_ids[0])):
            db.add(
                SkillsAttempt(
                    session_id=sid,
                    team_id=team_id,
                    skills_type="driver",
                    data_json='{"objects_scored": 5}',
                    score=10,
                    plugin_name="example-game",
                    plugin_version="1.0.0",
                )
            )
        db.commit()
    finally:
        db.close()

    assert client.delete(f"/api/sessions/{session_id}").status_code == 204

    db = client.app.state.session_factory()
    try:
        assert _count(db, SkillsAttempt, SkillsAttempt.session_id == session_id) == 0
        assert _count(db, SkillsAttempt, SkillsAttempt.session_id == other_id) == 1
    finally:
        db.close()
```

- [ ] **Step 2: Run to verify failure.** `.venv/bin/pytest tests/test_migrations.py tests/test_session_delete.py -q -k skills`. Expected: FAIL, with `ModuleNotFoundError: tournament_server.models.skills` and missing tables.

- [ ] **Step 3: Implement the models.** Create `models/skills.py`:

```python
from __future__ import annotations

import datetime as dt

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime, utc_now


class SkillsSettings(Base):
    """An event's skills-challenge settings. One row per event, created on the
    first save; until then reads use the defaults (off, 3 attempts per type)."""

    __tablename__ = "skills_settings"
    __table_args__ = (UniqueConstraint("event_id", name="uq_skills_settings_event"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    # The "Run skills challenges" switch.
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # Type key -> attempts allowed per team per session; a missing type means 3.
    attempts: Mapped[dict[str, int]] = mapped_column(JSON, default=dict)


class SkillsAttempt(Base):
    """One recorded skills run. Its attempt number is derived (the team's
    attempts of this type in this session, ordered by recorded_at then id),
    so deleting one moves the later ones up."""

    __tablename__ = "skills_attempts"
    __table_args__ = (
        Index("ix_skills_attempts_session_team_type", "session_id", "team_id", "skills_type"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    skills_type: Mapped[str] = mapped_column(String(50))
    data_json: Mapped[str] = mapped_column(Text)
    score: Mapped[int] = mapped_column(Integer)
    plugin_name: Mapped[str] = mapped_column(String(200))
    plugin_version: Mapped[str] = mapped_column(String(50))
    recorded_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
    updated_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
```

In `models/session.py`, after `qualification_drops`:

```python
    # Per-session skills attempts override (type key -> allowed attempts);
    # NULL uses the event setting, and a type missing here falls back to it.
    skills_attempts: Mapped[dict[str, int] | None] = mapped_column(JSON, default=None)
```

In `models/__init__.py`, add `from tournament_server.models.skills import SkillsAttempt, SkillsSettings`, and add both names to `__all__` in alphabetical position.

- [ ] **Step 4: Write the migration.** Create `_alembic/versions/a7d5e2c8f1b4_add_skills_challenges.py`:

```python
"""add skills challenges: skills_settings, skills_attempts, sessions.skills_attempts

Revision ID: a7d5e2c8f1b4
Revises: d8e4b2a6c9f3
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import tournament_server.db

revision: str = 'a7d5e2c8f1b4'
down_revision: Union[str, None] = 'd8e4b2a6c9f3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'skills_settings',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('event_id', sa.Integer(), nullable=False),
        sa.Column('enabled', sa.Boolean(), nullable=False),
        sa.Column('attempts', sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(['event_id'], ['events.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('event_id', name='uq_skills_settings_event'),
    )
    op.create_table(
        'skills_attempts',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('session_id', sa.Integer(), nullable=False),
        sa.Column('team_id', sa.Integer(), nullable=False),
        sa.Column('skills_type', sa.String(length=50), nullable=False),
        sa.Column('data_json', sa.Text(), nullable=False),
        sa.Column('score', sa.Integer(), nullable=False),
        sa.Column('plugin_name', sa.String(length=200), nullable=False),
        sa.Column('plugin_version', sa.String(length=50), nullable=False),
        sa.Column('recorded_at', tournament_server.db.UTCDateTime(), nullable=False),
        sa.Column('updated_at', tournament_server.db.UTCDateTime(), nullable=False),
        sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ),
        sa.ForeignKeyConstraint(['team_id'], ['teams.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_skills_attempts_session_team_type',
        'skills_attempts',
        ['session_id', 'team_id', 'skills_type'],
        unique=False,
    )
    op.add_column('sessions', sa.Column('skills_attempts', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('sessions', 'skills_attempts')
    op.drop_index('ix_skills_attempts_session_team_type', table_name='skills_attempts')
    op.drop_table('skills_attempts')
    op.drop_table('skills_settings')
```

- [ ] **Step 5: Delete attempts with their session.** In `services/deletion.py`, import `from tournament_server.models.skills import SkillsAttempt`. In `delete_session`, change the loop's tuple to `(ScheduleGeneration, Ranking, SessionParticipation, SessionPlayingWindow, SkillsAttempt)`.

- [ ] **Step 6: Run to verify the tests pass.** `.venv/bin/pytest tests/test_migrations.py tests/test_session_delete.py tests/test_alembic_drift.py tests/test_alembic_baseline.py -q`. Expected: all pass. The drift test confirms the models match the migrations.

- [ ] **Step 7: Commit.**

```bash
git add server/src/tournament_server/models server/src/tournament_server/_alembic/versions/a7d5e2c8f1b4_add_skills_challenges.py server/src/tournament_server/services/deletion.py server/tests/test_migrations.py server/tests/test_session_delete.py
git commit -m "Store skills settings, session attempt overrides and skills attempts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Pure rules — allowed attempts, scoresheet validation, ranking

**Files:**
- Create: `server/src/tournament_server/services/skills_rules.py`
- Create: `server/src/tournament_server/services/skills_ranking.py`
- Test: `server/tests/test_skills_rules.py`, `server/tests/test_skills_ranking.py`

**Interfaces:**
- Produces, in `services.skills_rules`:
  - `DEFAULT_ATTEMPTS = 3`, `MIN_ATTEMPTS = 1`, `MAX_ATTEMPTS = 20`
  - `effective_allowed(type_keys: Sequence[str], event_attempts: Mapping[str, int], override: Mapping[str, int] | None) -> dict[str, int]`
  - `skills_depth(allowed_maps: Iterable[Mapping[str, int]]) -> int`: the largest allowed number in any map, or 0.
  - `attempts_error(attempts: Mapping[str, int], type_keys: Sequence[str]) -> str | None`
  - `scoresheet_violations(fields: list[dict[str, Any]], data: Mapping[str, Any]) -> list[dict[str, str]]`: each item is `{"field", "message"}`. Schema fields come first, in schema order, then unknown keys.
- Produces, in `services.skills_ranking`:
  - `OVERALL = "overall"`
  - `@dataclass(frozen=True) AttemptScore(session_id: int, team_id: int, skills_type: str, score: int)`
  - `@dataclass SkillsRankingRow(rank: int, team_id: int, score: int, attempts: list[int], session_id: int)`
  - `session_order_key(session_date: dt.date | None, session_id: int) -> tuple`
  - `team_number_sort_key(number: str) -> tuple`
  - `rank_skills(attempts: Iterable[AttemptScore], type_keys: Sequence[str], tab: str, depth: int, session_order: Mapping[int, tuple], team_numbers: Mapping[int, str]) -> list[SkillsRankingRow]`. The same function serves one session (only that session's attempts are passed) and the season (every session's attempts are passed).

- [ ] **Step 1: Write the failing rules tests.** Create `server/tests/test_skills_rules.py`:

```python
import pytest

from tournament_server.services.skills_rules import (
    attempts_error,
    effective_allowed,
    scoresheet_violations,
    skills_depth,
)

KEYS = ["autonomous", "driver"]


def test_effective_allowed_defaults_to_three():
    assert effective_allowed(KEYS, {}, None) == {"autonomous": 3, "driver": 3}


def test_effective_allowed_uses_the_event_setting_then_the_override():
    assert effective_allowed(KEYS, {"driver": 5}, None) == {"autonomous": 3, "driver": 5}
    assert effective_allowed(KEYS, {"driver": 5}, {"autonomous": 1}) == {"autonomous": 1, "driver": 5}
    assert effective_allowed(KEYS, {"driver": 5}, {"driver": 2}) == {"autonomous": 3, "driver": 2}


def test_effective_allowed_ignores_keys_the_plugin_does_not_list():
    assert effective_allowed(["driver"], {"teleop": 9}, {"teleop": 1}) == {"driver": 3}


def test_skills_depth_is_the_largest_allowed_number():
    assert skills_depth([{"autonomous": 1, "driver": 3}, {"autonomous": 4, "driver": 2}]) == 4
    assert skills_depth([]) == 0
    assert skills_depth([{}]) == 0


@pytest.mark.parametrize(
    ("attempts", "message"),
    [
        ({"teleop": 3}, "'teleop' is not a skills type for this game"),
        ({"driver": 0}, "Attempts for 'driver' must be a whole number from 1 to 20"),
        ({"driver": 21}, "Attempts for 'driver' must be a whole number from 1 to 20"),
    ],
)
def test_attempts_error(attempts, message):
    assert attempts_error(attempts, KEYS) == message


def test_attempts_error_accepts_the_bounds_and_an_empty_map():
    assert attempts_error({"autonomous": 1, "driver": 20}, KEYS) is None
    assert attempts_error({}, KEYS) is None


FIELDS = [
    {"name": "balls", "label": "Balls", "data_type": "integer", "widget": "counter",
     "min": 0, "max": 10, "step": 2, "options": None, "icon": None, "scope": "team", "default": 0},
    {"name": "parked", "label": "Parked", "data_type": "boolean", "widget": "toggle",
     "min": None, "max": None, "step": None, "options": None, "icon": None, "scope": "team", "default": False},
    {"name": "zone", "label": "Zone", "data_type": "enum", "widget": "select",
     "min": None, "max": None, "step": None, "options": ["near", "far"], "icon": None, "scope": "team",
     "default": "near"},
]
VALID = {"balls": 4, "parked": True, "zone": "far"}


def test_a_valid_sheet_has_no_violations():
    assert scoresheet_violations(FIELDS, VALID) == []


@pytest.mark.parametrize(
    ("changes", "field", "message"),
    [
        ({"balls": 12}, "balls", "Must be at most 10."),
        ({"balls": -2}, "balls", "Must be at least 0."),
        ({"balls": 3}, "balls", "Must be in steps of 2."),
        ({"balls": True}, "balls", "Must be a whole number."),
        ({"balls": 4.0}, "balls", "Must be a whole number."),
        ({"balls": "4"}, "balls", "Must be a whole number."),
        ({"balls": None}, "balls", "Must be a whole number."),
        ({"parked": 1}, "parked", "Must be true or false."),
        ({"parked": "true"}, "parked", "Must be true or false."),
        ({"zone": "middle"}, "zone", "Must be one of: near, far."),
        ({"zone": None}, "zone", "Must be one of: near, far."),
    ],
)
def test_each_bad_value_is_reported_on_its_field(changes, field, message):
    assert scoresheet_violations(FIELDS, {**VALID, **changes}) == [{"field": field, "message": message}]


def test_missing_and_unknown_fields_are_each_reported_in_order():
    data = {"parked": False, "extra": 1, "balls": 99}
    assert scoresheet_violations(FIELDS, data) == [
        {"field": "balls", "message": "Must be at most 10."},
        {"field": "zone", "message": "This field is required."},
        {"field": "extra", "message": "Unknown field."},
    ]


def test_step_counts_from_the_minimum():
    fields = [{**FIELDS[0], "min": 1, "max": 9, "step": 2}]
    assert scoresheet_violations(fields, {"balls": 5}) == []
    assert scoresheet_violations(fields, {"balls": 4}) == [{"field": "balls", "message": "Must be in steps of 2."}]


def test_unset_bounds_and_step_are_not_checked():
    fields = [{**FIELDS[0], "min": None, "max": None, "step": None}]
    assert scoresheet_violations(fields, {"balls": -7}) == []
    assert scoresheet_violations(fields, {"balls": 1001}) == []
```

- [ ] **Step 2: Write the failing ranking tests.** Create `server/tests/test_skills_ranking.py`:

```python
import datetime as dt

from tournament_server.services.skills_ranking import (
    OVERALL,
    AttemptScore,
    rank_skills,
    session_order_key,
    team_number_sort_key,
)
from tournament_server.services.skills_rules import effective_allowed, skills_depth

KEYS = ["autonomous", "driver"]
ORDER = {1: session_order_key(dt.date(2026, 10, 10), 1), 2: session_order_key(dt.date(2026, 10, 11), 2)}
NUMBERS = {1: "1", 2: "2", 3: "3", 4: "4", 10: "10"}


def a(team, skills_type, score, session=1):
    return AttemptScore(session_id=session, team_id=team, skills_type=skills_type, score=score)


def table(rows):
    return [(r.rank, r.team_id, r.score, r.attempts, r.session_id) for r in rows]


def rank(attempts, tab, depth=3, keys=KEYS, order=ORDER, numbers=NUMBERS):
    return table(rank_skills(attempts, keys, tab, depth, order, numbers))


def test_a_type_tab_lists_only_teams_with_that_type_best_first():
    attempts = [a(1, "driver", 20), a(1, "driver", 28), a(2, "driver", 25), a(3, "autonomous", 40)]
    assert rank(attempts, "driver") == [(1, 1, 28, [28, 20], 1), (2, 2, 25, [25], 1)]


def test_overall_adds_each_type_best_and_a_missing_type_adds_nothing():
    attempts = [a(1, "driver", 30), a(2, "autonomous", 10), a(2, "driver", 25)]
    assert rank(attempts, OVERALL) == [(1, 2, 35, [10, 25], 1), (2, 1, 30, [30], 1)]


def test_a_missing_entry_ranks_below_zero():
    attempts = [a(1, "driver", 10), a(1, "driver", 0), a(2, "driver", 10)]
    assert rank(attempts, "driver") == [(1, 1, 10, [10, 0], 1), (2, 2, 10, [10], 1)]
    # Overall: equal sums and bests; team 1's second-best (0) beats team 2's missing one.
    assert rank(attempts, OVERALL) == [(1, 1, 10, [10, 0], 1), (2, 2, 10, [10], 1)]


def test_a_missing_type_best_ranks_below_a_zero_best():
    attempts = [a(1, "autonomous", 0), a(1, "driver", 20), a(2, "driver", 20)]
    assert rank(attempts, OVERALL)[0][1] == 1


def test_overall_ties_go_to_the_types_in_plugin_order():
    attempts = [a(1, "autonomous", 30), a(1, "driver", 20), a(2, "autonomous", 20), a(2, "driver", 30)]
    assert [row[1] for row in rank(attempts, OVERALL)] == [1, 2]
    assert [row[1] for row in rank(attempts, OVERALL, keys=["driver", "autonomous"])] == [2, 1]


def test_three_way_ties_share_a_rank_ordered_by_team_number():
    attempts = [a(10, "driver", 20), a(2, "driver", 20), a(3, "driver", 20)]
    assert rank(attempts, "driver") == [(1, 2, 20, [20], 1), (1, 3, 20, [20], 1), (1, 10, 20, [20], 1)]


def test_shared_ranks_skip_the_next_number():
    attempts = [a(1, "driver", 30), a(2, "driver", 20), a(3, "driver", 20), a(4, "driver", 10)]
    assert [(row[0], row[1]) for row in rank(attempts, "driver")] == [(1, 1), (2, 2), (2, 3), (4, 4)]


def test_ties_are_broken_at_depth_three():
    attempts = [a(1, "driver", s) for s in (20, 15, 10)] + [a(2, "driver", s) for s in (20, 15, 5)]
    assert [row[1] for row in rank(attempts, "driver")] == [1, 2]
    assert [(row[0], row[1]) for row in rank(attempts, OVERALL, depth=3)] == [(1, 1), (2, 2)]


def test_ties_are_broken_beyond_depth_three_only_as_deep_as_allowed():
    attempts = (
        [a(1, "autonomous", 5)] + [a(1, "driver", s) for s in (20, 15, 10, 8)]
        + [a(2, "autonomous", 5)] + [a(2, "driver", s) for s in (20, 15, 10, 7)]
    )
    assert [(row[0], row[1]) for row in rank(attempts, "driver")] == [(1, 1), (2, 2)]
    assert [(row[0], row[1]) for row in rank(attempts, OVERALL, depth=4)] == [(1, 1), (2, 2)]
    # With three attempts allowed, the fourth entries are not compared: a shared rank.
    assert [(row[0], row[1]) for row in rank(attempts, OVERALL, depth=3)] == [(1, 1), (1, 2)]


def test_overall_depth_follows_the_most_attempts_any_type_allows():
    allowed = effective_allowed(KEYS, {"autonomous": 1, "driver": 3}, None)
    depth = skills_depth([allowed])
    assert depth == 3
    attempts = (
        [a(1, "autonomous", 10)] + [a(1, "driver", s) for s in (20, 5, 5)]
        + [a(2, "autonomous", 10)] + [a(2, "driver", s) for s in (20, 5, 4)]
    )
    assert [(row[0], row[1]) for row in rank(attempts, OVERALL, depth=depth)] == [(1, 1), (2, 2)]


def test_season_overall_takes_the_best_session_and_never_mixes_sessions():
    attempts = [
        a(1, "autonomous", 34, session=1), a(1, "driver", 20, session=1),  # 54
        a(1, "autonomous", 24, session=2), a(1, "driver", 28, session=2),  # 52
    ]
    assert rank(attempts, OVERALL) == [(1, 1, 54, [34, 20], 1)]


def test_season_type_tab_comes_from_the_session_holding_the_best_attempt():
    attempts = [a(1, "driver", 20, session=1), a(1, "driver", 18, session=1), a(1, "driver", 25, session=2)]
    assert rank(attempts, "driver") == [(1, 1, 25, [25], 2)]


def test_equal_season_keys_name_the_earlier_session_by_date_then_id():
    order = {
        1: session_order_key(dt.date(2026, 10, 11), 1),
        2: session_order_key(dt.date(2026, 10, 10), 2),
        3: session_order_key(None, 3),
    }
    attempts = [a(1, "driver", 20, session=1), a(1, "driver", 20, session=2), a(1, "driver", 20, session=3)]
    assert rank(attempts, "driver", order=order)[0][4] == 2
    same_day = {1: session_order_key(dt.date(2026, 10, 10), 1), 2: session_order_key(dt.date(2026, 10, 10), 2)}
    assert rank(attempts[:2], "driver", order=same_day)[0][4] == 1


def test_undated_sessions_count_as_later_than_dated_ones():
    assert session_order_key(dt.date(2026, 10, 10), 5) < session_order_key(None, 1)


def test_no_attempts_ranks_nobody():
    assert rank([], OVERALL) == []
    assert rank([], "driver") == []


def test_team_numbers_sort_naturally():
    numbers = ["10", "9A", "A1", "9", "b2"]
    assert sorted(numbers, key=team_number_sort_key) == ["9", "9A", "10", "A1", "b2"]
```

- [ ] **Step 3: Run to verify failure.** `.venv/bin/pytest tests/test_skills_rules.py tests/test_skills_ranking.py -q`. Expected: `ModuleNotFoundError` for both modules.

- [ ] **Step 4: Implement the rules.** Create `services/skills_rules.py`:

```python
"""Skills-challenge rules that need no database: allowed attempts, settings
validation, and the generic scoresheet check run before any plugin code."""
from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence

DEFAULT_ATTEMPTS = 3
MIN_ATTEMPTS = 1
MAX_ATTEMPTS = 20


def effective_allowed(
    type_keys: Sequence[str],
    event_attempts: Mapping[str, int],
    override: Mapping[str, int] | None,
) -> dict[str, int]:
    """Attempts allowed per type in one session: the session override, else the
    event setting, else 3. Keys the plugin doesn't list are ignored."""
    override = override or {}
    return {
        key: override.get(key, event_attempts.get(key, DEFAULT_ATTEMPTS)) for key in type_keys
    }


def skills_depth(allowed_maps: Iterable[Mapping[str, int]]) -> int:
    """How deep Overall tie-break sums go: the most attempts any type allows."""
    return max((value for allowed in allowed_maps for value in allowed.values()), default=0)


def attempts_error(attempts: Mapping[str, int], type_keys: Sequence[str]) -> str | None:
    """A readable reason an attempts map is invalid, or None. Values are already
    strict ints (the request schema rejects booleans and floats)."""
    for key, value in attempts.items():
        if key not in type_keys:
            return f"{key!r} is not a skills type for this game"
        if not MIN_ATTEMPTS <= value <= MAX_ATTEMPTS:
            return f"Attempts for {key!r} must be a whole number from {MIN_ATTEMPTS} to {MAX_ATTEMPTS}"
    return None


def _field_problem(field: Mapping[str, Any], value: Any) -> str | None:
    data_type = field["data_type"]
    if data_type == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            return "Must be a whole number."
        low, high, step = field.get("min"), field.get("max"), field.get("step")
        if low is not None and value < low:
            return f"Must be at least {low}."
        if high is not None and value > high:
            return f"Must be at most {high}."
        if step and (value - (low if low is not None else 0)) % step:
            return f"Must be in steps of {step}."
        return None
    if data_type == "boolean":
        return None if isinstance(value, bool) else "Must be true or false."
    options = list(field.get("options") or [])
    if value in options and not isinstance(value, bool):
        return None
    return f"Must be one of: {', '.join(str(option) for option in options)}."


def scoresheet_violations(
    fields: list[dict[str, Any]], data: Mapping[str, Any]
) -> list[dict[str, str]]:
    """Every problem with a submitted scoresheet, one per bad or missing field
    (in schema order) and then one per unknown key."""
    violations: list[dict[str, str]] = []
    names = [field["name"] for field in fields]
    for field in fields:
        name = field["name"]
        if name not in data:
            violations.append({"field": name, "message": "This field is required."})
            continue
        problem = _field_problem(field, data[name])
        if problem is not None:
            violations.append({"field": name, "message": problem})
    for key in data:
        if key not in names:
            violations.append({"field": key, "message": "Unknown field."})
    return violations
```

- [ ] **Step 5: Implement the ranking.** Create `services/skills_ranking.py`:

```python
"""Skills rankings, computed on every read (skills spec 2.3).

Pure: callers pass attempt scores, the plugin's ordered type keys, the tie-break
depth, each session's order and each team's number. One session's attempts give
session rankings; every session's attempts give season rankings, where each team
is represented by its single best session (never a mix of sessions).

A key is a tuple of positions. A present value is (1, value) and a missing one
is (0,), so a missing entry ranks below any score, 0 included, and a shorter
per-type list is a prefix that compares lower.
"""
from __future__ import annotations

import datetime as dt
import re
from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence

OVERALL = "overall"
_MISSING: tuple = (0,)


def _present(value: int) -> tuple:
    return (1, value)


@dataclass(frozen=True)
class AttemptScore:
    session_id: int
    team_id: int
    skills_type: str
    score: int


@dataclass
class SkillsRankingRow:
    rank: int
    team_id: int
    score: int
    attempts: list[int]
    session_id: int


def session_order_key(session_date: dt.date | None, session_id: int) -> tuple:
    """Earlier sessions sort first: by date (undated ones last), then id."""
    return (session_date is None, session_date or dt.date.min, session_id)


def team_number_sort_key(number: str) -> tuple:
    """Natural order: "9" < "9A" < "10" < "A1"."""
    return tuple(
        (0, int(chunk), "") if chunk[0] in "0123456789" else (1, 0, chunk.lower())
        for chunk in re.findall(r"[0-9]+|[^0-9]+", number)
    )


def _type_lists(attempts: Iterable[AttemptScore]) -> dict[str, list[int]]:
    lists: dict[str, list[int]] = defaultdict(list)
    for attempt in attempts:
        lists[attempt.skills_type].append(attempt.score)
    return {key: sorted(scores, reverse=True) for key, scores in lists.items()}


def _tab_entry(
    lists: dict[str, list[int]], type_keys: Sequence[str], tab: str, depth: int
) -> tuple[tuple, int, list[int]] | None:
    """(key, displayed score, attempts best-first) for one team in one session, or None if unlisted."""
    if tab != OVERALL:
        scores = lists.get(tab)
        if not scores:
            return None
        return tuple(_present(score) for score in scores), scores[0], list(scores)
    if not any(lists.get(key) for key in type_keys):
        return None
    bests = [lists[key][0] if lists.get(key) else None for key in type_keys]
    score = sum(best for best in bests if best is not None)
    key = [_present(score)]
    key += [_MISSING if best is None else _present(best) for best in bests]
    for index in range(1, depth):
        at_depth = [lists[k][index] for k in type_keys if len(lists.get(k, ())) > index]
        key.append(_present(sum(at_depth)) if at_depth else _MISSING)
    flat = [value for k in type_keys for value in lists.get(k, [])]
    return tuple(key), score, flat


def rank_skills(
    attempts: Iterable[AttemptScore],
    type_keys: Sequence[str],
    tab: str,
    depth: int,
    session_order: Mapping[int, tuple],
    team_numbers: Mapping[int, str],
) -> list[SkillsRankingRow]:
    by_team_session: dict[tuple[int, int], list[AttemptScore]] = defaultdict(list)
    for attempt in attempts:
        by_team_session[(attempt.team_id, attempt.session_id)].append(attempt)

    best: dict[int, tuple[tuple, int, int, list[int]]] = {}
    for (team_id, session_id), group in by_team_session.items():
        entry = _tab_entry(_type_lists(group), type_keys, tab, depth)
        if entry is None:
            continue
        key, score, flat = entry
        current = best.get(team_id)
        if (
            current is None
            or key > current[0]
            or (key == current[0] and session_order[session_id] < session_order[current[1]])
        ):
            best[team_id] = (key, session_id, score, flat)

    ordered = sorted(best.items(), key=lambda item: team_number_sort_key(team_numbers.get(item[0], "")))
    ordered.sort(key=lambda item: item[1][0], reverse=True)  # stable: ties keep team-number order

    rows: list[SkillsRankingRow] = []
    previous: tuple | None = None
    rank = 0
    for index, (team_id, (key, session_id, score, flat)) in enumerate(ordered, start=1):
        if key != previous:
            rank, previous = index, key
        rows.append(SkillsRankingRow(rank, team_id, score, flat, session_id))
    return rows
```

- [ ] **Step 6: Run to verify the tests pass.** `.venv/bin/pytest tests/test_skills_rules.py tests/test_skills_ranking.py -q`. Expected: all pass.

- [ ] **Step 7: Commit.**

```bash
git add server/src/tournament_server/services/skills_rules.py server/src/tournament_server/services/skills_ranking.py server/tests/test_skills_rules.py server/tests/test_skills_ranking.py
git commit -m "Validate skills scoresheets and rank skills attempts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Settings, session overrides and scoresheet schemas over the API

**Files:**
- Create: `server/src/tournament_server/services/skills.py`
- Create: `server/src/tournament_server/schemas/skills.py`
- Create: `server/src/tournament_server/routers/skills.py`
- Modify: `server/src/tournament_server/app.py` (import `skills` from `tournament_server.routers` and add `app.include_router(skills.router)` after `ranking_settings.router`)
- Create: `server/tests/skills_helpers.py`
- Test: `server/tests/test_skills_settings.py`
- Docs: `server/CLAUDE.md`

**Interfaces:**
- Consumes:
  - Task 1's plugin contract and fixtures (`example-game` has `autonomous` and `driver`; `second-game` has none).
  - Task 2's `SkillsSettings` and `TournamentSession.skills_attempts`.
  - Task 3's `DEFAULT_ATTEMPTS`, `effective_allowed` and `attempts_error`.
- Produces:
  - `services.skills`:
    - `SKILLS_OFF_DETAIL`, `NO_PLUGIN_DETAIL`, `NO_TYPES_DETAIL`, `ADMIN_ONLY_DETAIL` (exact spec strings).
    - `event_plugin(request, event) -> LoadedPlugin | None`
    - `plugin_types(plugin) -> list[dict[str, str]]`
    - `find_settings(db, event_id) -> SkillsSettings | None`
    - `is_enabled(db, event_id) -> bool`
    - `event_attempts(db, event_id) -> dict[str, int]`
    - `session_allowed(db, session_obj, type_keys) -> dict[str, int]`
  - `routers.skills`: `router`, `_event_or_404(db)` and `_session_or_404(db, session_id)`. Tasks 5 and 6 add routes to this same module.
  - Endpoints:
    - `GET/PUT /api/skills/settings`
    - `GET/PUT /api/sessions/{id}/skills`
    - `GET /api/skills/types/{key}/schema`
  - WebSocket event `skills_settings_changed` `{session_id: int | null}`.
  - Test helpers in `server/tests/skills_helpers.py`:
    - `SECOND_GAME`
    - `create_event(client, team_count=3) -> list[int]` (example-game; teams numbered "1", "2", ...)
    - `create_session(client, label="Saturday", checked_in=(), session_date=None) -> int`
    - `enable_skills(client, attempts=None) -> None`
    - `admin_token(client) -> str`
    - `admitted_device_token(client) -> str`
    - `next_event(socket, name) -> dict`

- [ ] **Step 1: Write the test helpers.** Create `server/tests/skills_helpers.py`:

```python
"""Shared setup for the skills API tests."""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

SECOND_GAME = Path(__file__).parent / "fixtures" / "plugins" / "games" / "second-game"


def create_event(client, team_count: int = 3) -> list[int]:
    """An example-game event with teams numbered "1".."N"."""
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    return [
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in range(1, team_count + 1)
    ]


def create_session(client, label: str = "Saturday", checked_in=(), session_date: str | None = None) -> int:
    body = {"label": label}
    if session_date is not None:
        body["session_date"] = session_date
    session_id = client.post("/api/sessions", json=body).json()["id"]
    for team_id in checked_in:
        response = client.post(
            f"/api/sessions/{session_id}/participants", json={"team_id": team_id, "checked_in": True}
        )
        assert response.status_code == 201, response.text
    return session_id


def enable_skills(client, attempts: dict[str, int] | None = None) -> None:
    response = client.put("/api/skills/settings", json={"enabled": True, "attempts": attempts or {}})
    assert response.status_code == 200, response.text


def admin_token(client) -> str:
    return client.headers["Authorization"].removeprefix("Bearer ")


def admitted_device_token(client) -> str:
    """Registers a device and admits it (as the admin `client`); returns its token."""
    raw = TestClient(client.app)
    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json() if d["friendly_name"] == device["friendly_name"]
    )
    assert client.post(f"/api/devices/{device_id}/admit").status_code == 200
    return device["device_token"]


def next_event(socket, name: str) -> dict:
    """The next message called `name`, skipping any others."""
    while True:
        message = socket.receive_json()
        if message["event"] == name:
            return message
```

- [ ] **Step 2: Write the failing tests.** Create `server/tests/test_skills_settings.py`:

```python
import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from plugin_helpers import zip_fixture_plugin
from skills_helpers import SECOND_GAME, admin_token, create_event, create_session, enable_skills, next_event

TYPES = [{"key": "autonomous", "label": "Autonomous"}, {"key": "driver", "label": "Driver"}]


def test_settings_read_the_defaults_before_anything_is_saved(client):
    create_event(client)
    assert client.get("/api/skills/settings").json() == {
        "enabled": False,
        "attempts": {"autonomous": 3, "driver": 3},
        "types": TYPES,
    }


def test_settings_before_a_game_plugin_is_chosen(client):
    client.post("/api/event", json={"name": "League"})
    assert client.get("/api/skills/settings").json() == {"enabled": False, "attempts": {}, "types": []}
    refused = client.put("/api/skills/settings", json={"enabled": False, "attempts": {}})
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Choose a game plugin before setting up skills challenges."


def test_update_settings(client):
    create_event(client)
    response = client.put("/api/skills/settings", json={"enabled": True, "attempts": {"driver": 5}})
    assert response.status_code == 200, response.text
    expected = {"enabled": True, "attempts": {"autonomous": 3, "driver": 5}, "types": TYPES}
    assert response.json() == expected
    assert client.get("/api/skills/settings").json() == expected


@pytest.mark.parametrize(
    "attempts",
    [{"teleop": 3}, {"driver": 0}, {"driver": 21}, {"driver": 2.5}, {"driver": "3"}, {"driver": None}],
)
def test_update_settings_rejects_bad_attempts(client, attempts):
    create_event(client)
    assert client.put("/api/skills/settings", json={"enabled": True, "attempts": attempts}).status_code == 422
    assert client.get("/api/skills/settings").json()["enabled"] is False


def test_settings_reject_boolean_attempts(client):
    create_event(client)
    session_id = create_session(client)
    assert client.put("/api/skills/settings", json={"enabled": True, "attempts": {"driver": True}}).status_code == 422
    assert client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {"driver": True}}).status_code == 422
    assert client.get("/api/skills/settings").json()["attempts"]["driver"] == 3


def test_enabling_a_game_without_skills_types_is_refused(client):
    client.post("/api/event", json={"name": "League"})
    uploaded = client.post(
        "/api/plugins/games",
        files={"file": ("second-game.zip", zip_fixture_plugin(SECOND_GAME), "application/zip")},
    )
    assert uploaded.status_code == 201, uploaded.text
    assert client.post("/api/event/game-plugin", json={"name": "second-game"}).status_code == 200
    refused = client.put("/api/skills/settings", json={"enabled": True, "attempts": {}})
    assert refused.status_code == 409
    assert refused.json()["detail"] == "This game has no skills challenges."
    allowed = client.put("/api/skills/settings", json={"enabled": False, "attempts": {}})
    assert allowed.status_code == 200
    assert allowed.json() == {"enabled": False, "attempts": {}, "types": []}


def test_settings_are_read_by_any_role_and_changed_by_admin_only(client):
    create_event(client)
    raw = TestClient(client.app)
    assert raw.get("/api/skills/settings").status_code == 401
    assert raw.get("/api/skills/settings", headers=bearer(login_as(raw, "attendee"))).status_code == 200
    scorer = bearer(login_as(raw, "scorer"))
    assert raw.put("/api/skills/settings", json={"enabled": True, "attempts": {}}, headers=scorer).status_code == 403


def test_settings_change_broadcasts_on_the_active_session_channel(client):
    create_event(client)
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        enable_skills(client)
        assert next_event(socket, "skills_settings_changed")["data"] == {"session_id": None}


def test_session_override_set_and_cleared(client):
    create_event(client)
    enable_skills(client, {"driver": 5})
    session_id = create_session(client)

    assert client.get(f"/api/sessions/{session_id}/skills").json() == {
        "types": [{**TYPES[0], "allowed": 3}, {**TYPES[1], "allowed": 5}],
        "override": None,
    }
    overridden = client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {"autonomous": 1}})
    assert overridden.status_code == 200, overridden.text
    assert overridden.json() == {
        "types": [{**TYPES[0], "allowed": 1}, {**TYPES[1], "allowed": 5}],
        "override": {"autonomous": 1},
    }
    cleared = client.put(f"/api/sessions/{session_id}/skills", json={"attempts": None})
    assert cleared.json()["override"] is None
    assert [t["allowed"] for t in cleared.json()["types"]] == [3, 5]
    emptied = client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {}})
    assert emptied.json()["override"] is None


def test_session_override_validation_permissions_and_404(client):
    create_event(client)
    session_id = create_session(client)
    assert client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {"teleop": 2}}).status_code == 422
    assert client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {"driver": 21}}).status_code == 422
    assert client.get("/api/sessions/999/skills").status_code == 404
    assert client.put("/api/sessions/999/skills", json={"attempts": None}).status_code == 404
    raw = TestClient(client.app)
    referee = bearer(login_as(raw, "referee"))
    assert raw.get(f"/api/sessions/{session_id}/skills", headers=referee).status_code == 200
    assert raw.put(f"/api/sessions/{session_id}/skills", json={"attempts": None}, headers=referee).status_code == 403


def test_session_override_broadcasts_on_both_channels(client):
    create_event(client)
    session_id = create_session(client)
    token = admin_token(client)
    with client.websocket_connect(f"/ws/session/{session_id}?token={token}") as session_socket, \
            client.websocket_connect(f"/ws/active-session?token={token}") as active_socket:
        assert client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {"driver": 2}}).status_code == 200
        assert next_event(session_socket, "skills_settings_changed")["data"] == {"session_id": session_id}
        assert next_event(active_socket, "skills_settings_changed")["data"] == {"session_id": session_id}


def test_scoresheet_schema_per_type(client):
    create_event(client)
    autonomous = client.get("/api/skills/types/autonomous/schema")
    assert autonomous.status_code == 200
    assert [f["name"] for f in autonomous.json()] == ["objects_scored", "parked"]
    assert [f["name"] for f in client.get("/api/skills/types/driver/schema").json()] == ["objects_scored"]
    assert client.get("/api/skills/types/teleop/schema").status_code == 404
```

- [ ] **Step 3: Run to verify failure.** `.venv/bin/pytest tests/test_skills_settings.py -q`. Expected: 404s from the missing routes.

- [ ] **Step 4: Implement the service.** Create `services/skills.py`:

```python
"""Skills challenges against the database: settings, the plugin's types and
each session's allowed attempts. The pure rules live in skills_rules.py and
the ranking in skills_ranking.py."""
from __future__ import annotations

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.event import Event
from tournament_server.models.session import TournamentSession
from tournament_server.models.skills import SkillsSettings
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.services.skills_rules import effective_allowed

SKILLS_OFF_DETAIL = "Skills challenges are turned off for this event."
NO_PLUGIN_DETAIL = "Choose a game plugin before setting up skills challenges."
NO_TYPES_DETAIL = "This game has no skills challenges."
ADMIN_ONLY_DETAIL = "Only an admin can change a submitted skills attempt."


def event_plugin(request: Request, event: Event) -> LoadedPlugin | None:
    if event.game_plugin_name is None:
        return None
    return request.app.state.game_plugins.get(event.game_plugin_name)


def plugin_types(plugin: LoadedPlugin | None) -> list[dict[str, str]]:
    """The game's skills types in priority order; [] without a plugin."""
    if plugin is None:
        return []
    return [{"key": item["key"], "label": item["label"]} for item in plugin.module.skills_types()]


def find_settings(db: Session, event_id: int) -> SkillsSettings | None:
    return db.execute(
        select(SkillsSettings).where(SkillsSettings.event_id == event_id)
    ).scalars().first()


def is_enabled(db: Session, event_id: int) -> bool:
    settings = find_settings(db, event_id)
    return settings is not None and settings.enabled


def event_attempts(db: Session, event_id: int) -> dict[str, int]:
    settings = find_settings(db, event_id)
    return dict(settings.attempts) if settings is not None else {}


def session_allowed(db: Session, session_obj: TournamentSession, type_keys: list[str]) -> dict[str, int]:
    return effective_allowed(type_keys, event_attempts(db, session_obj.event_id), session_obj.skills_attempts)
```

- [ ] **Step 5: Implement the schemas.** Create `schemas/skills.py`:

```python
from __future__ import annotations

import datetime as dt
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt


class SkillsTypeRead(BaseModel):
    key: str
    label: str


class SkillsSettingsRead(BaseModel):
    enabled: bool
    # Every plugin type, with 3 filled in where unset.
    attempts: dict[str, int]
    types: list[SkillsTypeRead]


class SkillsSettingsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: StrictBool
    attempts: dict[str, StrictInt] = Field(default_factory=dict)


class SessionSkillsTypeRead(SkillsTypeRead):
    allowed: int


class SessionSkillsRead(BaseModel):
    types: list[SessionSkillsTypeRead]
    override: dict[str, int] | None


class SessionSkillsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # null (or {}) clears the override.
    attempts: dict[str, StrictInt] | None


class SkillsAttemptCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    team_id: StrictInt
    skills_type: str
    data: dict[str, Any]


class SkillsAttemptUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    data: dict[str, Any]


class SkillsAttemptRead(BaseModel):
    id: int
    team_id: int
    skills_type: str
    # 1, 2, 3, ... per team and type in this session, by (recorded_at, id).
    number: int
    score: int
    data: dict[str, Any]
    recorded_at: dt.datetime
    updated_at: dt.datetime


class SkillsRankingRowRead(BaseModel):
    rank: int
    team_id: int
    score: int
    # Best first; for Overall, each type's list in plugin order.
    attempts: list[int]
    session_id: int
```

The attempt and ranking schemas are used by Tasks 5 and 6. They live here so one module holds the whole wire contract.

- [ ] **Step 6: Implement the router.** Create `routers/skills.py`:

```python
"""Skills challenges: settings, session overrides, scoresheets, attempts and rankings."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.deps import get_db, get_the_event
from tournament_server.models.event import Event
from tournament_server.models.session import TournamentSession
from tournament_server.models.skills import SkillsSettings
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.realtime import broadcast_active_session, broadcast_session
from tournament_server.schemas.skills import (
    SessionSkillsBody,
    SessionSkillsRead,
    SkillsSettingsBody,
    SkillsSettingsRead,
)
from tournament_server.services import skills
from tournament_server.services.skills_rules import DEFAULT_ATTEMPTS, attempts_error

router = APIRouter(tags=["skills"])


def _event_or_404(db: Session) -> Event:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    return event


def _session_or_404(db: Session, session_id: int) -> TournamentSession:
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session_obj


def _settings_read(db: Session, event: Event, plugin: LoadedPlugin | None) -> SkillsSettingsRead:
    types = skills.plugin_types(plugin)
    stored = skills.event_attempts(db, event.id)
    return SkillsSettingsRead(
        enabled=skills.is_enabled(db, event.id),
        attempts={t["key"]: stored.get(t["key"], DEFAULT_ATTEMPTS) for t in types},
        types=types,
    )


def _session_read(db: Session, request: Request, session_obj: TournamentSession) -> SessionSkillsRead:
    types = skills.plugin_types(skills.event_plugin(request, _event_or_404(db)))
    allowed = skills.session_allowed(db, session_obj, [t["key"] for t in types])
    return SessionSkillsRead(
        types=[{**t, "allowed": allowed[t["key"]]} for t in types],
        override=session_obj.skills_attempts,
    )


@router.get("/api/skills/settings", response_model=SkillsSettingsRead)
def get_skills_settings(
    request: Request, db: Session = Depends(get_db), _role: str = Depends(require_any_role)
) -> SkillsSettingsRead:
    event = _event_or_404(db)
    return _settings_read(db, event, skills.event_plugin(request, event))


@router.put("/api/skills/settings", response_model=SkillsSettingsRead)
def put_skills_settings(
    payload: SkillsSettingsBody,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> SkillsSettingsRead:
    event = _event_or_404(db)
    plugin = skills.event_plugin(request, event)
    if plugin is None:
        raise HTTPException(status_code=409, detail=skills.NO_PLUGIN_DETAIL)
    types = skills.plugin_types(plugin)
    error = attempts_error(payload.attempts, [t["key"] for t in types])
    if error is not None:
        raise HTTPException(status_code=422, detail=error)
    if payload.enabled and not types:
        raise HTTPException(status_code=409, detail=skills.NO_TYPES_DETAIL)
    settings = skills.find_settings(db, event.id)
    if settings is None:
        settings = SkillsSettings(event_id=event.id)
        db.add(settings)
    settings.enabled = payload.enabled
    settings.attempts = dict(payload.attempts)
    db.commit()
    broadcast_active_session(request.app, "skills_settings_changed", {"session_id": None})
    return _settings_read(db, event, plugin)


@router.get("/api/sessions/{session_id}/skills", response_model=SessionSkillsRead)
def get_session_skills(
    session_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> SessionSkillsRead:
    return _session_read(db, request, _session_or_404(db, session_id))


@router.put("/api/sessions/{session_id}/skills", response_model=SessionSkillsRead)
def put_session_skills(
    session_id: int,
    payload: SessionSkillsBody,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> SessionSkillsRead:
    session_obj = _session_or_404(db, session_id)
    if payload.attempts:
        types = skills.plugin_types(skills.event_plugin(request, _event_or_404(db)))
        error = attempts_error(payload.attempts, [t["key"] for t in types])
        if error is not None:
            raise HTTPException(status_code=422, detail=error)
    session_obj.skills_attempts = dict(payload.attempts) if payload.attempts else None
    db.commit()
    data = {"session_id": session_id}
    broadcast_session(request.app, session_id, "skills_settings_changed", data)
    broadcast_active_session(request.app, "skills_settings_changed", data)
    return _session_read(db, request, session_obj)


@router.get("/api/skills/types/{key}/schema", response_model=list[dict[str, Any]])
def get_skills_schema(
    key: str,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> list[dict[str, Any]]:
    plugin = skills.event_plugin(request, _event_or_404(db))
    if key not in [t["key"] for t in skills.plugin_types(plugin)]:
        raise HTTPException(status_code=404, detail="Unknown skills type")
    return plugin.module.skills_scoresheet_schema(key)
```

Register it in `app.py`: add `skills` to the `from tournament_server.routers import (...)` list, and `app.include_router(skills.router)` right after `app.include_router(ranking_settings.router)`.

- [ ] **Step 7: Run to verify the tests pass.** `.venv/bin/pytest tests/test_skills_settings.py -q`. Expected: all pass.

- [ ] **Step 8: Document.** In `server/CLAUDE.md`:
- Add a new top-level section `## Skills challenges` just before `## Finals`, with this first paragraph:

> An event runs skills challenges when an admin turns them on (`PUT /api/skills/settings`, `{enabled, attempts}`). Turning them on needs a game plugin (409 "Choose a game plugin before setting up skills challenges.") with at least one skills type (409 "This game has no skills challenges."). `skills_settings` holds one row per event, created on the first save; until then reads return the defaults (off, 3 attempts per type). `attempts` maps a type key to the attempts each team gets per session (1–20; a missing type means 3). A session may override it (`PUT /api/sessions/{id}/skills`, `{"attempts": {...} | null}`, stored in `sessions.skills_attempts`, with `{}` stored as null). A type missing from the override falls back to the event setting (`services/skills_rules.effective_allowed`). `GET /api/skills/types/{key}/schema` returns one type's scoresheet fields.

- In the Event catalog, add: `skills_settings_changed` — `{session_id}`. It is `null` for an event settings change (active-session channel only). It is the session's id for an override change (that session's channel and the active-session channel).

- [ ] **Step 9: Commit.**

```bash
git add server/src/tournament_server/services/skills.py server/src/tournament_server/schemas/skills.py server/src/tournament_server/routers/skills.py server/src/tournament_server/app.py server/tests/skills_helpers.py server/tests/test_skills_settings.py server/CLAUDE.md
git commit -m "Turn skills challenges on and set attempts per event and per session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Recording, correcting and deleting attempts; admin-only teamwork corrections

**Files:**
- Modify: `server/src/tournament_server/services/skills.py` (add `attempt_numbers`)
- Modify: `server/src/tournament_server/routers/skills.py` (attempt routes)
- Modify: `server/src/tournament_server/routers/scores.py` (re-submission guard)
- Modify: `server/tests/skills_helpers.py` (add `record_attempt`)
- Modify: `server/tests/test_scores.py` (the scorer/referee test re-submitted to the same alliance)
- Test: `server/tests/test_skills_attempts.py`, plus new tests in `server/tests/test_scores.py`
- Docs: `server/CLAUDE.md`

**Interfaces:**
- Consumes:
  - Task 3's `scoresheet_violations`.
  - Task 4's router helpers, `services.skills` and the schemas `SkillsAttemptCreate`, `SkillsAttemptUpdate` and `SkillsAttemptRead`.
- Produces:
  - `GET /api/sessions/{id}/skills/attempts` → `list[SkillsAttemptRead]`, ordered by `(recorded_at, id)`.
  - `POST /api/sessions/{id}/skills/attempts` → 201 `SkillsAttemptRead`.
  - `PUT /api/skills/attempts/{id}` (admin) → `SkillsAttemptRead`.
  - `DELETE /api/skills/attempts/{id}` (admin) → 204.
  - A scoresheet 422 has the body `{"detail": "The scoresheet has errors.", "violations": [{"field", "message"}]}`.
  - WebSocket event `skills_changed` `{session_id}`, sent on the session channel and always on the active-session channel.
  - `services.skills.attempt_numbers(attempts: Iterable[SkillsAttempt]) -> dict[int, int]` (attempt id → number).
  - `routers.scores.SCORE_ALREADY_SUBMITTED_DETAIL = "This score has already been submitted; ask an admin to correct it."`
  - Test helper `record_attempt(client, session_id, team_id, skills_type="driver", objects=5, parked=False, headers=None)`.

- [ ] **Step 1: Add the test helper.** Append to `server/tests/skills_helpers.py`:

```python
def record_attempt(
    client,
    session_id: int,
    team_id: int,
    skills_type: str = "driver",
    objects: int = 5,
    parked: bool = False,
    headers: dict | None = None,
):
    """POSTs an example-game attempt: score = objects * 2 (+4 for a parked autonomous run)."""
    data: dict = {"objects_scored": objects}
    if skills_type == "autonomous":
        data["parked"] = parked
    return client.post(
        f"/api/sessions/{session_id}/skills/attempts",
        json={"team_id": team_id, "skills_type": skills_type, "data": data},
        headers=headers or {},
    )
```

- [ ] **Step 2: Write the failing attempt tests.** Create `server/tests/test_skills_attempts.py`:

```python
import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from skills_helpers import (
    admin_token,
    admitted_device_token,
    create_event,
    create_session,
    enable_skills,
    next_event,
    record_attempt,
)


@pytest.fixture()
def setup(client):
    """Teams 1 and 2 checked in to Saturday; team 3 not. Skills on, 3 attempts each."""
    t1, t2, t3 = create_event(client)
    enable_skills(client)
    session_id = create_session(client, checked_in=(t1, t2))
    return client, session_id, (t1, t2, t3)


def _attempts(client, session_id):
    response = client.get(f"/api/sessions/{session_id}/skills/attempts")
    assert response.status_code == 200, response.text
    return response.json()


def test_create_returns_the_scored_attempt(setup):
    client, s1, (t1, _, _) = setup
    response = record_attempt(client, s1, t1, "autonomous", objects=7, parked=True)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["team_id"] == t1
    assert body["skills_type"] == "autonomous"
    assert body["number"] == 1
    assert body["score"] == 18
    assert body["data"] == {"objects_scored": 7, "parked": True}
    assert body["recorded_at"] == body["updated_at"]


def test_numbers_count_per_team_and_type(setup):
    client, s1, (t1, t2, _) = setup
    record_attempt(client, s1, t1, "driver", objects=1)
    record_attempt(client, s1, t1, "autonomous", objects=2)
    record_attempt(client, s1, t1, "driver", objects=3)
    record_attempt(client, s1, t2, "driver", objects=4)
    listed = [(a["team_id"], a["skills_type"], a["number"], a["score"]) for a in _attempts(client, s1)]
    assert listed == [(t1, "driver", 1, 2), (t1, "autonomous", 1, 4), (t1, "driver", 2, 6), (t2, "driver", 1, 8)]


def test_numbers_move_up_after_a_delete(setup):
    client, s1, (t1, _, _) = setup
    first = record_attempt(client, s1, t1, objects=1).json()
    record_attempt(client, s1, t1, objects=2)
    record_attempt(client, s1, t1, objects=3)
    assert client.delete(f"/api/skills/attempts/{first['id']}").status_code == 204
    assert [(a["number"], a["score"]) for a in _attempts(client, s1)] == [(1, 4), (2, 6)]


def test_edit_rescores_and_keeps_its_place(setup):
    client, s1, (t1, _, _) = setup
    first = record_attempt(client, s1, t1, objects=1).json()
    record_attempt(client, s1, t1, objects=2)
    edited = client.put(f"/api/skills/attempts/{first['id']}", json={"data": {"objects_scored": 10}})
    assert edited.status_code == 200, edited.text
    body = edited.json()
    assert (body["number"], body["score"]) == (1, 20)
    assert body["recorded_at"] == first["recorded_at"]
    assert body["updated_at"] >= first["updated_at"]
    assert [(a["number"], a["score"]) for a in _attempts(client, s1)] == [(1, 20), (2, 4)]


def test_deleting_gives_the_attempt_back(setup):
    client, s1, (t1, _, _) = setup
    client.put(f"/api/sessions/{s1}/skills", json={"attempts": {"driver": 1}})
    first = record_attempt(client, s1, t1).json()
    refused = record_attempt(client, s1, t1)
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Team 1 has used all 1 Driver attempts."
    assert client.delete(f"/api/skills/attempts/{first['id']}").status_code == 204
    assert record_attempt(client, s1, t1).status_code == 201


def test_a_zero_score_still_uses_an_attempt(setup):
    client, s1, (t1, _, _) = setup
    client.put(f"/api/sessions/{s1}/skills", json={"attempts": {"driver": 1}})
    assert record_attempt(client, s1, t1, objects=0).json()["score"] == 0
    assert record_attempt(client, s1, t1).status_code == 409


def test_lowering_the_allowed_number_keeps_existing_attempts(setup):
    client, s1, (t1, _, _) = setup
    for objects in (1, 2, 3):
        assert record_attempt(client, s1, t1, objects=objects).status_code == 201
    client.put("/api/skills/settings", json={"enabled": True, "attempts": {"driver": 1}})
    assert len(_attempts(client, s1)) == 3
    refused = record_attempt(client, s1, t1)
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Team 1 has used all 1 Driver attempts."


def test_everything_is_refused_while_skills_are_off(setup):
    client, s1, (t1, _, _) = setup
    attempt = record_attempt(client, s1, t1).json()
    client.put("/api/skills/settings", json={"enabled": False, "attempts": {}})
    detail = "Skills challenges are turned off for this event."
    for response in (
        record_attempt(client, s1, t1),
        client.put(f"/api/skills/attempts/{attempt['id']}", json={"data": {"objects_scored": 1}}),
        client.delete(f"/api/skills/attempts/{attempt['id']}"),
    ):
        assert response.status_code == 409
        assert response.json()["detail"] == detail
    assert len(_attempts(client, s1)) == 1


def test_a_team_must_be_checked_in(setup):
    client, s1, (_, t2, t3) = setup
    refused = record_attempt(client, s1, t3)
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Team 3 is not checked in for this session."
    client.post(f"/api/sessions/{s1}/participants", json={"team_id": t2, "checked_in": False})
    assert record_attempt(client, s1, t2).json()["detail"] == "Team 2 is not checked in for this session."


def test_unknown_type_team_session_and_attempt(setup):
    client, s1, (t1, _, _) = setup
    unknown_type = client.post(
        f"/api/sessions/{s1}/skills/attempts", json={"team_id": t1, "skills_type": "teleop", "data": {}}
    )
    assert unknown_type.status_code == 422
    assert record_attempt(client, s1, 999).status_code == 422
    assert record_attempt(client, 999, t1).status_code == 404
    assert client.get("/api/sessions/999/skills/attempts").status_code == 404
    assert client.put("/api/skills/attempts/999", json={"data": {"objects_scored": 1}}).status_code == 404
    assert client.delete("/api/skills/attempts/999").status_code == 404


def test_scoresheet_violations_are_reported_per_field(setup):
    client, s1, (t1, _, _) = setup
    bad = {"team_id": t1, "skills_type": "driver", "data": {"objects_scored": 31, "extra": 1}}
    response = client.post(f"/api/sessions/{s1}/skills/attempts", json=bad)
    assert response.status_code == 422
    assert response.json() == {
        "detail": "The scoresheet has errors.",
        "violations": [
            {"field": "objects_scored", "message": "Must be at most 30."},
            {"field": "extra", "message": "Unknown field."},
        ],
    }
    assert _attempts(client, s1) == []
    attempt = record_attempt(client, s1, t1).json()
    edit = client.put(f"/api/skills/attempts/{attempt['id']}", json={"data": {"objects_scored": True}})
    assert edit.status_code == 422
    assert edit.json()["violations"] == [{"field": "objects_scored", "message": "Must be a whole number."}]


def test_plugin_error_while_scoring_stores_nothing(setup, monkeypatch):
    client, s1, (t1, _, _) = setup
    client.put(f"/api/sessions/{s1}/skills", json={"attempts": {"driver": 1}})
    module = client.app.state.game_plugins["example-game"].module

    def broken(skills_type, scoresheet):
        raise ValueError("boom")

    monkeypatch.setattr(module, "calculate_skills_score", broken)
    response = record_attempt(client, s1, t1)
    assert response.status_code == 422
    assert response.json()["detail"] == "Plugin could not score this scoresheet: boom"
    assert _attempts(client, s1) == []
    monkeypatch.undo()
    assert record_attempt(client, s1, t1).status_code == 201


def test_admin_edit_ignores_check_in_and_the_limit(setup):
    client, s1, (t1, _, _) = setup
    first = record_attempt(client, s1, t1, objects=1).json()
    record_attempt(client, s1, t1, objects=2)
    client.post(f"/api/sessions/{s1}/participants", json={"team_id": t1, "checked_in": False})
    client.put(f"/api/sessions/{s1}/skills", json={"attempts": {"driver": 1}})
    edited = client.put(f"/api/skills/attempts/{first['id']}", json={"data": {"objects_scored": 9}})
    assert edited.status_code == 200, edited.text
    assert (edited.json()["number"], edited.json()["score"]) == (1, 18)


def test_admins_edit_attempts_in_past_sessions(setup):
    client, s1, (t1, t2, _) = setup
    attempt = record_attempt(client, s1, t1).json()
    s2 = create_session(client, "Sunday", checked_in=(t1, t2))
    client.post("/api/event/active-session", json={"session_id": s2})
    assert client.put(f"/api/skills/attempts/{attempt['id']}", json={"data": {"objects_scored": 2}}).status_code == 200


def test_scorers_and_referees_record_on_an_admitted_device_only(setup):
    client, s1, (t1, t2, _) = setup
    device = admitted_device_token(client)
    raw = TestClient(client.app)
    for role, team_id in (("scorer", t1), ("referee", t2)):
        headers = {**bearer(login_as(raw, role)), "X-Device-Token": device}
        assert record_attempt(raw, s1, team_id, headers=headers).status_code == 201, role
    scorer = bearer(login_as(raw, "scorer"))
    assert record_attempt(raw, s1, t1, headers=scorer).status_code == 401
    assert record_attempt(raw, s1, t1, headers=bearer(login_as(raw, "attendee"))).status_code == 403


def test_scorers_and_referees_cannot_change_a_submitted_attempt(setup):
    client, s1, (t1, _, _) = setup
    attempt = record_attempt(client, s1, t1).json()
    device = admitted_device_token(client)
    raw = TestClient(client.app)
    detail = "Only an admin can change a submitted skills attempt."
    for role in ("scorer", "referee"):
        headers = {**bearer(login_as(raw, role)), "X-Device-Token": device}
        edit = raw.put(f"/api/skills/attempts/{attempt['id']}", json={"data": {"objects_scored": 1}}, headers=headers)
        delete = raw.delete(f"/api/skills/attempts/{attempt['id']}", headers=headers)
        assert (edit.status_code, edit.json()["detail"]) == (403, detail), role
        assert (delete.status_code, delete.json()["detail"]) == (403, detail), role
    attendee = bearer(login_as(raw, "attendee"))
    assert raw.get(f"/api/sessions/{s1}/skills/attempts", headers=attendee).status_code == 200


def test_changes_broadcast_skills_changed_on_both_channels(setup):
    client, s1, (t1, _, _) = setup
    token = admin_token(client)
    with client.websocket_connect(f"/ws/session/{s1}?token={token}") as session_socket, \
            client.websocket_connect(f"/ws/active-session?token={token}") as active_socket:
        attempt = record_attempt(client, s1, t1).json()
        assert next_event(session_socket, "skills_changed")["data"] == {"session_id": s1}
        assert next_event(active_socket, "skills_changed")["data"] == {"session_id": s1}
        client.put(f"/api/skills/attempts/{attempt['id']}", json={"data": {"objects_scored": 1}})
        assert next_event(active_socket, "skills_changed")["data"] == {"session_id": s1}
        client.delete(f"/api/skills/attempts/{attempt['id']}")
        assert next_event(session_socket, "skills_changed")["data"] == {"session_id": s1}
```

In `test_changes_broadcast_skills_changed_on_both_channels`, Saturday is not the active session. That shows `skills_changed` reaches the active-session channel regardless (spec 3.7).

- [ ] **Step 3: Write the failing teamwork-correction tests.** In `server/tests/test_scores.py`:

Replace `test_submit_score_succeeds_for_scorer_and_referee` with this version, so the referee submits the other alliance instead of re-submitting the scorer's:

```python
def test_submit_score_succeeds_for_scorer_and_referee(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)

    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")

    for role, alliance_id in (("scorer", red_id), ("referee", blue_id)):
        token = login_as(raw, role)
        response = raw.post(
            f"/api/matches/{match_id}/alliances/{alliance_id}/score",
            json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
            headers={**bearer(token), "X-Device-Token": device["device_token"]},
        )
        assert response.status_code == 200, f"{role} should be able to submit a score"
```

Append:

```python
def test_only_an_admin_can_correct_a_submitted_score(client):
    match_id, red_id, _ = _setup_match(client)
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")
    path = f"/api/matches/{match_id}/alliances/{red_id}/score"
    first = {"data": {"high_balls": 1, "low_balls": 0, "auto_winner": "tie"}}
    second = {"data": {"high_balls": 5, "low_balls": 2, "auto_winner": "tie"}}

    scorer = {**bearer(login_as(raw, "scorer")), "X-Device-Token": device["device_token"]}
    assert raw.post(path, json=first, headers=scorer).status_code == 200
    for role in ("scorer", "referee"):
        headers = {**bearer(login_as(raw, role)), "X-Device-Token": device["device_token"]}
        refused = raw.post(path, json=second, headers=headers)
        assert refused.status_code == 409, role
        assert refused.json()["detail"] == "This score has already been submitted; ask an admin to correct it."

    corrected = client.post(path, json=second)
    assert corrected.status_code == 200
    assert corrected.json()["computed_score"] == 17
```

- [ ] **Step 4: Run to verify failure.** `.venv/bin/pytest tests/test_skills_attempts.py tests/test_scores.py -q`. Expected: the attempt tests fail with 404/405 (no routes). `test_only_an_admin_can_correct_a_submitted_score` fails because the scorer's re-submission returns 200.

- [ ] **Step 5: Add attempt numbering.** Append to `services/skills.py` (add `from collections import Counter` and `from typing import Iterable` at the top, and `SkillsAttempt` to the `models.skills` import):

```python
def attempt_numbers(attempts: Iterable[SkillsAttempt]) -> dict[int, int]:
    """attempt id -> its number: 1, 2, 3, ... per team and type, by (recorded_at, id)."""
    seen: Counter[tuple[int, str]] = Counter()
    numbers: dict[int, int] = {}
    for attempt in sorted(attempts, key=lambda a: (a.recorded_at, a.id)):
        seen[(attempt.team_id, attempt.skills_type)] += 1
        numbers[attempt.id] = seen[(attempt.team_id, attempt.skills_type)]
    return numbers
```

- [ ] **Step 6: Implement the attempt routes.** In `routers/skills.py`:

Extend the imports to:

```python
import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.db import utc_now
from tournament_server.deps import get_db, get_the_event
from tournament_server.device_auth import require_admitted_device
from tournament_server.models.event import Event
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.session import TournamentSession
from tournament_server.models.skills import SkillsAttempt, SkillsSettings
from tournament_server.models.team import Team
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.realtime import broadcast_active_session, broadcast_session
from tournament_server.schemas.skills import (
    SessionSkillsBody,
    SessionSkillsRead,
    SkillsAttemptCreate,
    SkillsAttemptRead,
    SkillsAttemptUpdate,
    SkillsSettingsBody,
    SkillsSettingsRead,
)
from tournament_server.services import skills
from tournament_server.services.skills_rules import DEFAULT_ATTEMPTS, attempts_error, scoresheet_violations
```

Append the routes:

```python
def _require_admin_to_change(role: str = Depends(require_any_role)) -> str:
    if role != "admin":
        raise HTTPException(status_code=403, detail=skills.ADMIN_ONLY_DETAIL)
    return role


def _enabled_plugin_or_409(db: Session, request: Request, event: Event) -> LoadedPlugin:
    plugin = skills.event_plugin(request, event)
    if plugin is None or not skills.is_enabled(db, event.id):
        raise HTTPException(status_code=409, detail=skills.SKILLS_OFF_DETAIL)
    return plugin


def _violations_response(violations: list[dict[str, str]]) -> JSONResponse:
    return JSONResponse(
        status_code=422, content={"detail": "The scoresheet has errors.", "violations": violations}
    )


def _score(plugin: LoadedPlugin, skills_type: str, data: dict[str, Any]) -> int:
    try:
        return int(plugin.module.calculate_skills_score(skills_type, data))
    except Exception as exc:  # noqa: BLE001 - a plugin bug becomes a readable 422, not a 500
        raise HTTPException(status_code=422, detail=f"Plugin could not score this scoresheet: {exc}")


def _session_attempts(db: Session, session_id: int) -> list[SkillsAttempt]:
    return list(
        db.execute(
            select(SkillsAttempt)
            .where(SkillsAttempt.session_id == session_id)
            .order_by(SkillsAttempt.recorded_at, SkillsAttempt.id)
        ).scalars().all()
    )


def _attempt_read(attempt: SkillsAttempt, number: int) -> SkillsAttemptRead:
    return SkillsAttemptRead(
        id=attempt.id,
        team_id=attempt.team_id,
        skills_type=attempt.skills_type,
        number=number,
        score=attempt.score,
        data=json.loads(attempt.data_json),
        recorded_at=attempt.recorded_at,
        updated_at=attempt.updated_at,
    )


def _numbered_read(db: Session, attempt: SkillsAttempt) -> SkillsAttemptRead:
    return _attempt_read(attempt, skills.attempt_numbers(_session_attempts(db, attempt.session_id))[attempt.id])


def _broadcast_skills_changed(request: Request, session_id: int) -> None:
    # The active-session channel always gets it: Season Rankings listens there.
    data = {"session_id": session_id}
    broadcast_session(request.app, session_id, "skills_changed", data)
    broadcast_active_session(request.app, "skills_changed", data)


@router.get("/api/sessions/{session_id}/skills/attempts", response_model=list[SkillsAttemptRead])
def list_skills_attempts(
    session_id: int, db: Session = Depends(get_db), _role: str = Depends(require_any_role)
) -> list[SkillsAttemptRead]:
    _session_or_404(db, session_id)
    attempts = _session_attempts(db, session_id)
    numbers = skills.attempt_numbers(attempts)
    return [_attempt_read(attempt, numbers[attempt.id]) for attempt in attempts]


@router.post("/api/sessions/{session_id}/skills/attempts", response_model=SkillsAttemptRead, status_code=201)
def create_skills_attempt(
    session_id: int,
    payload: SkillsAttemptCreate,
    request: Request,
    db: Session = Depends(get_db),
    _device: str | None = Depends(require_admitted_device),
) -> Any:
    session_obj = _session_or_404(db, session_id)
    event = _event_or_404(db)
    plugin = _enabled_plugin_or_409(db, request, event)
    types = {t["key"]: t for t in skills.plugin_types(plugin)}
    if payload.skills_type not in types:
        raise HTTPException(status_code=422, detail=f"Unknown skills type: {payload.skills_type!r}")
    team = db.get(Team, payload.team_id)
    if team is None or team.event_id != event.id:
        raise HTTPException(status_code=422, detail="Unknown team")
    checked_in = db.execute(
        select(SessionParticipation.id).where(
            SessionParticipation.session_id == session_id,
            SessionParticipation.team_id == team.id,
            SessionParticipation.checked_in.is_(True),
        )
    ).first()
    if checked_in is None:
        raise HTTPException(status_code=409, detail=f"Team {team.number} is not checked in for this session.")
    allowed = skills.session_allowed(db, session_obj, list(types))[payload.skills_type]
    used = db.execute(
        select(func.count(SkillsAttempt.id)).where(
            SkillsAttempt.session_id == session_id,
            SkillsAttempt.team_id == team.id,
            SkillsAttempt.skills_type == payload.skills_type,
        )
    ).scalar_one()
    if used >= allowed:
        label = types[payload.skills_type]["label"]
        raise HTTPException(
            status_code=409, detail=f"Team {team.number} has used all {allowed} {label} attempts."
        )
    violations = scoresheet_violations(plugin.module.skills_scoresheet_schema(payload.skills_type), payload.data)
    if violations:
        return _violations_response(violations)
    score = _score(plugin, payload.skills_type, payload.data)
    now = utc_now()
    attempt = SkillsAttempt(
        session_id=session_id,
        team_id=team.id,
        skills_type=payload.skills_type,
        data_json=json.dumps(payload.data),
        score=score,
        plugin_name=plugin.name,
        plugin_version=plugin.version,
        recorded_at=now,
        updated_at=now,
    )
    db.add(attempt)
    db.commit()
    db.refresh(attempt)
    _broadcast_skills_changed(request, session_id)
    return _numbered_read(db, attempt)


def _attempt_or_404(db: Session, attempt_id: int) -> SkillsAttempt:
    attempt = db.get(SkillsAttempt, attempt_id)
    if attempt is None:
        raise HTTPException(status_code=404, detail="Skills attempt not found")
    return attempt


@router.put("/api/skills/attempts/{attempt_id}", response_model=SkillsAttemptRead)
def update_skills_attempt(
    attempt_id: int,
    payload: SkillsAttemptUpdate,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(_require_admin_to_change),
) -> Any:
    attempt = _attempt_or_404(db, attempt_id)
    plugin = _enabled_plugin_or_409(db, request, _event_or_404(db))
    violations = scoresheet_violations(plugin.module.skills_scoresheet_schema(attempt.skills_type), payload.data)
    if violations:
        return _violations_response(violations)
    attempt.score = _score(plugin, attempt.skills_type, payload.data)
    attempt.data_json = json.dumps(payload.data)
    attempt.plugin_name = plugin.name
    attempt.plugin_version = plugin.version
    attempt.updated_at = utc_now()
    db.commit()
    db.refresh(attempt)
    _broadcast_skills_changed(request, attempt.session_id)
    return _numbered_read(db, attempt)


@router.delete("/api/skills/attempts/{attempt_id}", status_code=204)
def delete_skills_attempt(
    attempt_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(_require_admin_to_change),
) -> Response:
    attempt = _attempt_or_404(db, attempt_id)
    _enabled_plugin_or_409(db, request, _event_or_404(db))
    session_id = attempt.session_id
    db.delete(attempt)
    db.commit()
    _broadcast_skills_changed(request, session_id)
    return Response(status_code=204)
```

`require_admitted_device` already depends on `require_scorer_or_referee`, so an attendee gets 403, a scorer without a device 401, and an admin passes without a device. The routes return `Any` because a scoresheet failure returns a `JSONResponse`. FastAPI passes a returned `Response` straight through, and `response_model` covers the normal case.

- [ ] **Step 7: Refuse non-admin re-submissions.** In `routers/scores.py`:
- Add at module level, after `router = ...`:

```python
SCORE_ALREADY_SUBMITTED_DETAIL = "This score has already been submitted; ask an admin to correct it."
```

- Rename the parameter `_role: str = Depends(require_scorer_or_referee)` to `role: str = Depends(require_scorer_or_referee)`.
- Immediately after the `NOT_PLAYED` check, add:

```python
    existing = db.execute(
        select(ScoreRecord).where(ScoreRecord.alliance_id == alliance_id)
    ).scalars().first()
    # Once submitted, only an admin may correct it (skills spec 3.6). Drafts,
    # which scorers may overwrite, belong to the later live-scoring spec.
    if existing is not None and role != "admin":
        raise HTTPException(status_code=409, detail=SCORE_ALREADY_SUBMITTED_DETAIL)
```

- Delete the later duplicate `existing = db.execute(...).scalars().first()` that sits after `now = utc_now()`, so the `if existing is None:` branch uses the record loaded above.

- [ ] **Step 8: Run the new tests.** `.venv/bin/pytest tests/test_skills_attempts.py tests/test_scores.py -q`. Expected: all pass.

- [ ] **Step 9: Find and fix every other non-admin re-submission.**
  - Run `grep -rn "login_as(raw, \"scorer\")\|login_as(raw, \"referee\")\|login_as(raw_client" server/tests | grep -v test_skills`. Then run `.venv/bin/pytest -q`.
  - At planning time, the only test that re-submitted as a non-admin was the scorer/referee loop fixed in Step 3. Every other test that scores a match twice does so as the auto-authenticated admin `client`, which may still overwrite.
  - Every E2E spec (`frontend/apps/admin/tests/e2e/*.spec.ts`) submits scores with an admin token, so no E2E helper needs changing.
  - If the full run shows any other 409 "This score has already been submitted", change that test to make the correction through the admin `client`. Never loosen the guard.

- [ ] **Step 10: Document.** In `server/CLAUDE.md`:
- Under "Match & scoring", after the first paragraph, add:

> Once an alliance has a `ScoreRecord`, only an admin may change it. A scorer or referee re-submitting gets 409 "This score has already been submitted; ask an admin to correct it." Their first submission (on an admitted device) is unchanged, and admin submissions still create or overwrite, including after qualification is finalized. Draft scores that scorers may overwrite belong to the later live-scoring spec.

- Under "Skills challenges", add:

> Attempts are recorded with `POST /api/sessions/{id}/skills/attempts` (`{team_id, skills_type, data}`). Scorers and referees use it on an admitted device, and an admin needs no device. It refuses:
> - 409 while skills are off;
> - 409 for a team not checked in for the session;
> - 409 once the team has used the effective allowed number for that type (lowering the number keeps existing attempts);
> - 422 for an unknown type or team, or for scoresheet violations.
>
> `data` is validated against the type's schema before any plugin code runs (`skills_rules.scoresheet_violations`). A 422 lists `violations: [{field, message}]`. Attempt numbers are not stored. They are derived per team and type from `(recorded_at, id)`, so a delete moves later attempts up. Only an admin may `PUT` (re-score in place) or `DELETE` (give the attempt back) `/api/skills/attempts/{id}`. Other roles get 403 "Only an admin can change a submitted skills attempt." Deleting a session deletes its attempts.

- In the Event catalog, add: `skills_changed` — `{session_id}`. It is sent after an attempt is created, edited or deleted. It goes to that session's channel and always to the active-session channel (via `broadcast_session` plus `broadcast_active_session`, not `broadcast_for_session`), because Season Rankings listens there.

- [ ] **Step 11: Commit.**

```bash
git add server/src/tournament_server/services/skills.py server/src/tournament_server/routers/skills.py server/src/tournament_server/routers/scores.py server/tests/skills_helpers.py server/tests/test_skills_attempts.py server/tests/test_scores.py server/CLAUDE.md
git commit -m "Record skills attempts and make submitted scores admin-only to correct

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Skills rankings endpoint

**Files:**
- Modify: `server/src/tournament_server/routers/skills.py`
- Test: `server/tests/test_skills_rankings_api.py`
- Docs: `server/CLAUDE.md`

**Interfaces:**
- Consumes:
  - Task 3's `OVERALL`, `AttemptScore`, `rank_skills`, `session_order_key` and `skills_depth`.
  - Task 4's `session_allowed` and `SkillsRankingRowRead`.
  - Task 5's `record_attempt` helper.
- Produces: `GET /api/skills/rankings?tab={overall|<type key>}&session_id={id}` or `&season=true` → `list[SkillsRankingRowRead]`. Rows are in rank order. Within a shared rank they are ordered by team number.

- [ ] **Step 1: Write the failing tests.** Create `server/tests/test_skills_rankings_api.py`:

```python
import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from skills_helpers import create_event, create_session, enable_skills, record_attempt


@pytest.fixture()
def ranked(client):
    """Example-game scores are objects * 2.

    Sunday (created first, so it has the lower id, but dated later):
      team 1: autonomous 24, driver 28 (52); team 3: driver 20
    Saturday:
      team 1: autonomous 34, driver 20 (54); team 2: autonomous 24, driver 28 (52); team 3: driver 20
    """
    t1, t2, t3 = create_event(client)
    enable_skills(client)
    sunday = create_session(client, "Sunday", checked_in=(t1, t3), session_date="2026-10-11")
    saturday = create_session(client, "Saturday", checked_in=(t1, t2, t3), session_date="2026-10-10")
    for session_id, team_id, skills_type, objects in (
        (saturday, t1, "autonomous", 17), (saturday, t1, "driver", 10),
        (saturday, t2, "autonomous", 12), (saturday, t2, "driver", 14),
        (saturday, t3, "driver", 10),
        (sunday, t1, "autonomous", 12), (sunday, t1, "driver", 14),
        (sunday, t3, "driver", 10),
    ):
        assert record_attempt(client, session_id, team_id, skills_type, objects=objects).status_code == 201
    return client, saturday, sunday, (t1, t2, t3)


def _rankings(client, **params):
    response = client.get("/api/skills/rankings", params=params)
    assert response.status_code == 200, response.text
    return [(r["rank"], r["team_id"], r["score"], r["attempts"], r["session_id"]) for r in response.json()]


def test_session_overall(ranked):
    client, saturday, _, (t1, t2, t3) = ranked
    assert _rankings(client, tab="overall", session_id=saturday) == [
        (1, t1, 54, [34, 20], saturday),
        (2, t2, 52, [24, 28], saturday),
        (3, t3, 20, [20], saturday),
    ]


def test_session_type_tabs_share_ranks_and_skip(ranked):
    client, saturday, _, (t1, t2, t3) = ranked
    assert _rankings(client, tab="driver", session_id=saturday) == [
        (1, t2, 28, [28], saturday),
        (2, t1, 20, [20], saturday),
        (2, t3, 20, [20], saturday),
    ]
    assert _rankings(client, tab="autonomous", session_id=saturday) == [
        (1, t1, 34, [34], saturday),
        (2, t2, 24, [24], saturday),
    ]


def test_season_overall_uses_the_best_session_not_a_mix(ranked):
    client, saturday, _, (t1, t2, t3) = ranked
    rows = _rankings(client, tab="overall", season="true")
    assert rows[0] == (1, t1, 54, [34, 20], saturday)  # a mix would be 34 + 28 = 62
    assert rows[1] == (2, t2, 52, [24, 28], saturday)


def test_season_type_tab_names_the_session_with_the_best_attempt(ranked):
    client, saturday, sunday, (t1, t2, t3) = ranked
    rows = {row[1]: row for row in _rankings(client, tab="driver", season="true")}
    assert rows[t1] == (1, t1, 28, [28], sunday)
    assert rows[t2] == (1, t2, 28, [28], saturday)
    autonomous = _rankings(client, tab="autonomous", season="true")
    assert autonomous == [(1, t1, 34, [34], saturday), (2, t2, 24, [24], saturday)]


def test_equal_season_keys_name_the_earlier_dated_session(ranked):
    client, saturday, sunday, (_, _, t3) = ranked
    rows = {row[1]: row for row in _rankings(client, tab="overall", season="true")}
    assert rows[t3][4] == saturday  # Sunday has the lower id but the later date


def test_the_session_allowed_number_sets_the_overall_depth(client):
    t1, t2, _ = create_event(client)
    enable_skills(client)
    session_id = create_session(client, checked_in=(t1, t2))
    # Driver: team 1 [20, 10, 6], team 2 [20, 10, 4]; only the third-best differs.
    for team_id, runs in ((t1, (10, 5, 3)), (t2, (10, 5, 2))):
        for objects in runs:
            assert record_attempt(client, session_id, team_id, "driver", objects=objects).status_code == 201
    ranks = lambda: [(row[0], row[1]) for row in _rankings(client, tab="overall", session_id=session_id)]  # noqa: E731
    assert ranks() == [(1, t1), (2, t2)]
    # Two allowed per type: Overall compares only as deep as the second-best, so they tie.
    client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {"autonomous": 2, "driver": 2}})
    assert ranks() == [(1, t1), (1, t2)]


def test_bad_requests(ranked):
    client, saturday, _, _ = ranked
    assert client.get("/api/skills/rankings", params={"tab": "overall"}).status_code == 422
    both = {"tab": "overall", "session_id": saturday, "season": "true"}
    assert client.get("/api/skills/rankings", params=both).status_code == 422
    assert client.get("/api/skills/rankings", params={"tab": "teleop", "session_id": saturday}).status_code == 404
    assert client.get("/api/skills/rankings", params={"tab": "overall", "session_id": 999}).status_code == 404


def test_rankings_before_a_plugin_is_chosen(client):
    client.post("/api/event", json={"name": "League"})
    assert _rankings(client, tab="overall", season="true") == []
    assert client.get("/api/skills/rankings", params={"tab": "driver", "season": "true"}).status_code == 404


def test_any_role_can_read_rankings(ranked):
    client, saturday, _, _ = ranked
    raw = TestClient(client.app)
    attendee = bearer(login_as(raw, "attendee"))
    params = {"tab": "overall", "session_id": saturday}
    assert raw.get("/api/skills/rankings", params=params, headers=attendee).status_code == 200
```

- [ ] **Step 2: Run to verify failure.** `.venv/bin/pytest tests/test_skills_rankings_api.py -q`. Expected: 404 (route missing).

- [ ] **Step 3: Implement the route.** In `routers/skills.py`:
- Add `Query` to the `fastapi` import.
- Add the imports `from tournament_server.schemas.skills import SkillsRankingRowRead`, `from tournament_server.services.skills_ranking import OVERALL, AttemptScore, rank_skills, session_order_key` and `from tournament_server.services.skills_rules import skills_depth`.
- Append:

```python
@router.get("/api/skills/rankings", response_model=list[SkillsRankingRowRead])
def get_skills_rankings(
    request: Request,
    tab: str = Query(...),
    session_id: int | None = Query(None),
    season: bool = Query(False),
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> list[SkillsRankingRowRead]:
    if (session_id is not None) == season:
        raise HTTPException(status_code=422, detail="Give exactly one of session_id or season=true")
    event = _event_or_404(db)
    type_keys = [t["key"] for t in skills.plugin_types(skills.event_plugin(request, event))]
    if tab != OVERALL and tab not in type_keys:
        raise HTTPException(status_code=404, detail="Unknown rankings tab")
    if season:
        sessions = list(
            db.execute(select(TournamentSession).where(TournamentSession.event_id == event.id)).scalars().all()
        )
    else:
        sessions = [_session_or_404(db, session_id)]
    allowed = {s.id: skills.session_allowed(db, s, type_keys) for s in sessions}
    attempts = db.execute(
        select(SkillsAttempt).where(SkillsAttempt.session_id.in_(list(allowed)))
    ).scalars().all()
    team_numbers = {
        team.id: team.number
        for team in db.execute(select(Team).where(Team.event_id == event.id)).scalars().all()
    }
    rows = rank_skills(
        [AttemptScore(a.session_id, a.team_id, a.skills_type, a.score) for a in attempts],
        type_keys,
        tab,
        skills_depth(allowed.values()),
        {s.id: session_order_key(s.session_date, s.id) for s in sessions},
        team_numbers,
    )
    return [
        SkillsRankingRowRead(
            rank=row.rank, team_id=row.team_id, score=row.score, attempts=row.attempts, session_id=row.session_id
        )
        for row in rows
    ]
```

- [ ] **Step 4: Run to verify the tests pass.** `.venv/bin/pytest tests/test_skills_rankings_api.py tests/test_skills_ranking.py -q`. Expected: all pass. Then run the whole suite: `.venv/bin/pytest -q`. Expected: all pass.

- [ ] **Step 5: Document.** Under `server/CLAUDE.md` "Skills challenges", add:

> Skills rankings are never stored. `GET /api/skills/rankings?tab={overall|<type>}` with exactly one of `session_id` or `season=true` computes them on each request through the pure `services/skills_ranking.rank_skills`, which Awards can reuse.
> - **A type tab** ranks each team's attempts of that type, best first, compared entry by entry. A missing entry ranks below 0.
> - **Overall** is the sum of each type's best, tie-broken by each type's best in plugin order, then by the sums of second-best, third-best, ... as deep as the most attempts any type allows.
> - **The season** uses each team's single best session (the greatest key, and the earlier session by date then id when two are equal), never a mix.
> - Equal keys share a rank (1, 2, 2, 4), ordered by team number.

- [ ] **Step 6: Commit.**

```bash
git add server/src/tournament_server/routers/skills.py server/tests/test_skills_rankings_api.py server/CLAUDE.md
git commit -m "Serve session and season skills rankings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: Shared scoresheet components and error bodies on `ApiError`

**Files:**
- Create: `frontend/packages/shared/src/scoresheet/types.ts`
- Create: `frontend/packages/shared/src/scoresheet/ScoresheetForm.tsx`
- Create: `frontend/packages/shared/src/scoresheet/index.ts`
- Modify: `frontend/packages/shared/src/index.ts`, `frontend/packages/shared/src/api-client.ts`
- Test: `frontend/packages/shared/tests/scoresheet.test.tsx`, `frontend/packages/shared/tests/api-client.test.ts`

**Interfaces:**
- Produces (exported from `@tournament-admin/shared`):
  - Types `ScoresheetField`, `ScoresheetValue`, `ScoresheetValues`, `ScoresheetWidget` and `ScoresheetTranslate = (key: string, options?: Record<string, unknown>) => string`.
  - `defaultValues(fields: ScoresheetField[]): ScoresheetValues`
  - `clampCounter(field: ScoresheetField, value: number): number`
  - `ScoresheetForm({ fields, values, onChange, errors?, t, idPrefix })`:
    - `errors` maps a field name to a message, shown beside that field.
    - `t` is the caller's translate function. The form's own strings use the keys `scoresheet.decrease` and `scoresheet.increase`, each with a `{{label}}`.
    - Each input's id is `${idPrefix}-${field.name}`.
  - `ApiError.body: unknown`: the parsed JSON error body, or `null`. The constructor is `new ApiError(status, detail, body = null)`, so existing two-argument calls are unchanged.

- [ ] **Step 1: Write the failing tests.** Create `frontend/packages/shared/tests/scoresheet.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  ScoresheetForm,
  clampCounter,
  defaultValues,
  type ScoresheetField,
  type ScoresheetTranslate,
  type ScoresheetValues,
} from "../src/scoresheet";

const t: ScoresheetTranslate = (key, options) => {
  const label = String(options?.label ?? "");
  if (key === "scoresheet.decrease") return `Decrease ${label}`;
  if (key === "scoresheet.increase") return `Increase ${label}`;
  return key;
};

function field(overrides: Partial<ScoresheetField>): ScoresheetField {
  return {
    name: "balls",
    label: "Balls",
    data_type: "integer",
    widget: "counter",
    min: 0,
    max: 10,
    step: 2,
    options: null,
    icon: null,
    scope: "team",
    default: 0,
    ...overrides,
  };
}

const BALLS = field({});
const PARKED = field({
  name: "parked", label: "Parked", data_type: "boolean", widget: "toggle", min: null, max: null, step: null, default: false,
});
const ZONE = field({
  name: "zone", label: "Zone", data_type: "enum", widget: "select", min: null, max: null, step: null,
  options: ["near", "far"], default: "near",
});
const LEVEL = field({
  name: "level", label: "Level", data_type: "enum", widget: "radio", min: null, max: null, step: null,
  options: [1, 2, 3], default: 1, icon: "▲",
});
const FIELDS = [BALLS, PARKED, ZONE, LEVEL];

let latest: ScoresheetValues = {};

function Harness({ initial, errors }: { initial?: ScoresheetValues; errors?: Record<string, string> }) {
  const [values, setValues] = useState<ScoresheetValues>(initial ?? defaultValues(FIELDS));
  return (
    <ScoresheetForm
      fields={FIELDS}
      values={values}
      errors={errors}
      t={t}
      idPrefix="sheet"
      onChange={(next) => {
        latest = next;
        setValues(next);
      }}
    />
  );
}

describe("scoresheet helpers", () => {
  it("builds the default values", () => {
    expect(defaultValues(FIELDS)).toEqual({ balls: 0, parked: false, zone: "near", level: 1 });
  });

  it("clamps to min and max, and leaves unset bounds alone", () => {
    expect(clampCounter(BALLS, 12)).toBe(10);
    expect(clampCounter(BALLS, -3)).toBe(0);
    expect(clampCounter(field({ min: null, max: null }), 1000)).toBe(1000);
  });
});

describe("ScoresheetForm", () => {
  it("steps a counter by its step and clamps it at max", () => {
    render(<Harness initial={{ balls: 8, parked: false, zone: "near", level: 1 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Increase Balls" }));
    expect(screen.getByLabelText("Balls")).toHaveValue("10");
    expect(screen.getByRole("button", { name: "Increase Balls" })).toBeDisabled();
  });

  it("clamps a counter at min and disables decrease there", () => {
    render(<Harness initial={{ balls: 1, parked: false, zone: "near", level: 1 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Decrease Balls" }));
    expect(screen.getByLabelText("Balls")).toHaveValue("0");
    expect(screen.getByRole("button", { name: "Decrease Balls" })).toBeDisabled();
  });

  it("passes a typed number through unclamped, and other text as text", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Balls"), { target: { value: "12" } });
    expect(latest.balls).toBe(12);
    fireEvent.change(screen.getByLabelText("Balls"), { target: { value: "abc" } });
    expect(latest.balls).toBe("abc");
  });

  it("toggles a boolean", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("switch", { name: "Parked" }));
    expect(latest.parked).toBe(true);
  });

  it("returns the chosen select option", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Zone"), { target: { value: "far" } });
    expect(latest.zone).toBe("far");
  });

  it("returns numeric radio options as numbers and shows the icon decoratively", () => {
    render(<Harness />);
    expect(screen.getByRole("group", { name: "Level" })).toBeInTheDocument();
    expect(screen.getByText("▲")).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(screen.getByRole("radio", { name: "2" }));
    expect(latest.level).toBe(2);
  });

  it("shows an error beside its field", () => {
    render(<Harness errors={{ balls: "Must be at most 10." }} />);
    const input = screen.getByLabelText("Balls");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Must be at most 10.");
  });
});
```

Append to `frontend/packages/shared/tests/api-client.test.ts`, inside `describe("apiRequest", ...)`:

```ts
  it("keeps the parsed error body on ApiError", async () => {
    const body = { detail: "The scoresheet has errors.", violations: [{ field: "score", message: "Must be at most 999." }] };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 422 }));

    const error = await apiRequest("/api/sessions/1/skills/attempts").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).detail).toBe("The scoresheet has errors.");
    expect((error as ApiError).body).toEqual(body);
  });

  it("gives a null body when the error response isn't JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("oops", { status: 500, statusText: "Server Error" }));

    const error = (await apiRequest("/api/event").catch((caught: unknown) => caught)) as ApiError;

    expect(error.detail).toBe("Server Error");
    expect(error.body).toBeNull();
  });
```

- [ ] **Step 2: Run to verify failure.** `cd frontend && npm test --workspace packages/shared`. Expected: FAIL. `../src/scoresheet` does not exist and `body` is undefined.

- [ ] **Step 3: Add the error body.** In `packages/shared/src/api-client.ts`, replace the `ApiError` class and `readErrorDetail` with:

```ts
export class ApiError extends Error {
  status: number;
  detail: string;
  /** The parsed JSON error body when there was one (e.g. a 422's `violations`), else null. */
  body: unknown;

  constructor(status: number, detail: string, body: unknown = null) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.body = body;
  }
}

async function readError(response: Response): Promise<{ detail: string; body: unknown }> {
  try {
    const body = (await response.json()) as { detail?: string } | null;
    return { detail: body?.detail ?? response.statusText, body };
  } catch {
    return { detail: response.statusText, body: null };
  }
}
```

and replace the throw in `apiRequest` with:

```ts
  if (!response.ok) {
    const { detail, body } = await readError(response);
    throw new ApiError(response.status, detail, body);
  }
```

- [ ] **Step 4: Implement the scoresheet types.** Create `packages/shared/src/scoresheet/types.ts`:

```ts
export type ScoresheetDataType = "integer" | "boolean" | "enum";
export type ScoresheetWidget = "counter" | "toggle" | "select" | "radio";
export type ScoresheetValue = number | boolean | string;
export type ScoresheetValues = Record<string, ScoresheetValue>;

/** One field of a game plugin's scoresheet schema (teamwork or skills), as the server returns it. */
export interface ScoresheetField {
  name: string;
  label: string;
  data_type: ScoresheetDataType;
  widget: ScoresheetWidget;
  min: number | null;
  max: number | null;
  step: number | null;
  options: (string | number)[] | null;
  icon: string | null;
  scope: string;
  default: ScoresheetValue;
}

/** The caller's translate function. The form's own strings use keys under `scoresheet.`. */
export type ScoresheetTranslate = (key: string, options?: Record<string, unknown>) => string;

export function defaultValues(fields: ScoresheetField[]): ScoresheetValues {
  return Object.fromEntries(fields.map((field) => [field.name, field.default]));
}

export function clampCounter(field: ScoresheetField, value: number): number {
  let next = value;
  if (field.min !== null && next < field.min) next = field.min;
  if (field.max !== null && next > field.max) next = field.max;
  return next;
}
```

- [ ] **Step 5: Implement the form.** Create `packages/shared/src/scoresheet/ScoresheetForm.tsx`:

```tsx
import type { ComponentType } from "react";
import {
  clampCounter,
  type ScoresheetField,
  type ScoresheetTranslate,
  type ScoresheetValue,
  type ScoresheetValues,
  type ScoresheetWidget,
} from "./types";

interface FieldProps {
  field: ScoresheetField;
  value: ScoresheetValue | undefined;
  onChange: (value: ScoresheetValue) => void;
  id: string;
  errorId: string | undefined;
  t: ScoresheetTranslate;
}

function Icon({ icon }: { icon: string | null }) {
  return icon ? (
    <span className="scoresheet__icon" aria-hidden="true">
      {icon}
    </span>
  ) : null;
}

/** − value +. The buttons clamp to min/max; a typed number is passed through as typed so the server can report it. */
function CounterField({ field, value, onChange, id, errorId, t }: FieldProps) {
  const numeric = typeof value === "number" ? value : null;
  const step = field.step ?? 1;
  const bump = (delta: number) => onChange(clampCounter(field, (numeric ?? field.min ?? 0) + delta));
  return (
    <div className="scoresheet__field">
      <label className="scoresheet__label" htmlFor={id}>
        <Icon icon={field.icon} />
        {field.label}
      </label>
      <div className="scoresheet__counter">
        <button
          type="button"
          className="btn"
          aria-label={t("scoresheet.decrease", { label: field.label })}
          disabled={numeric !== null && field.min !== null && numeric <= field.min}
          onClick={() => bump(-step)}
        >
          −
        </button>
        <input
          id={id}
          className="input scoresheet__count"
          inputMode="numeric"
          value={value === undefined ? "" : String(value)}
          aria-invalid={errorId ? true : undefined}
          aria-describedby={errorId}
          onChange={(event) => {
            const text = event.target.value.trim();
            onChange(/^-?\d+$/.test(text) ? Number(text) : text);
          }}
        />
        <button
          type="button"
          className="btn"
          aria-label={t("scoresheet.increase", { label: field.label })}
          disabled={numeric !== null && field.max !== null && numeric >= field.max}
          onClick={() => bump(step)}
        >
          +
        </button>
      </div>
    </div>
  );
}

function ToggleField({ field, value, onChange, id, errorId }: FieldProps) {
  return (
    <div className="scoresheet__field">
      <label className="choice">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={value === true}
          aria-invalid={errorId ? true : undefined}
          aria-describedby={errorId}
          onChange={(event) => onChange(event.target.checked)}
        />
        <Icon icon={field.icon} />
        {field.label}
      </label>
    </div>
  );
}

function optionFor(field: ScoresheetField, text: string): ScoresheetValue {
  return (field.options ?? []).find((option) => String(option) === text) ?? text;
}

function SelectField({ field, value, onChange, id, errorId }: FieldProps) {
  return (
    <div className="scoresheet__field">
      <label className="scoresheet__label" htmlFor={id}>
        <Icon icon={field.icon} />
        {field.label}
      </label>
      <select
        id={id}
        className="input select"
        value={value === undefined ? "" : String(value)}
        aria-invalid={errorId ? true : undefined}
        aria-describedby={errorId}
        onChange={(event) => onChange(optionFor(field, event.target.value))}
      >
        {(field.options ?? []).map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    </div>
  );
}

function RadioField({ field, value, onChange, id, errorId }: FieldProps) {
  return (
    <fieldset className="scoresheet__field scoresheet__radio" aria-describedby={errorId}>
      <legend className="scoresheet__label">
        <Icon icon={field.icon} />
        {field.label}
      </legend>
      {(field.options ?? []).map((option) => (
        <label className="choice" key={String(option)}>
          <input type="radio" name={id} checked={value === option} onChange={() => onChange(option)} />
          {String(option)}
        </label>
      ))}
    </fieldset>
  );
}

const WIDGETS: Record<ScoresheetWidget, ComponentType<FieldProps>> = {
  counter: CounterField,
  toggle: ToggleField,
  select: SelectField,
  radio: RadioField,
};

export interface ScoresheetFormProps {
  fields: ScoresheetField[];
  values: ScoresheetValues;
  onChange: (values: ScoresheetValues) => void;
  /** Field name -> message, shown beside that field. */
  errors?: Record<string, string>;
  t: ScoresheetTranslate;
  idPrefix: string;
}

/** A plugin scoresheet drawn from its field list. Knows nothing about skills or teamwork. */
export function ScoresheetForm({ fields, values, onChange, errors = {}, t, idPrefix }: ScoresheetFormProps) {
  return (
    <div className="scoresheet">
      {fields.map((field) => {
        const id = `${idPrefix}-${field.name}`;
        const error = errors[field.name];
        const errorId = error ? `${id}-error` : undefined;
        const Widget = WIDGETS[field.widget];
        return (
          <div key={field.name} className="scoresheet__row">
            <Widget
              field={field}
              value={values[field.name]}
              id={id}
              errorId={errorId}
              t={t}
              onChange={(value) => onChange({ ...values, [field.name]: value })}
            />
            {error && (
              <p className="field__hint field__error" id={errorId}>
                {error}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

Create `packages/shared/src/scoresheet/index.ts`:

```ts
export * from "./types";
export * from "./ScoresheetForm";
```

Add `export * from "./scoresheet";` to `packages/shared/src/index.ts`.

- [ ] **Step 6: Run to verify the tests pass.** `cd frontend && npm test --workspace packages/shared && npx tsc -p packages/shared`. Expected: all pass and tsc is clean. Then run `npm test --workspace apps/admin -- --run && npx tsc -b apps/admin`. Expected: still green, because existing `new ApiError(status, detail)` calls are unchanged.

- [ ] **Step 7: Commit.**

```bash
git add frontend/packages/shared/src frontend/packages/shared/tests
git commit -m "Add shared scoresheet components and keep error bodies on ApiError

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Event Setup skills panel

**Files:**
- Modify: `frontend/apps/admin/src/types.ts`
- Create: `frontend/apps/admin/src/skills/useSkillsSettings.ts`
- Create: `frontend/apps/admin/src/skills/skillsSettingsDraft.ts`
- Create: `frontend/apps/admin/src/skills/SkillsSettingsPanel.tsx`
- Modify: `frontend/apps/admin/src/routes/EventSetupRoute.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json`
- Test: `frontend/apps/admin/tests/unit/skillsSettingsDraft.test.ts`, `frontend/apps/admin/tests/unit/SkillsSettingsPanel.test.tsx`, `frontend/apps/admin/tests/unit/EventSetupRoute.test.tsx`

**Interfaces:**
- Consumes: Task 4's `GET/PUT /api/skills/settings` and Task 7's `ScoresheetValues`.
- Produces:
  - `types.ts`:
    - `SkillsType { key; label }`
    - `SkillsSettingsRead { enabled; attempts; types }`
    - `SessionSkillsType extends SkillsType { allowed }`
    - `SessionSkillsRead { types; override }`
    - `SkillsAttemptRead { id; team_id; skills_type; number; score; data: ScoresheetValues; recorded_at; updated_at }`
    - `SkillsRankingRead { rank; team_id; score; attempts; session_id }`
  - `SKILLS_SETTINGS_KEY = ["skillsSettings"]` and `useSkillsSettings()`.
  - From `skillsSettingsDraft.ts`:
    - `toSkillsDraft(settings)`
    - `attemptsErrors(attempts: Record<string, string>): Set<string>`
    - `parseAttempts(attempts: Record<string, string>): Record<string, number> | null`
    - Task 9's override form reuses the last two.
  - `SkillsSettingsPanel()`, rendered on Event Setup after `RankingSettingsPanel`.
  - i18n keys under `skills.settings.*`.

- [ ] **Step 1: Add the types.** Append to `src/types.ts`, and add `import type { ScoresheetValues } from "@tournament-admin/shared";` as the file's first line:

```ts
export interface SkillsType {
  key: string;
  label: string;
}

export interface SkillsSettingsRead {
  enabled: boolean;
  /** Every plugin type's allowed attempts per session, 3 where unset. */
  attempts: Record<string, number>;
  /** In tie-break priority order; [] before a game plugin is chosen or for a game with no skills. */
  types: SkillsType[];
}

export interface SessionSkillsType extends SkillsType {
  /** The effective allowed attempts in this session. */
  allowed: number;
}

export interface SessionSkillsRead {
  types: SessionSkillsType[];
  /** The session's own attempts, or null when it uses the event setting. */
  override: Record<string, number> | null;
}

export interface SkillsAttemptRead {
  id: number;
  team_id: number;
  skills_type: string;
  /** 1, 2, 3, ... per team and type in the session. */
  number: number;
  score: number;
  data: ScoresheetValues;
  recorded_at: string;
  updated_at: string;
}

export interface SkillsRankingRead {
  rank: number;
  team_id: number;
  score: number;
  /** Best first; for Overall, each type's list in plugin order. */
  attempts: number[];
  session_id: number;
}
```

- [ ] **Step 2: Add the i18n strings.** In `en/admin.json`, add a top-level `"skills"` object (after `"rankings"`):

```json
"skills": {
  "settings": {
    "heading": "Skills challenges",
    "enabledLabel": "Run skills challenges",
    "attemptsLegend": "Attempts each team gets per session",
    "attemptsLabel": "{{label}} attempts",
    "attemptsError": "Enter a whole number from 1 to 20.",
    "noPlugin": "Choose a game plugin above before setting up skills challenges.",
    "noTypes": "This game has no skills challenges.",
    "save": "Save skills settings",
    "saved": "Skills settings saved."
  }
}
```

In `zh/admin.json`, add:

```json
"skills": {
  "settings": {
    "heading": "技能挑战赛",
    "enabledLabel": "举办技能挑战赛",
    "attemptsLegend": "每支队伍每个场次的尝试次数",
    "attemptsLabel": "{{label}} 尝试次数",
    "attemptsError": "请输入 1 到 20 之间的整数。",
    "noPlugin": "请先在上方选择比赛插件，再设置技能挑战赛。",
    "noTypes": "此比赛没有技能挑战赛。",
    "save": "保存技能赛设置",
    "saved": "技能赛设置已保存。"
  }
}
```

- [ ] **Step 3: Write the failing tests.** Create `tests/unit/skillsSettingsDraft.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { attemptsErrors, parseAttempts, toSkillsDraft } from "../../src/skills/skillsSettingsDraft";

describe("skillsSettingsDraft", () => {
  it("starts from the saved settings, one text per type", () => {
    const draft = toSkillsDraft({
      enabled: true,
      attempts: { autonomous: 3, driver: 5 },
      types: [{ key: "autonomous", label: "Autonomous" }, { key: "driver", label: "Driver" }],
    });
    expect(draft).toEqual({ enabled: true, attempts: { autonomous: "3", driver: "5" } });
  });

  it("flags anything but a whole number from 1 to 20", () => {
    const errors = attemptsErrors({ a: "", b: "0", c: "21", d: "2.5", e: "abc", f: " 3 ", g: "20", h: "1" });
    expect([...errors].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("parses a valid draft and refuses an invalid one", () => {
    expect(parseAttempts({ autonomous: " 2 ", driver: "20" })).toEqual({ autonomous: 2, driver: 20 });
    expect(parseAttempts({ autonomous: "0" })).toBeNull();
    expect(parseAttempts({})).toEqual({});
  });
});
```

Create `tests/unit/SkillsSettingsPanel.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SkillsSettingsPanel } from "../../src/skills/SkillsSettingsPanel";
import type { EventRead, SkillsSettingsRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest, ApiError } from "@tournament-admin/shared";

const TYPES = [
  { key: "autonomous", label: "Autonomous" },
  { key: "driver", label: "Driver" },
];

function event(game_plugin_name: string | null): EventRead {
  return { id: 1, name: "League", active_session_id: null, game_plugin_name, created_at: "2026-10-08T00:00:00Z" };
}

function stub(
  pluginName: string | null,
  settings: SkillsSettingsRead,
  onPut: (body: unknown) => unknown = (body) => ({ ...settings, ...(body as object) })
) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = options as { method?: string; body?: unknown } | undefined;
    if (path === "/api/event") return event(pluginName) as never;
    if (path === "/api/skills/settings" && opts?.method === "PUT") {
      const result = onPut(opts.body);
      if (result instanceof Error) throw result;
      return result as never;
    }
    if (path === "/api/skills/settings") return settings as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function renderPanel() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <SkillsSettingsPanel />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

const puts = () =>
  vi.mocked(apiRequest).mock.calls.filter(([, options]) => (options as { method?: string })?.method === "PUT");

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

describe("SkillsSettingsPanel", () => {
  it("is disabled with the reason before a game plugin is chosen", async () => {
    stub(null, { enabled: false, attempts: {}, types: [] });
    renderPanel();
    expect(
      await screen.findByText("Choose a game plugin above before setting up skills challenges.")
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Run skills challenges" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save skills settings" })).toBeDisabled();
  });

  it("is disabled for a game with no skills types", async () => {
    stub("plain-game", { enabled: false, attempts: {}, types: [] });
    renderPanel();
    expect(await screen.findByText("This game has no skills challenges.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Run skills challenges" })).toBeDisabled();
  });

  it("validates attempts inline and saves the switch and every type", async () => {
    stub("sample_cooperative", { enabled: false, attempts: { autonomous: 3, driver: 3 }, types: TYPES });
    renderPanel();
    const autonomous = await screen.findByLabelText("Autonomous attempts");
    expect(autonomous).toHaveValue("3");
    expect(screen.getByLabelText("Driver attempts")).toHaveValue("3");

    fireEvent.change(autonomous, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save skills settings" }));
    expect(await screen.findByText("Enter a whole number from 1 to 20.")).toBeInTheDocument();
    expect(autonomous).toHaveAttribute("aria-invalid", "true");
    expect(puts()).toHaveLength(0);

    fireEvent.change(autonomous, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("switch", { name: "Run skills challenges" }));
    fireEvent.click(screen.getByRole("button", { name: "Save skills settings" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual([
      "/api/skills/settings",
      { method: "PUT", body: { enabled: true, attempts: { autonomous: 5, driver: 3 } } },
    ]);
    expect(await screen.findByText("Skills settings saved.")).toBeInTheDocument();
  });

  it("shows a server refusal", async () => {
    stub(
      "sample_cooperative",
      { enabled: false, attempts: { autonomous: 3, driver: 3 }, types: TYPES },
      () => new ApiError(409, "This game has no skills challenges.")
    );
    renderPanel();
    fireEvent.click(await screen.findByRole("switch", { name: "Run skills challenges" }));
    fireEvent.click(screen.getByRole("button", { name: "Save skills settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This game has no skills challenges.");
  });
});
```

Create `tests/unit/EventSetupRoute.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { EventSetupRoute } from "../../src/routes/EventSetupRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

describe("EventSetupRoute", () => {
  it("enables the skills panel as soon as a game plugin is selected, without a reload", async () => {
    let selected: string | null = null;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      const opts = options as { method?: string; body?: { name?: string } } | undefined;
      if (path === "/api/plugins/games") {
        return [{ name: "sample_cooperative", version: "1.0.0", display_name: "Sample Cooperative Game" }] as never;
      }
      if (path === "/api/plugins/schedulers") return [] as never;
      if (path === "/api/server-info") return { port: 8000, addresses: [] } as never;
      if (path === "/api/event/game-plugin" && opts?.method === "POST") {
        selected = opts.body?.name ?? null;
        return { id: 1, name: "League", active_session_id: null, game_plugin_name: selected, created_at: "" } as never;
      }
      if (path === "/api/event") {
        return { id: 1, name: "League", active_session_id: null, game_plugin_name: selected, created_at: "" } as never;
      }
      if (path === "/api/ranking-settings") {
        return {
          session_drop_mode: "tiered", session_drop_count: 1, session_drop_no_show: false, session_drop_dq: false,
          season_keep_best: null, season_only_session_counted: false, season_minimum: 0,
          season_drop_no_show: false, season_drop_dq: false, game_model: null,
        } as never;
      }
      if (path === "/api/skills/settings") {
        return (selected
          ? {
              enabled: false,
              attempts: { autonomous: 3, driver: 3 },
              types: [{ key: "autonomous", label: "Autonomous" }, { key: "driver", label: "Driver" }],
            }
          : { enabled: false, attempts: {}, types: [] }) as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const i18n = initI18n({ en: { translation: enAdmin } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <EventSetupRoute />
        </I18nextProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByRole("switch", { name: "Run skills challenges" })).toBeDisabled();
    fireEvent.click(await screen.findByRole("button", { name: "Select for this event" }));

    expect(await screen.findByLabelText("Autonomous attempts")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Run skills challenges" })).toBeEnabled();
    expect(
      screen.queryByText("Choose a game plugin above before setting up skills challenges.")
    ).not.toBeInTheDocument();
  });
});
```

Run `cd frontend && npm test --workspace apps/admin -- --run skillsSettings SkillsSettingsPanel EventSetupRoute`. Expected: FAIL (modules missing).

- [ ] **Step 4: Implement the query hook and draft logic.** Create `src/skills/useSkillsSettings.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@tournament-admin/shared";
import type { SkillsSettingsRead } from "../types";

export const SKILLS_SETTINGS_KEY = ["skillsSettings"];

/** Whether skills run, each type's allowed attempts, and the plugin's types (in priority order). */
export function useSkillsSettings() {
  return useQuery({
    queryKey: SKILLS_SETTINGS_KEY,
    queryFn: () => apiRequest<SkillsSettingsRead>("/api/skills/settings"),
  });
}
```

Create `src/skills/skillsSettingsDraft.ts`:

```ts
import type { SkillsSettingsRead } from "../types";

export interface SkillsSettingsDraft {
  enabled: boolean;
  /** Type key -> the text in its attempts box. */
  attempts: Record<string, string>;
}

const MIN_ATTEMPTS = 1;
const MAX_ATTEMPTS = 20;

export function toSkillsDraft(settings: SkillsSettingsRead): SkillsSettingsDraft {
  return {
    enabled: settings.enabled,
    attempts: Object.fromEntries(settings.types.map((type) => [type.key, String(settings.attempts[type.key] ?? 3)])),
  };
}

function isValidAttempts(text: string): boolean {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  const value = Number(trimmed);
  return value >= MIN_ATTEMPTS && value <= MAX_ATTEMPTS;
}

/** The keys whose text isn't a whole number from 1 to 20. */
export function attemptsErrors(attempts: Record<string, string>): Set<string> {
  return new Set(Object.entries(attempts).filter(([, text]) => !isValidAttempts(text)).map(([key]) => key));
}

/** The attempts as numbers, or null while any is invalid. */
export function parseAttempts(attempts: Record<string, string>): Record<string, number> | null {
  if (attemptsErrors(attempts).size > 0) return null;
  return Object.fromEntries(Object.entries(attempts).map(([key, text]) => [key, Number(text.trim())]));
}
```

- [ ] **Step 5: Implement the panel.** Create `src/skills/SkillsSettingsPanel.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import type { EventRead, SkillsSettingsRead } from "../types";
import { attemptsErrors, parseAttempts, toSkillsDraft, type SkillsSettingsDraft } from "./skillsSettingsDraft";
import { SKILLS_SETTINGS_KEY, useSkillsSettings } from "./useSkillsSettings";

/** Event Setup's "Skills challenges" panel: shown disabled, with the reason, until the game has skills types. */
export function SkillsSettingsPanel() {
  const { t } = useTranslation();
  const { data: event } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });
  const { data: settings } = useSkillsSettings();
  if (!event || !settings) return null;
  const disabledReason =
    event.game_plugin_name === null
      ? t("skills.settings.noPlugin")
      : settings.types.length === 0
        ? t("skills.settings.noTypes")
        : null;
  // Remount (and re-seed the draft) when the plugin or its types change.
  const formKey = `${event.game_plugin_name ?? ""}:${settings.types.map((type) => type.key).join(",")}`;
  return <SkillsSettingsForm key={formKey} settings={settings} disabledReason={disabledReason} />;
}

function SkillsSettingsForm({
  settings,
  disabledReason,
}: {
  settings: SkillsSettingsRead;
  disabledReason: string | null;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SkillsSettingsDraft>(() => toSkillsDraft(settings));
  const [attempted, setAttempted] = useState(false);
  const errors = attemptsErrors(draft.attempts);
  const disabled = disabledReason !== null;
  const mutation = useMutation({
    mutationFn: (body: { enabled: boolean; attempts: Record<string, number> }) =>
      apiRequest<SkillsSettingsRead>("/api/skills/settings", { method: "PUT", body }),
    onSuccess: (saved) => {
      queryClient.setQueryData(SKILLS_SETTINGS_KEY, saved);
      queryClient.invalidateQueries({ queryKey: ["sessionSkills"] });
      queryClient.invalidateQueries({ queryKey: ["skillsRankings"] });
    },
  });

  function update(changes: Partial<SkillsSettingsDraft>) {
    setDraft((current) => ({ ...current, ...changes }));
    mutation.reset();
  }

  function onSubmit(submitEvent: FormEvent) {
    submitEvent.preventDefault();
    setAttempted(true);
    const attempts = parseAttempts(draft.attempts);
    if (attempts === null) return;
    mutation.mutate({ enabled: draft.enabled, attempts });
  }

  return (
    <section className="panel" aria-labelledby="skills-settings-heading">
      <h2 id="skills-settings-heading">{t("skills.settings.heading")}</h2>
      {disabledReason && (
        <p className="field__hint" id="skills-settings-reason">
          {disabledReason}
        </p>
      )}
      <form onSubmit={onSubmit} noValidate>
        <fieldset
          className="settings-group"
          disabled={disabled}
          aria-describedby={disabled ? "skills-settings-reason" : undefined}
        >
          <label className="choice">
            <input
              type="checkbox"
              role="switch"
              checked={draft.enabled}
              onChange={(changeEvent) => update({ enabled: changeEvent.target.checked })}
            />
            {t("skills.settings.enabledLabel")}
          </label>
          {settings.types.length > 0 && <p className="field__hint">{t("skills.settings.attemptsLegend")}</p>}
          {settings.types.map((type) => {
            const inputId = `skills-attempts-${type.key}`;
            const invalid = attempted && errors.has(type.key);
            return (
              <div className="field" key={type.key}>
                <label className="field__label" htmlFor={inputId}>
                  {t("skills.settings.attemptsLabel", { label: type.label })}
                </label>
                <input
                  id={inputId}
                  className="input settings-number"
                  inputMode="numeric"
                  value={draft.attempts[type.key] ?? ""}
                  aria-invalid={invalid ? true : undefined}
                  aria-describedby={invalid ? `${inputId}-error` : undefined}
                  onChange={(changeEvent) =>
                    update({ attempts: { ...draft.attempts, [type.key]: changeEvent.target.value } })
                  }
                />
                {invalid && (
                  <p className="field__hint field__error" id={`${inputId}-error`}>
                    {t("skills.settings.attemptsError")}
                  </p>
                )}
              </div>
            );
          })}
          {mutation.isError && (
            <p className="alert alert-danger" role="alert">
              {apiErrorMessage(mutation.error, t("errors.generic"))}
            </p>
          )}
          {mutation.isSuccess && (
            <p className="alert alert-success" role="status">
              {t("skills.settings.saved")}
            </p>
          )}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
              {t("skills.settings.save")}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
```

A disabled `<fieldset>` disables every control inside it, the switch and Save included.

- [ ] **Step 6: Wire Event Setup.** In `routes/EventSetupRoute.tsx`:
- Import `SkillsSettingsPanel` from `"../skills/SkillsSettingsPanel"` and `SKILLS_SETTINGS_KEY` from `"../skills/useSkillsSettings"`.
- In `PluginList`'s `selectMutation.onSuccess`, add `queryClient.invalidateQueries({ queryKey: SKILLS_SETTINGS_KEY });`.
- In `EventSetupRoute`, render `<SkillsSettingsPanel />` right after `<RankingSettingsPanel />`.

- [ ] **Step 7: Run the frontend checks.** `cd frontend && npm test --workspace apps/admin -- --run && npx tsc -b apps/admin`. Expected: all unit tests pass and tsc is clean.

- [ ] **Step 8: Commit.**

```bash
git add frontend/apps/admin/src frontend/apps/admin/tests/unit
git commit -m "Add the skills challenges panel to Event Setup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Session Skills page — tab, attempts line, override form, record form

**Files:**
- Create in `frontend/apps/admin/src/skills/`:
  - `useSessionSkills.ts`
  - `liveUpdates.ts`
  - `scoresheetErrors.ts`
  - `useScoresheetT.ts`
  - `recordForm.ts`
  - `TeamPicker.tsx`
  - `RecordAttemptForm.tsx`
  - `SessionAttemptsSettings.tsx`
- Create: `frontend/apps/admin/src/routes/SessionSkillsRoute.tsx`
- Modify: `frontend/apps/admin/src/router.tsx`, `frontend/apps/admin/src/routes/SessionDetailLayout.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json`
- Modify: `frontend/apps/admin/src/styles/components.css`
- Test: `frontend/apps/admin/tests/unit/recordForm.test.ts`, `frontend/apps/admin/tests/unit/SessionSkillsRoute.test.tsx`, and extend `frontend/apps/admin/tests/unit/SessionDetailLayout.test.tsx`

**Interfaces:**
- Consumes:
  - Task 4's `GET/PUT /api/sessions/{id}/skills` and schema endpoint.
  - Task 5's `GET/POST .../skills/attempts` and its 422 `violations` body.
  - Task 7's `ScoresheetForm`, `defaultValues` and `ApiError.body`.
  - Task 8's types, `useSkillsSettings`, `SKILLS_SETTINGS_KEY`, `attemptsErrors` and `parseAttempts`.
- Produces:
  - Query keys:
    - `sessionSkillsKey(sessionId) = ["sessionSkills", sessionId]`
    - `skillsAttemptsKey(sessionId) = ["skillsAttempts", sessionId]`
    - `skillsSchemaKey(typeKey) = ["skillsSchema", typeKey]`
    - The prefix `["skillsRankings"]`, used by Task 11.
  - Hooks:
    - `useSessionSkills(sessionId)`
    - `useSkillsAttempts(sessionId)`
    - `useSkillsSchema(typeKey: string | null)`
    - `useSkillsLiveUpdates()`, which listens on `/ws/active-session`.
  - Helpers:
    - `handleSkillsEvent(queryClient, realtimeEvent)`, used by Task 11's Season page.
    - `violationsByField(error): Record<string, string> | null`
    - `useScoresheetT(): ScoresheetTranslate`
    - From `recordForm.ts`:
      - `attemptStatus(attempts, teamId, typeKey, allowed): { used; next; usedUp }`
      - `compareTeamNumbers(a, b)`
      - `teamMatches(team, text)`
      - `matchTeams(teams, text)`
      - Task 10 reuses the last three.
  - The route `/sessions/:sessionId/skills` (`SessionSkillsRoute`). It renders `SessionAttemptsSettings` and `RecordAttemptForm`, and Task 10 adds the attempts table below them.
  - The session tab "Skills", between Matches and Rankings, shown only while `enabled`.
  - i18n keys `sessions.skillsTab`, `skills.page.*`, `skills.record.*` and `scoresheet.*`.

- [ ] **Step 1: Add the i18n strings.**
- In `en/admin.json`:
  - Under `sessions`, add `"skillsTab": "Skills"`.
  - Add a top-level `"scoresheet": { "decrease": "Decrease {{label}}", "increase": "Increase {{label}}" }`.
  - Inside `skills`, add:

```json
"page": {
  "loading": "Loading skills...",
  "off": "Skills challenges are turned off for this event.",
  "offLink": "Go to Event Setup",
  "attemptsHeading": "Attempts allowed",
  "attemptsEntry": "{{label}} {{allowed}}",
  "attemptsLine": "{{entries}} ({{source}})",
  "sourceEvent": "event setting",
  "sourceSession": "this session",
  "change": "Change for this session",
  "useEvent": "Use event setting",
  "overrideLegend": "Attempts allowed in this session",
  "overrideSave": "Save for this session",
  "overrideCancel": "Cancel"
},
"record": {
  "heading": "Record an attempt",
  "teamLabel": "Team",
  "teamPlaceholder": "Type a team number or name",
  "noTeams": "No checked-in team matches.",
  "changeTeam": "Change team",
  "pickTeam": "Pick a checked-in team to record an attempt.",
  "typeLegend": "Skills type",
  "attemptCount": "Attempt {{n}} of {{allowed}}",
  "usedUp": "Team {{number}} has used all {{n}} {{label}} attempts.",
  "save": "Save attempt",
  "saved": "Saved: {{score}} points"
}
```

- In `zh/admin.json`:
  - Under `sessions`, add `"skillsTab": "技能赛"`.
  - Add a top-level `"scoresheet": { "decrease": "减少{{label}}", "increase": "增加{{label}}" }`.
  - Inside `skills`, add:

```json
"page": {
  "loading": "正在加载技能赛...",
  "off": "本赛事已关闭技能挑战赛。",
  "offLink": "前往赛事设置",
  "attemptsHeading": "允许的尝试次数",
  "attemptsEntry": "{{label}} {{allowed}}",
  "attemptsLine": "{{entries}}（{{source}}）",
  "sourceEvent": "赛事设置",
  "sourceSession": "本场次",
  "change": "为本场次修改",
  "useEvent": "使用赛事设置",
  "overrideLegend": "本场次允许的尝试次数",
  "overrideSave": "为本场次保存",
  "overrideCancel": "取消"
},
"record": {
  "heading": "记录一次尝试",
  "teamLabel": "队伍",
  "teamPlaceholder": "输入队伍编号或名称",
  "noTeams": "没有匹配的已签到队伍。",
  "changeTeam": "更换队伍",
  "pickTeam": "请选择一支已签到的队伍来记录尝试。",
  "typeLegend": "技能类型",
  "attemptCount": "第 {{n}} 次，共 {{allowed}} 次",
  "usedUp": "{{number}} 队已用完全部 {{n}} 次{{label}}尝试。",
  "save": "保存尝试",
  "saved": "已保存：{{score}} 分"
}
```

- [ ] **Step 2: Write the failing pure test.** Create `tests/unit/recordForm.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { attemptStatus, matchTeams, teamMatches } from "../../src/skills/recordForm";
import type { SkillsAttemptRead, TeamSummary } from "../../src/types";

function attempt(id: number, team_id: number, skills_type: string): SkillsAttemptRead {
  return { id, team_id, skills_type, number: 1, score: 10, data: {}, recorded_at: "", updated_at: "" };
}

const TEAMS: TeamSummary[] = [
  { id: 1, number: "10", name: "Alpha", division_id: null },
  { id: 2, number: "9", name: "Bravo (East)", division_id: null },
  { id: 3, number: "S1", name: "Skills One", division_id: null },
];

describe("recordForm", () => {
  it("counts the team's attempts of the type and says whether any are left", () => {
    const attempts = [attempt(1, 1, "driver"), attempt(2, 1, "driver"), attempt(3, 1, "autonomous"), attempt(4, 2, "driver")];
    expect(attemptStatus(attempts, 1, "driver", 3)).toEqual({ used: 2, next: 3, usedUp: false });
    expect(attemptStatus(attempts, 1, "driver", 2)).toEqual({ used: 2, next: 3, usedUp: true });
    expect(attemptStatus(attempts, 3, "driver", 1)).toEqual({ used: 0, next: 1, usedUp: false });
  });

  it("matches number or name, trimmed and case-insensitive, sorted by number", () => {
    expect(matchTeams(TEAMS, "").map((team) => team.number)).toEqual(["9", "10", "S1"]);
    expect(matchTeams(TEAMS, "  s1 ").map((team) => team.number)).toEqual(["S1"]);
    expect(matchTeams(TEAMS, "ALPHA").map((team) => team.number)).toEqual(["10"]);
    expect(matchTeams(TEAMS, "(").map((team) => team.number)).toEqual(["9"]);
    expect(teamMatches(TEAMS[0], "zz")).toBe(false);
  });
});
```

- [ ] **Step 3: Write the failing route tests.** Create `tests/unit/SessionSkillsRoute.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { initI18n, type RealtimeEvent, type ScoresheetField } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionSkillsRoute } from "../../src/routes/SessionSkillsRoute";
import type { SessionRead, SessionSkillsType, SkillsAttemptRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, ApiError, useRealtimeChannel } from "@tournament-admin/shared";

const SESSION: SessionRead = {
  id: 1, event_id: 1, label: "Saturday", session_date: null, timezone: null,
  has_scored_matches: false, qualification_finalized_at: null, qualification_drops: null,
};
const TEAMS = [
  { id: 1, number: "101", name: "Alpha", division_id: null },
  { id: 2, number: "202", name: "Bravo", division_id: null },
  { id: 3, number: "303", name: "Charlie", division_id: null },
];
const PARTICIPANTS = [
  { id: 1, session_id: 1, team_id: 1, checked_in: true },
  { id: 2, session_id: 1, team_id: 2, checked_in: true },
  { id: 3, session_id: 1, team_id: 3, checked_in: false },
];
const SCORE: ScoresheetField = {
  name: "score", label: "Score", data_type: "integer", widget: "counter",
  min: 0, max: 999, step: 1, options: null, icon: null, scope: "team", default: 0,
};
const BOTH: SessionSkillsType[] = [
  { key: "autonomous", label: "Autonomous", allowed: 3 },
  { key: "driver", label: "Driver", allowed: 1 },
];

function attempt(id: number, team_id: number, skills_type: string, number: number, score: number): SkillsAttemptRead {
  return { id, team_id, skills_type, number, score, data: { score }, recorded_at: "", updated_at: "" };
}

interface StubOptions {
  enabled?: boolean;
  types?: SessionSkillsType[];
  override?: Record<string, number> | null;
  attempts?: SkillsAttemptRead[];
  onPost?: (body: { team_id: number; skills_type: string; data: { score: number } }) => unknown;
  onPut?: (body: unknown) => unknown;
}

function stub({
  enabled = true,
  types = BOTH,
  override = null,
  attempts = [attempt(1, 1, "autonomous", 1, 20), attempt(2, 1, "driver", 1, 34)],
  onPost = (body) => ({ ...attempt(9, body.team_id, body.skills_type, 2, body.data.score), data: body.data }),
  onPut = () => ({ types, override: null }),
}: StubOptions = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = options as { method?: string; body?: unknown } | undefined;
    if (path === "/api/skills/settings") {
      return { enabled, attempts: {}, types: types.map(({ key, label }) => ({ key, label })) } as never;
    }
    if (path === "/api/sessions/1/skills" && opts?.method === "PUT") return onPut(opts.body) as never;
    if (path === "/api/sessions/1/skills") return { types, override } as never;
    if (path === "/api/sessions/1/skills/attempts" && opts?.method === "POST") {
      const result = await onPost(opts.body as never);
      if (result instanceof Error) throw result;
      return result as never;
    }
    if (path === "/api/sessions/1/skills/attempts") return attempts as never;
    if (path === "/api/teams") return TEAMS as never;
    if (path === "/api/sessions/1/participants") return PARTICIPANTS as never;
    if (path.startsWith("/api/skills/types/")) return [SCORE] as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function SessionOutlet() {
  return <Outlet context={{ session: SESSION }} />;
}

function renderSkills() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: "/", element: <SessionOutlet />, children: [{ index: true, element: <SessionSkillsRoute /> }] },
  ]);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

const calls = (method: string, path: string) =>
  vi.mocked(apiRequest).mock.calls.filter(
    ([p, options]) => p === path && ((options as { method?: string })?.method ?? "GET") === method
  );

async function recordRegion() {
  return screen.findByRole("region", { name: "Record an attempt" });
}

async function pickTeam(region: HTMLElement, label: string) {
  fireEvent.click(await within(region).findByRole("option", { name: label }));
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
});

describe("SessionSkillsRoute", () => {
  it("says skills are off, with a link to Event Setup", async () => {
    stub({ enabled: false });
    renderSkills();
    expect(await screen.findByText("Skills challenges are turned off for this event.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Event Setup" })).toHaveAttribute("href", "/events/setup");
  });

  it("shows the attempts line from the event setting", async () => {
    stub();
    renderSkills();
    expect(await screen.findByText("Autonomous 3 · Driver 1 (event setting)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use event setting" })).not.toBeInTheDocument();
  });

  it("changes and clears the session override", async () => {
    stub({ override: { driver: 1 } });
    renderSkills();
    expect(await screen.findByText("Autonomous 3 · Driver 1 (this session)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use event setting" }));
    await waitFor(() => expect(calls("PUT", "/api/sessions/1/skills")).toHaveLength(1));
    expect(calls("PUT", "/api/sessions/1/skills")[0][1]).toEqual({ method: "PUT", body: { attempts: null } });

    fireEvent.click(await screen.findByRole("button", { name: "Change for this session" }));
    const autonomous = screen.getByLabelText("Autonomous attempts");
    expect(autonomous).toHaveValue("3");
    fireEvent.change(autonomous, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save for this session" }));
    expect(await screen.findByText("Enter a whole number from 1 to 20.")).toBeInTheDocument();
    expect(calls("PUT", "/api/sessions/1/skills")).toHaveLength(1);

    fireEvent.change(autonomous, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save for this session" }));
    await waitFor(() => expect(calls("PUT", "/api/sessions/1/skills")).toHaveLength(2));
    expect(calls("PUT", "/api/sessions/1/skills")[1][1]).toEqual({
      method: "PUT",
      body: { attempts: { autonomous: 2, driver: 1 } },
    });
  });

  it("offers only checked-in teams, matched by number or name", async () => {
    stub();
    renderSkills();
    const region = await recordRegion();
    expect(await within(region).findByRole("option", { name: "101 Alpha" })).toBeInTheDocument();
    expect(within(region).getByRole("option", { name: "202 Bravo" })).toBeInTheDocument();
    expect(within(region).queryByRole("option", { name: "303 Charlie" })).not.toBeInTheDocument();

    const search = within(region).getByRole("combobox", { name: "Team" });
    fireEvent.change(search, { target: { value: "brav" } });
    expect(within(region).getAllByRole("option").map((option) => option.textContent)).toEqual(["202 Bravo"]);
    fireEvent.change(search, { target: { value: "303" } });
    expect(within(region).getByText("No checked-in team matches.")).toBeInTheDocument();
  });

  it("records an attempt, says what it scored and resets the sheet", async () => {
    stub();
    renderSkills();
    const region = await recordRegion();
    await pickTeam(region, "101 Alpha");
    expect(within(region).getByText("Attempt 2 of 3")).toBeInTheDocument();

    const score = await within(region).findByLabelText("Score");
    fireEvent.change(score, { target: { value: "25" } });
    fireEvent.click(within(region).getByRole("button", { name: "Save attempt" }));

    expect(await within(region).findByText("Saved: 25 points")).toBeInTheDocument();
    expect(calls("POST", "/api/sessions/1/skills/attempts")[0][1]).toEqual({
      method: "POST",
      body: { team_id: 1, skills_type: "autonomous", data: { score: 25 } },
    });
    expect(within(region).getByLabelText("Score")).toHaveValue("0");
  });

  it("disables Save with the reason once a type's attempts are used up", async () => {
    stub();
    renderSkills();
    const region = await recordRegion();
    await pickTeam(region, "101 Alpha");
    fireEvent.click(within(region).getByRole("button", { name: "Driver" }));
    expect(within(region).getByText("Team 101 has used all 1 Driver attempts.")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Save attempt" })).toBeDisabled();
  });

  it("shows field violations beside the field and other errors above Save", async () => {
    let reply: unknown = new ApiError(422, "The scoresheet has errors.", {
      detail: "The scoresheet has errors.",
      violations: [{ field: "score", message: "Must be at most 999." }],
    });
    stub({ onPost: () => reply });
    renderSkills();
    const region = await recordRegion();
    await pickTeam(region, "202 Bravo");
    fireEvent.change(await within(region).findByLabelText("Score"), { target: { value: "1000" } });
    fireEvent.click(within(region).getByRole("button", { name: "Save attempt" }));

    expect(await within(region).findByText("Must be at most 999.")).toBeInTheDocument();
    expect(within(region).getByLabelText("Score")).toHaveAttribute("aria-invalid", "true");
    expect(within(region).queryByRole("alert")).not.toBeInTheDocument();

    reply = new ApiError(409, "Team 202 has used all 3 Autonomous attempts.");
    fireEvent.click(within(region).getByRole("button", { name: "Save attempt" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent("Team 202 has used all 3 Autonomous attempts.");
  });

  it("hides the type buttons when the game has one type", async () => {
    stub({ types: [{ key: "driver", label: "Driver", allowed: 3 }], attempts: [] });
    renderSkills();
    const region = await recordRegion();
    await pickTeam(region, "202 Bravo");
    expect(within(region).queryByRole("group", { name: "Skills type" })).not.toBeInTheDocument();
    expect(within(region).getByText("Attempt 1 of 3")).toBeInTheDocument();
  });

  it("posts once when Save is clicked twice quickly", async () => {
    stub({ onPost: () => new Promise(() => {}) });
    renderSkills();
    const region = await recordRegion();
    await pickTeam(region, "202 Bravo");
    await within(region).findByLabelText("Score");
    const save = within(region).getByRole("button", { name: "Save attempt" });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(calls("POST", "/api/sessions/1/skills/attempts")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls("POST", "/api/sessions/1/skills/attempts")).toHaveLength(1);
  });

  it("refetches this session's attempts on skills_changed from the active-session channel", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      if (options.path === "/ws/active-session") onEvent = options.onEvent;
      return { connected: true };
    });
    stub();
    renderSkills();
    await recordRegion();
    const fetches = () => calls("GET", "/api/sessions/1/skills/attempts").length;
    const before = fetches();

    act(() => onEvent?.({ event: "skills_changed", data: { session_id: 2 } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetches()).toBe(before);

    act(() => onEvent?.({ event: "skills_changed", data: { session_id: 1 } }));
    await waitFor(() => expect(fetches()).toBeGreaterThan(before));
  });
});
```

`apiRequest` is called as `apiRequest(path)` with no options for GETs. `calls("GET", ...)` treats a missing method as GET.

Extend `tests/unit/SessionDetailLayout.test.tsx` with:

```tsx
  it("shows the Skills tab between Matches and Rankings only while skills are on", async () => {
    let enabled = true;
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/sessions") return [SATURDAY] as never;
      if (path === "/api/event") return eventWithActiveSession(1) as never;
      if (path === "/api/skills/settings") return { enabled, attempts: {}, types: [] } as never;
      throw new Error(`unexpected request: ${path}`);
    });
    const { unmount } = renderAt("/sessions/1/checkin");
    const skills = await screen.findByRole("link", { name: "Skills" });
    expect(skills).toHaveAttribute("href", "/sessions/1/skills");
    const names = screen.getAllByRole("link").map((link) => link.textContent);
    expect(names.indexOf("Skills")).toBe(names.indexOf("Matches") + 1);
    expect(names.indexOf("Rankings")).toBe(names.indexOf("Skills") + 1);
    unmount();

    enabled = false;
    renderAt("/sessions/1/checkin");
    await screen.findByRole("heading", { name: "Saturday" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("link", { name: "Skills" })).not.toBeInTheDocument();
  });
```

`SATURDAY` and `eventWithActiveSession` are already defined in that file. Read them and use their exact names.

Run `cd frontend && npm test --workspace apps/admin -- --run recordForm SessionSkillsRoute SessionDetailLayout`. Expected: FAIL (modules missing, no Skills tab).

- [ ] **Step 4: Implement the data hooks and helpers.**

`src/skills/useSessionSkills.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiRequest, type ScoresheetField } from "@tournament-admin/shared";
import type { SessionSkillsRead, SkillsAttemptRead } from "../types";

export const sessionSkillsKey = (sessionId: number) => ["sessionSkills", sessionId];
export const skillsAttemptsKey = (sessionId: number) => ["skillsAttempts", sessionId];
export const skillsSchemaKey = (typeKey: string) => ["skillsSchema", typeKey];

/** The session's skills types with their effective allowed attempts, and its override. */
export function useSessionSkills(sessionId: number) {
  return useQuery({
    queryKey: sessionSkillsKey(sessionId),
    queryFn: () => apiRequest<SessionSkillsRead>(`/api/sessions/${sessionId}/skills`),
  });
}

/** Every attempt recorded in the session. */
export function useSkillsAttempts(sessionId: number) {
  return useQuery({
    queryKey: skillsAttemptsKey(sessionId),
    queryFn: () => apiRequest<SkillsAttemptRead[]>(`/api/sessions/${sessionId}/skills/attempts`),
  });
}

/** One type's scoresheet fields. A plugin can't change once chosen, so this never goes stale. */
export function useSkillsSchema(typeKey: string | null) {
  return useQuery({
    queryKey: skillsSchemaKey(typeKey ?? ""),
    queryFn: () => apiRequest<ScoresheetField[]>(`/api/skills/types/${typeKey}/schema`),
    enabled: typeKey !== null,
    staleTime: Infinity,
  });
}
```

`src/skills/liveUpdates.ts`:

```ts
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import { skillsAttemptsKey } from "./useSessionSkills";
import { SKILLS_SETTINGS_KEY } from "./useSkillsSettings";

/**
 * Every skills event reaches /ws/active-session: skills_changed always goes
 * there, and so does every skills_settings_changed. So skills UI listens on
 * that one channel, whichever session it shows.
 */
export function handleSkillsEvent(queryClient: QueryClient, realtimeEvent: RealtimeEvent): void {
  if (realtimeEvent.event === "skills_changed") {
    const data = realtimeEvent.data as { session_id?: unknown } | null;
    if (typeof data?.session_id === "number") {
      queryClient.invalidateQueries({ queryKey: skillsAttemptsKey(data.session_id) });
    }
    queryClient.invalidateQueries({ queryKey: ["skillsRankings"] });
  } else if (realtimeEvent.event === "skills_settings_changed") {
    queryClient.invalidateQueries({ queryKey: SKILLS_SETTINGS_KEY });
    queryClient.invalidateQueries({ queryKey: ["sessionSkills"] });
    queryClient.invalidateQueries({ queryKey: ["skillsRankings"] });
  }
}

export function useSkillsLiveUpdates(): void {
  const queryClient = useQueryClient();
  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (realtimeEvent: RealtimeEvent) => handleSkillsEvent(queryClient, realtimeEvent),
  });
}
```

`src/skills/scoresheetErrors.ts`:

```ts
import { ApiError } from "@tournament-admin/shared";

/** A 422's per-field violations as field -> message, or null for any other error. */
export function violationsByField(error: unknown): Record<string, string> | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  const violations = (error.body as { violations?: unknown } | null)?.violations;
  if (!Array.isArray(violations) || violations.length === 0) return null;
  const byField: Record<string, string> = {};
  for (const violation of violations as { field?: unknown; message?: unknown }[]) {
    if (typeof violation.field === "string" && typeof violation.message === "string" && !(violation.field in byField)) {
      byField[violation.field] = violation.message;
    }
  }
  return byField;
}
```

`src/skills/useScoresheetT.ts`:

```ts
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ScoresheetTranslate } from "@tournament-admin/shared";

/** The admin app's translations, in the shape the shared scoresheet wants. */
export function useScoresheetT(): ScoresheetTranslate {
  const { t } = useTranslation();
  return useCallback((key: string, options?: Record<string, unknown>) => String(t(key, options)), [t]);
}
```

If `tsc` rejects `t(key, options)` here, cast only the options (`options as never`). Change nothing else.

`src/skills/recordForm.ts`:

```ts
import type { SkillsAttemptRead, TeamSummary } from "../types";

export interface AttemptStatus {
  used: number;
  next: number;
  usedUp: boolean;
}

export function attemptStatus(
  attempts: SkillsAttemptRead[],
  teamId: number,
  typeKey: string,
  allowed: number
): AttemptStatus {
  const used = attempts.filter((a) => a.team_id === teamId && a.skills_type === typeKey).length;
  return { used, next: used + 1, usedUp: used >= allowed };
}

export function compareTeamNumbers(a: TeamSummary, b: TeamSummary): number {
  return a.number.localeCompare(b.number, undefined, { numeric: true });
}

/** Whether the team's number or name contains the text: trimmed, case-insensitive, literal. Blank matches all. */
export function teamMatches(team: TeamSummary, text: string): boolean {
  const needle = text.trim().toLowerCase();
  return !needle || team.number.toLowerCase().includes(needle) || team.name.toLowerCase().includes(needle);
}

export function matchTeams(teams: TeamSummary[], text: string): TeamSummary[] {
  return teams.filter((team) => teamMatches(team, text)).sort(compareTeamNumbers);
}
```

- [ ] **Step 5: Implement the components.**

`src/skills/TeamPicker.tsx`:

```tsx
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TeamSummary } from "../types";
import { matchTeams } from "./recordForm";

/** A searchable list of the session's checked-in teams, matched by number or name. */
export function TeamPicker({
  teams,
  selectedId,
  onSelect,
}: {
  teams: TeamSummary[];
  selectedId: number | null;
  onSelect: (teamId: number | null) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [text, setText] = useState("");
  const selected = teams.find((team) => team.id === selectedId) ?? null;

  if (selected) {
    return (
      <div className="field">
        <span className="field__label">{t("skills.record.teamLabel")}</span>
        <p className="team-picker__selected">
          <strong>{selected.number}</strong> {selected.name}{" "}
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setText("");
              onSelect(null);
            }}
          >
            {t("skills.record.changeTeam")}
          </button>
        </p>
      </div>
    );
  }

  const matches = matchTeams(teams, text);
  return (
    <div className="field team-picker">
      <label className="field__label" htmlFor={id}>
        {t("skills.record.teamLabel")}
      </label>
      <input
        id={id}
        className="input"
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        placeholder={t("skills.record.teamPlaceholder")}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <ul id={`${id}-list`} role="listbox" className="team-picker__list" aria-label={t("skills.record.teamLabel")}>
        {matches.map((team) => (
          <li
            key={team.id}
            role="option"
            aria-selected={false}
            tabIndex={0}
            onClick={() => onSelect(team.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(team.id);
              }
            }}
          >
            {team.number} {team.name}
          </li>
        ))}
      </ul>
      {matches.length === 0 && <p className="field__hint">{t("skills.record.noTeams")}</p>}
    </div>
  );
}
```

`src/skills/RecordAttemptForm.tsx`:

```tsx
import { useId, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, defaultValues, ScoresheetForm, type ScoresheetValues } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import type { SessionSkillsType, SkillsAttemptRead, TeamSummary } from "../types";
import { attemptStatus } from "./recordForm";
import { violationsByField } from "./scoresheetErrors";
import { TeamPicker } from "./TeamPicker";
import { skillsAttemptsKey, useSkillsSchema } from "./useSessionSkills";
import { useScoresheetT } from "./useScoresheetT";

interface RecordBody {
  team_id: number;
  skills_type: string;
  data: ScoresheetValues;
}

export function RecordAttemptForm({
  sessionId,
  types,
  teams,
  attempts,
}: {
  sessionId: number;
  types: SessionSkillsType[];
  /** The session's checked-in teams. */
  teams: TeamSummary[];
  attempts: SkillsAttemptRead[];
}) {
  const { t } = useTranslation();
  const scoresheetT = useScoresheetT();
  const queryClient = useQueryClient();
  const headingId = useId();
  const inFlight = useRef(false);
  const [teamId, setTeamId] = useState<number | null>(null);
  const [typeKey, setTypeKey] = useState<string | null>(types[0]?.key ?? null);
  const [values, setValues] = useState<ScoresheetValues | null>(null);
  const [savedScore, setSavedScore] = useState<number | null>(null);
  const type = types.find((candidate) => candidate.key === typeKey) ?? types[0] ?? null;
  const schema = useSkillsSchema(type?.key ?? null);
  const fields = schema.data ?? [];
  const current = values ?? defaultValues(fields);
  const team = teams.find((candidate) => candidate.id === teamId) ?? null;
  const status = team && type ? attemptStatus(attempts, team.id, type.key, type.allowed) : null;

  const mutation = useMutation({
    mutationFn: (body: RecordBody) =>
      apiRequest<SkillsAttemptRead>(`/api/sessions/${sessionId}/skills/attempts`, { method: "POST", body }),
    onSuccess: (saved) => {
      setSavedScore(saved.score);
      setValues(null);
      queryClient.invalidateQueries({ queryKey: skillsAttemptsKey(sessionId) });
      queryClient.invalidateQueries({ queryKey: ["skillsRankings"] });
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const fieldErrors = violationsByField(mutation.error);

  function resetFeedback() {
    setSavedScore(null);
    mutation.reset();
  }

  function save() {
    if (!team || !type || inFlight.current) return;
    inFlight.current = true;
    mutation.mutate({ team_id: team.id, skills_type: type.key, data: current });
  }

  const usedUpId = `${headingId}-used-up`;
  const canSave = team !== null && type !== null && schema.data !== undefined && status !== null && !status.usedUp;

  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("skills.record.heading")}</h2>
      <TeamPicker
        teams={teams}
        selectedId={teamId}
        onSelect={(id) => {
          setTeamId(id);
          resetFeedback();
        }}
      />
      {types.length > 1 && (
        <div className="skills-type-buttons" role="group" aria-label={t("skills.record.typeLegend")}>
          {types.map((candidate) => (
            <button
              key={candidate.key}
              type="button"
              className={candidate.key === type?.key ? "btn btn-primary" : "btn"}
              aria-pressed={candidate.key === type?.key}
              onClick={() => {
                setTypeKey(candidate.key);
                setValues(null);
                resetFeedback();
              }}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      )}
      {!team && <p className="field__hint">{t("skills.record.pickTeam")}</p>}
      {team && type && status && status.usedUp && (
        <p className="alert alert-warning" id={usedUpId}>
          {t("skills.record.usedUp", { number: team.number, n: type.allowed, label: type.label })}
        </p>
      )}
      {team && type && status && !status.usedUp && (
        <p className="skills-record__count">{t("skills.record.attemptCount", { n: status.next, allowed: type.allowed })}</p>
      )}
      {fields.length > 0 && (
        <ScoresheetForm
          fields={fields}
          values={current}
          errors={fieldErrors ?? {}}
          t={scoresheetT}
          idPrefix={`${headingId}-sheet`}
          onChange={(next) => {
            setValues(next);
            resetFeedback();
          }}
        />
      )}
      {mutation.isError && !fieldErrors && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(mutation.error, t("errors.generic"))}
        </p>
      )}
      {savedScore !== null && (
        <p className="alert alert-success" role="status">
          {t("skills.record.saved", { score: savedScore })}
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSave || mutation.isPending}
          aria-describedby={status?.usedUp ? usedUpId : undefined}
          onClick={save}
        >
          {t("skills.record.save")}
        </button>
      </div>
    </section>
  );
}
```

`src/skills/SessionAttemptsSettings.tsx`:

```tsx
import { useId, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import type { SessionSkillsRead } from "../types";
import { attemptsErrors, parseAttempts } from "./skillsSettingsDraft";
import { sessionSkillsKey } from "./useSessionSkills";

/** "Autonomous 3 · Driver 3 (event setting)", with Change for this session and Use event setting. */
export function SessionAttemptsSettings({ sessionId, skills }: { sessionId: number; skills: SessionSkillsRead }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const formId = useId();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [attempted, setAttempted] = useState(false);
  const mutation = useMutation({
    mutationFn: (attempts: Record<string, number> | null) =>
      apiRequest<SessionSkillsRead>(`/api/sessions/${sessionId}/skills`, { method: "PUT", body: { attempts } }),
    onSuccess: (saved) => {
      queryClient.setQueryData(sessionSkillsKey(sessionId), saved);
      queryClient.invalidateQueries({ queryKey: ["skillsRankings"] });
      setDraft(null);
    },
  });
  const entries = skills.types
    .map((type) => t("skills.page.attemptsEntry", { label: type.label, allowed: type.allowed }))
    .join(" · ");
  const source = t(skills.override ? "skills.page.sourceSession" : "skills.page.sourceEvent");
  const errors = draft ? attemptsErrors(draft) : new Set<string>();

  function startEditing() {
    setDraft(Object.fromEntries(skills.types.map((type) => [type.key, String(type.allowed)])));
    setAttempted(false);
    mutation.reset();
  }

  function onSubmit(submitEvent: FormEvent) {
    submitEvent.preventDefault();
    setAttempted(true);
    const parsed = draft ? parseAttempts(draft) : null;
    if (parsed) mutation.mutate(parsed);
  }

  return (
    <section className="skills-attempts-line" aria-label={t("skills.page.attemptsHeading")}>
      <p>{t("skills.page.attemptsLine", { entries, source })}</p>
      {draft === null ? (
        <>
          <button type="button" className="btn btn-small" onClick={startEditing}>
            {t("skills.page.change")}
          </button>
          {skills.override && (
            <button
              type="button"
              className="btn btn-small"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(null)}
            >
              {t("skills.page.useEvent")}
            </button>
          )}
        </>
      ) : (
        <form className="skills-override" onSubmit={onSubmit} noValidate>
          <fieldset className="settings-group">
            <legend>{t("skills.page.overrideLegend")}</legend>
            {skills.types.map((type) => {
              const inputId = `${formId}-${type.key}`;
              const invalid = attempted && errors.has(type.key);
              return (
                <div className="field" key={type.key}>
                  <label className="field__label" htmlFor={inputId}>
                    {t("skills.settings.attemptsLabel", { label: type.label })}
                  </label>
                  <input
                    id={inputId}
                    className="input settings-number"
                    inputMode="numeric"
                    value={draft[type.key] ?? ""}
                    aria-invalid={invalid ? true : undefined}
                    aria-describedby={invalid ? `${inputId}-error` : undefined}
                    onChange={(changeEvent) => {
                      setDraft({ ...draft, [type.key]: changeEvent.target.value });
                      mutation.reset();
                    }}
                  />
                  {invalid && (
                    <p className="field__hint field__error" id={`${inputId}-error`}>
                      {t("skills.settings.attemptsError")}
                    </p>
                  )}
                </div>
              );
            })}
          </fieldset>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
              {t("skills.page.overrideSave")}
            </button>
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              {t("skills.page.overrideCancel")}
            </button>
          </div>
        </form>
      )}
      {mutation.isError && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(mutation.error, t("errors.generic"))}
        </p>
      )}
    </section>
  );
}
```

`src/routes/SessionSkillsRoute.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useOutletContext } from "react-router-dom";
import { apiRequest } from "@tournament-admin/shared";
import { RecordAttemptForm } from "../skills/RecordAttemptForm";
import { SessionAttemptsSettings } from "../skills/SessionAttemptsSettings";
import { useSkillsLiveUpdates } from "../skills/liveUpdates";
import { useSessionSkills, useSkillsAttempts } from "../skills/useSessionSkills";
import { useSkillsSettings } from "../skills/useSkillsSettings";
import type { ParticipationRead, SessionRead, TeamSummary } from "../types";

export function SessionSkillsRoute() {
  const { t } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  useSkillsLiveUpdates();
  const settings = useSkillsSettings();
  const sessionSkills = useSessionSkills(session.id);
  const attempts = useSkillsAttempts(session.id);
  const teams = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamSummary[]>("/api/teams"),
  });
  // Same key the Check-In tab writes, so a check-in made there shows here at once.
  const participants = useQuery({
    queryKey: ["participants", session.id],
    queryFn: () => apiRequest<ParticipationRead[]>(`/api/sessions/${session.id}/participants`),
  });

  if (settings.isLoading) return <p>{t("skills.page.loading")}</p>;
  if (settings.isError) {
    return (
      <p className="alert alert-danger" role="alert">
        {t("errors.generic")}
      </p>
    );
  }
  if (!settings.data?.enabled) {
    return (
      <p className="alert alert-warning">
        {t("skills.page.off")} <Link to="/events/setup">{t("skills.page.offLink")}</Link>
      </p>
    );
  }
  const queries = [sessionSkills, attempts, teams, participants];
  if (queries.some((query) => query.isError)) {
    return (
      <p className="alert alert-danger" role="alert">
        {t("errors.generic")}
      </p>
    );
  }
  if (!sessionSkills.data || !attempts.data || !teams.data || !participants.data) {
    return <p>{t("skills.page.loading")}</p>;
  }
  const checkedInIds = new Set(participants.data.filter((row) => row.checked_in).map((row) => row.team_id));
  const checkedIn = teams.data.filter((team) => checkedInIds.has(team.id));

  return (
    <div className="skills-page">
      <SessionAttemptsSettings sessionId={session.id} skills={sessionSkills.data} />
      <RecordAttemptForm
        sessionId={session.id}
        types={sessionSkills.data.types}
        teams={checkedIn}
        attempts={attempts.data}
      />
    </div>
  );
}
```

- [ ] **Step 6: Route and tab.**
- In `router.tsx`, import `SessionSkillsRoute`. Add `{ path: "skills", element: <SessionSkillsRoute /> }` to the session children, between `matches` and `rankings`.
- In `SessionDetailLayout.tsx`:
  - Import `useSkillsSettings` from `"../skills/useSkillsSettings"`.
  - Call `const skills = useSkillsSettings();` next to the other queries, before any early return.
  - Between the Matches and Rankings `NavLink`s, add:

```tsx
        {skills.data?.enabled && (
          <NavLink to={`/sessions/${session.id}/skills`} className={tabLinkClassName}>
            {t("sessions.skillsTab")}
          </NavLink>
        )}
```

- [ ] **Step 7: Styles.** Append to `src/styles/components.css`, using only existing tokens:

```css
.scoresheet { display: grid; gap: var(--space-3); margin-block: var(--space-3); }
.scoresheet__label { display: inline-flex; align-items: center; gap: var(--space-2); font-weight: 600; }
.scoresheet__icon { font-size: var(--text-lg); }
.scoresheet__counter { display: inline-flex; align-items: center; gap: var(--space-2); }
.scoresheet__count { width: 6ch; text-align: center; }
.scoresheet__radio { border: 0; margin: 0; padding: 0; }
.skills-attempts-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); margin-block-end: var(--space-4); }
.skills-attempts-line > p { margin: 0; }
.skills-type-buttons { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-block: var(--space-3); }
.team-picker__list { list-style: none; margin: var(--space-2) 0 0; padding: 0; max-height: 12rem; overflow-y: auto; border: var(--border-width) solid var(--color-border); border-radius: var(--radius-sm); }
.team-picker__list [role="option"] { padding: var(--space-2) var(--space-3); cursor: pointer; }
.team-picker__list [role="option"]:hover,
.team-picker__list [role="option"]:focus-visible { background: var(--color-bg-sunken); }
.team-picker__selected { display: flex; align-items: center; gap: var(--space-2); margin: 0; }
```

- [ ] **Step 8: Run the frontend checks.** `cd frontend && npm test --workspace apps/admin -- --run && npx tsc -b apps/admin`. Expected: all pass and tsc is clean. Existing `SessionDetailLayout` tests that stub no `/api/skills/settings` still pass, because a failed settings query just hides the tab.

- [ ] **Step 9: Commit.**

```bash
git add frontend/apps/admin/src frontend/apps/admin/tests/unit
git commit -m "Add the session Skills page with attempt recording and a session override

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Attempts table with team filter, edit and delete

**Files:**
- Create: `frontend/apps/admin/src/skills/attemptsTable.ts`
- Create: `frontend/apps/admin/src/skills/AttemptsTable.tsx`
- Create: `frontend/apps/admin/src/skills/EditAttemptDialog.tsx`
- Modify: `frontend/apps/admin/src/routes/SessionSkillsRoute.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json`
- Modify: `frontend/apps/admin/src/styles/components.css`
- Test: `frontend/apps/admin/tests/unit/attemptsTable.test.ts`, `frontend/apps/admin/tests/unit/AttemptsTable.test.tsx`

**Interfaces:**
- Consumes:
  - Task 5's `PUT/DELETE /api/skills/attempts/{id}`.
  - Task 9's `skillsAttemptsKey`, `useSkillsSchema`, `violationsByField`, `useScoresheetT`, `compareTeamNumbers` and `teamMatches`.
  - The existing `Modal` and `ConfirmDialog`.
- Produces:
  - `buildAttemptRows(attempts, teams, types): AttemptRow[]`
  - `filterAttemptRows(rows, text): AttemptRow[]`
  - `AttemptsTable({ sessionId, types, attempts, teams })`
  - `EditAttemptDialog({ sessionId, attempt, type, teamNumber, onClose })`
  - i18n keys `skills.table.*` and `skills.edit.*`.

- [ ] **Step 1: Add the i18n strings.** Inside `skills` in `en/admin.json`:

```json
"table": {
  "heading": "Attempts",
  "filterLabel": "Find team",
  "noMatch": "No teams match '{{text}}'",
  "empty": "No attempts recorded in this session yet.",
  "columnTeam": "Team",
  "columnOverall": "Overall",
  "editAttempt": "Edit {{label}} attempt {{n}} for team {{number}}: {{score}} points",
  "emptySlot": "—"
},
"edit": {
  "heading": "{{label}} attempt {{n}} · Team {{number}}",
  "save": "Save",
  "cancel": "Cancel",
  "delete": "Delete attempt",
  "deleteHeading": "Delete this attempt?",
  "deleteBody": "Team {{number}} gets this {{label}} attempt back.",
  "deleteConfirm": "Delete attempt",
  "deleteCancel": "Keep attempt"
}
```

and in `zh/admin.json`:

```json
"table": {
  "heading": "尝试记录",
  "filterLabel": "查找队伍",
  "noMatch": "没有队伍匹配“{{text}}”",
  "empty": "本场次尚未记录任何尝试。",
  "columnTeam": "队伍",
  "columnOverall": "总分",
  "editAttempt": "编辑 {{number}} 队第 {{n}} 次{{label}}尝试：{{score}} 分",
  "emptySlot": "—"
},
"edit": {
  "heading": "{{number}} 队 · 第 {{n}} 次{{label}}尝试",
  "save": "保存",
  "cancel": "取消",
  "delete": "删除尝试",
  "deleteHeading": "删除这次尝试？",
  "deleteBody": "{{number}} 队将重新获得这次{{label}}尝试。",
  "deleteConfirm": "删除尝试",
  "deleteCancel": "保留尝试"
}
```

- [ ] **Step 2: Write the failing pure test.** Create `tests/unit/attemptsTable.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAttemptRows, filterAttemptRows } from "../../src/skills/attemptsTable";
import type { SessionSkillsType, SkillsAttemptRead, TeamSummary } from "../../src/types";

const TYPES: SessionSkillsType[] = [
  { key: "autonomous", label: "Autonomous", allowed: 3 },
  { key: "driver", label: "Driver", allowed: 2 },
];
const TEAMS: TeamSummary[] = [
  { id: 1, number: "10", name: "Alpha", division_id: null },
  { id: 2, number: "9", name: "Bots (East)", division_id: null },
  { id: 3, number: "S1", name: "Skills One", division_id: null },
];

function attempt(id: number, team_id: number, skills_type: string, number: number, score: number): SkillsAttemptRead {
  return { id, team_id, skills_type, number, score, data: {}, recorded_at: "", updated_at: "" };
}

const ATTEMPTS = [
  attempt(1, 1, "autonomous", 1, 20),
  attempt(2, 1, "autonomous", 2, 28),
  attempt(3, 1, "driver", 1, 30),
  attempt(4, 2, "driver", 1, 15),
  attempt(5, 2, "driver", 2, 18),
  attempt(6, 2, "driver", 3, 12), // more than allowed after the limit was lowered: still shown
  attempt(7, 99, "driver", 1, 50), // unknown team: skipped
];

describe("buildAttemptRows", () => {
  const rows = buildAttemptRows(ATTEMPTS, TEAMS, TYPES);

  it("has one row per team with attempts, by team number", () => {
    expect(rows.map((row) => row.team.number)).toEqual(["9", "10"]);
  });

  it("lists each type's attempts in order, padded to the allowed count", () => {
    const ten = rows[1];
    expect(ten.byType.autonomous.map((a) => a?.score ?? null)).toEqual([20, 28, null]);
    expect(ten.byType.driver.map((a) => a?.score ?? null)).toEqual([30, null]);
    expect(rows[0].byType.autonomous).toEqual([null, null, null]);
    expect(rows[0].byType.driver.map((a) => a?.score ?? null)).toEqual([15, 18, 12]);
  });

  it("adds each type's best for the Overall", () => {
    expect(rows[1].overall).toBe(58);
    expect(rows[0].overall).toBe(18);
  });
});

describe("filterAttemptRows", () => {
  const rows = buildAttemptRows(
    [...ATTEMPTS, attempt(8, 3, "driver", 1, 5)],
    TEAMS,
    TYPES
  );

  it("matches number or name, trimmed and case-insensitive", () => {
    expect(filterAttemptRows(rows, "  s1 ").map((row) => row.team.number)).toEqual(["S1"]);
    expect(filterAttemptRows(rows, "ALPHA").map((row) => row.team.number)).toEqual(["10"]);
    expect(filterAttemptRows(rows, "").map((row) => row.team.number)).toEqual(["9", "10", "S1"]);
  });

  it("treats regex characters literally", () => {
    expect(filterAttemptRows(rows, "(").map((row) => row.team.number)).toEqual(["9"]);
    expect(filterAttemptRows(rows, ".*")).toEqual([]);
  });
});
```

- [ ] **Step 3: Write the failing component test.** Create `tests/unit/AttemptsTable.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n, type ScoresheetField } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { AttemptsTable } from "../../src/skills/AttemptsTable";
import type { SessionSkillsType, SkillsAttemptRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest, ApiError } from "@tournament-admin/shared";

const TYPES: SessionSkillsType[] = [
  { key: "autonomous", label: "Autonomous", allowed: 3 },
  { key: "driver", label: "Driver", allowed: 3 },
];
const TEAMS = [
  { id: 1, number: "101", name: "Alpha", division_id: null },
  { id: 2, number: "202", name: "Bravo", division_id: null },
];
const SCORE: ScoresheetField = {
  name: "score", label: "Score", data_type: "integer", widget: "counter",
  min: 0, max: 999, step: 1, options: null, icon: null, scope: "team", default: 0,
};

function attempt(id: number, team_id: number, skills_type: string, number: number, score: number): SkillsAttemptRead {
  return { id, team_id, skills_type, number, score, data: { score }, recorded_at: "", updated_at: "" };
}

const ATTEMPTS = [attempt(1, 1, "autonomous", 1, 20), attempt(2, 1, "driver", 1, 34), attempt(3, 2, "driver", 1, 30)];

function stub(onPut: (body: unknown) => unknown = () => attempt(1, 1, "autonomous", 1, 30)) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = options as { method?: string; body?: unknown } | undefined;
    if (path.startsWith("/api/skills/types/")) return [SCORE] as never;
    if (path === "/api/skills/attempts/1" && opts?.method === "PUT") {
      const result = onPut(opts.body);
      if (result instanceof Error) throw result;
      return result as never;
    }
    if (path === "/api/skills/attempts/1" && opts?.method === "DELETE") return undefined as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function renderTable() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <AttemptsTable sessionId={1} types={TYPES} attempts={ATTEMPTS} teams={TEAMS} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

const requests = (method: string) =>
  vi.mocked(apiRequest).mock.calls.filter(([, options]) => (options as { method?: string })?.method === method);

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

describe("AttemptsTable", () => {
  it("shows each team's attempts per type, padded, with the Overall", () => {
    stub();
    renderTable();
    const alpha = screen.getByRole("row", { name: /101/ });
    const cells = within(alpha).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("20 · — · —");
    expect(cells[2]).toHaveTextContent("34 · — · —");
    expect(cells[3]).toHaveTextContent("54");
  });

  it("filters rows as you type and says when nothing matches", () => {
    stub();
    renderTable();
    const filter = screen.getByLabelText("Find team");
    fireEvent.change(filter, { target: { value: "brav" } });
    expect(screen.queryByRole("row", { name: /101/ })).not.toBeInTheDocument();
    expect(screen.getByRole("row", { name: /202/ })).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "zz" } });
    expect(screen.getByText("No teams match 'zz'")).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "" } });
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("edits an attempt in a pre-filled dialog", async () => {
    stub();
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: "Edit Autonomous attempt 1 for team 101: 20 points" }));
    const dialog = screen.getByRole("alertdialog", { name: "Autonomous attempt 1 · Team 101" });
    const score = await within(dialog).findByLabelText("Score");
    expect(score).toHaveValue("20");
    fireEvent.change(score, { target: { value: "30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(requests("PUT")[0]).toEqual(["/api/skills/attempts/1", { method: "PUT", body: { data: { score: 30 } } }]);
  });

  it("shows an edit's field violations beside the field", async () => {
    stub(
      () =>
        new ApiError(422, "The scoresheet has errors.", {
          violations: [{ field: "score", message: "Must be at most 999." }],
        })
    );
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: "Edit Autonomous attempt 1 for team 101: 20 points" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.change(await within(dialog).findByLabelText("Score"), { target: { value: "1000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Must be at most 999.")).toBeInTheDocument();
  });

  it("deletes an attempt after confirming, and Cancel sends nothing", async () => {
    stub();
    renderTable();
    const edit = () =>
      fireEvent.click(screen.getByRole("button", { name: "Edit Autonomous attempt 1 for team 101: 20 points" }));

    edit();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    edit();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete attempt" }));
    const confirm = screen.getByRole("alertdialog", { name: "Delete this attempt?" });
    expect(within(confirm).getByText("Team 101 gets this Autonomous attempt back.")).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete attempt" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(requests("DELETE")).toEqual([["/api/skills/attempts/1", { method: "DELETE" }]]);
    expect(requests("PUT")).toHaveLength(0);
  });
});
```

Run `cd frontend && npm test --workspace apps/admin -- --run attemptsTable AttemptsTable`. Expected: FAIL (modules missing).

- [ ] **Step 4: Implement the rows.** Create `src/skills/attemptsTable.ts`:

```ts
import type { SessionSkillsType, SkillsAttemptRead, TeamSummary } from "../types";
import { compareTeamNumbers, teamMatches } from "./recordForm";

export interface AttemptRow {
  team: TeamSummary;
  /** Type key -> attempts by number, padded with null up to the allowed count. */
  byType: Record<string, (SkillsAttemptRead | null)[]>;
  /** The session Overall: the sum of each type's best. */
  overall: number;
}

/** One row per team with at least one attempt, by team number. Attempts for unknown teams are skipped. */
export function buildAttemptRows(
  attempts: SkillsAttemptRead[],
  teams: TeamSummary[],
  types: SessionSkillsType[]
): AttemptRow[] {
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const byTeam = new Map<number, SkillsAttemptRead[]>();
  for (const attempt of attempts) {
    byTeam.set(attempt.team_id, [...(byTeam.get(attempt.team_id) ?? []), attempt]);
  }
  const rows: AttemptRow[] = [];
  for (const [teamId, teamAttempts] of byTeam) {
    const team = teamById.get(teamId);
    if (!team) continue;
    const byType: AttemptRow["byType"] = {};
    let overall = 0;
    for (const type of types) {
      const ofType = teamAttempts.filter((a) => a.skills_type === type.key).sort((a, b) => a.number - b.number);
      const padded: (SkillsAttemptRead | null)[] = [...ofType];
      while (padded.length < type.allowed) padded.push(null);
      byType[type.key] = padded;
      if (ofType.length > 0) overall += Math.max(...ofType.map((a) => a.score));
    }
    rows.push({ team, byType, overall });
  }
  return rows.sort((a, b) => compareTeamNumbers(a.team, b.team));
}

export function filterAttemptRows(rows: AttemptRow[], text: string): AttemptRow[] {
  return rows.filter((row) => teamMatches(row.team, text));
}
```

- [ ] **Step 5: Implement the dialog.** Create `src/skills/EditAttemptDialog.tsx`:

```tsx
import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, ScoresheetForm, type ScoresheetValues } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import type { SkillsAttemptRead, SkillsType } from "../types";
import { violationsByField } from "./scoresheetErrors";
import { skillsAttemptsKey, useSkillsSchema } from "./useSessionSkills";
import { useScoresheetT } from "./useScoresheetT";

/** An admin's correction: the attempt's scoresheet pre-filled, with Save, Cancel and Delete attempt. */
export function EditAttemptDialog({
  sessionId,
  attempt,
  type,
  teamNumber,
  onClose,
}: {
  sessionId: number;
  attempt: SkillsAttemptRead;
  type: SkillsType;
  teamNumber: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const scoresheetT = useScoresheetT();
  const queryClient = useQueryClient();
  const headingId = useId();
  const schema = useSkillsSchema(attempt.skills_type);
  const [values, setValues] = useState<ScoresheetValues>(attempt.data);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function refreshAndClose() {
    queryClient.invalidateQueries({ queryKey: skillsAttemptsKey(sessionId) });
    queryClient.invalidateQueries({ queryKey: ["skillsRankings"] });
    onClose();
  }

  const save = useMutation({
    mutationFn: (data: ScoresheetValues) =>
      apiRequest<SkillsAttemptRead>(`/api/skills/attempts/${attempt.id}`, { method: "PUT", body: { data } }),
    onSuccess: refreshAndClose,
  });
  const remove = useMutation({
    mutationFn: () => apiRequest<void>(`/api/skills/attempts/${attempt.id}`, { method: "DELETE" }),
    onSuccess: refreshAndClose,
  });
  const fieldErrors = violationsByField(save.error);

  if (confirmingDelete) {
    return (
      <ConfirmDialog
        heading={t("skills.edit.deleteHeading")}
        body={t("skills.edit.deleteBody", { number: teamNumber, label: type.label })}
        confirmLabel={t("skills.edit.deleteConfirm")}
        cancelLabel={t("skills.edit.deleteCancel")}
        isPending={remove.isPending}
        error={remove.isError ? apiErrorMessage(remove.error, t("errors.generic")) : null}
        onConfirm={() => remove.mutate()}
        onCancel={() => {
          remove.reset();
          setConfirmingDelete(false);
        }}
      />
    );
  }

  return (
    <Modal labelledBy={headingId} onCancel={onClose}>
      <h2 id={headingId}>{t("skills.edit.heading", { label: type.label, n: attempt.number, number: teamNumber })}</h2>
      {schema.data ? (
        <ScoresheetForm
          fields={schema.data}
          values={values}
          errors={fieldErrors ?? {}}
          t={scoresheetT}
          idPrefix={`${headingId}-sheet`}
          onChange={(next) => {
            setValues(next);
            save.reset();
          }}
        />
      ) : (
        <p>{t("skills.page.loading")}</p>
      )}
      {save.isError && !fieldErrors && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(save.error, t("errors.generic"))}
        </p>
      )}
      <div className="dialog__actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!schema.data || save.isPending}
          onClick={() => save.mutate(values)}
        >
          {t("skills.edit.save")}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          {t("skills.edit.cancel")}
        </button>
        <button type="button" className="btn btn-danger" onClick={() => setConfirmingDelete(true)}>
          {t("skills.edit.delete")}
        </button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 6: Implement the table.** Create `src/skills/AttemptsTable.tsx`:

```tsx
import { Fragment, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSkillsType, SkillsAttemptRead, TeamSummary } from "../types";
import { buildAttemptRows, filterAttemptRows } from "./attemptsTable";
import { EditAttemptDialog } from "./EditAttemptDialog";

export function AttemptsTable({
  sessionId,
  types,
  attempts,
  teams,
}: {
  sessionId: number;
  types: SessionSkillsType[];
  attempts: SkillsAttemptRead[];
  /** Every team (not just checked-in ones): a team may have been un-checked-in after recording. */
  teams: TeamSummary[];
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const filterId = useId();
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<SkillsAttemptRead | null>(null);
  const rows = useMemo(() => buildAttemptRows(attempts, teams, types), [attempts, teams, types]);
  const visible = filterAttemptRows(rows, filter);
  const editingType = editing ? types.find((type) => type.key === editing.skills_type) : undefined;
  const editingTeam = editing ? teams.find((team) => team.id === editing.team_id) : undefined;

  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("skills.table.heading")}</h2>
      <div className="field">
        <label className="field__label" htmlFor={filterId}>
          {t("skills.table.filterLabel")}
        </label>
        <input
          id={filterId}
          className="input"
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      {rows.length === 0 ? (
        <p className="table__empty">{t("skills.table.empty")}</p>
      ) : visible.length === 0 ? (
        <p className="table__empty">{t("skills.table.noMatch", { text: filter.trim() })}</p>
      ) : (
        <div className="table-wrap">
          <table className="table" aria-labelledby={headingId}>
            <thead>
              <tr>
                <th>{t("skills.table.columnTeam")}</th>
                {types.map((type) => (
                  <th key={type.key}>{type.label}</th>
                ))}
                <th className="table__num">{t("skills.table.columnOverall")}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.team.id}>
                  <td>
                    {row.team.number} <span className="table__secondary">{row.team.name}</span>
                  </td>
                  {types.map((type) => (
                    <td key={type.key} className="skills-attempts__cell">
                      {row.byType[type.key].map((attempt, index) => (
                        <Fragment key={attempt?.id ?? `empty-${index}`}>
                          {index > 0 && <span aria-hidden="true"> · </span>}
                          {attempt ? (
                            <button
                              type="button"
                              className="btn-link"
                              aria-label={t("skills.table.editAttempt", {
                                label: type.label,
                                n: attempt.number,
                                number: row.team.number,
                                score: attempt.score,
                              })}
                              onClick={() => setEditing(attempt)}
                            >
                              {attempt.score}
                            </button>
                          ) : (
                            <span>{t("skills.table.emptySlot")}</span>
                          )}
                        </Fragment>
                      ))}
                    </td>
                  ))}
                  <td className="table__num">{row.overall}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && editingType && editingTeam && (
        <EditAttemptDialog
          key={editing.id}
          sessionId={sessionId}
          attempt={editing}
          type={editingType}
          teamNumber={editingTeam.number}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
```

The filter lives in this component's state, so a live refetch (new `attempts` prop) keeps the typed text. In `AttemptsTable.test.tsx`, `screen.getAllByRole("row")` counts the header row plus two body rows, which gives 3.

- [ ] **Step 7: Wire the page.** In `SessionSkillsRoute.tsx`, import `AttemptsTable` and render it after `RecordAttemptForm`:

```tsx
      <AttemptsTable
        sessionId={session.id}
        types={sessionSkills.data.types}
        attempts={attempts.data}
        teams={teams.data}
      />
```

Append to `components.css`: `.skills-attempts__cell { white-space: nowrap; }`.

- [ ] **Step 8: Run the frontend checks.** `cd frontend && npm test --workspace apps/admin -- --run && npx tsc -b apps/admin`. Expected: all pass, including the Task 9 route tests. They scope their queries to the "Record an attempt" region, so the table's buttons don't collide.

- [ ] **Step 9: Commit.**

```bash
git add frontend/apps/admin/src frontend/apps/admin/tests/unit
git commit -m "List a session's skills attempts with a team filter and admin edit and delete

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: Skills tabs on Session and Season Rankings

**Files:**
- Create: `frontend/apps/admin/src/rankings/RankingTabs.tsx`
- Create: `frontend/apps/admin/src/skills/useSkillsRankings.ts`
- Create: `frontend/apps/admin/src/skills/skillsRules.ts`
- Create: `frontend/apps/admin/src/skills/SkillsRankingsPanel.tsx`
- Modify: `frontend/apps/admin/src/routes/SessionRankingsRoute.tsx`, `frontend/apps/admin/src/routes/SeasonRankingsRoute.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json`
- Test: `frontend/apps/admin/tests/unit/skillsRules.test.ts`; extend `frontend/apps/admin/tests/unit/SessionRankingsRoute.test.tsx` and `frontend/apps/admin/tests/unit/SeasonRankingsRoute.test.tsx`
- Docs: `frontend/CLAUDE.md`

**Interfaces:**
- Consumes:
  - Task 6's `GET /api/skills/rankings`.
  - Task 8's `useSkillsSettings` and `SkillsRankingRead`.
  - Task 9's `useSkillsLiveUpdates`, `handleSkillsEvent` and the `["skillsRankings"]` prefix.
- Produces:
  - `RankingTabs({ tabs, selected, onSelect, label, idPrefix })`
  - `useRankingTabs(): { tabs, selected, select, types }`
  - `TEAMWORK_TAB = "teamwork"`, `skillsTabId(tab)` and `skillsTabOf(tabId): string | null`
  - `skillsRankingsKey(scope, tab) = ["skillsRankings", sessionId | "season", tab]`
  - `skillsRankingsPath(scope, tab)`
  - `skillsRuleSentence(t, tab, types, season)`
  - `SkillsRankingsPanel({ scope, tab, types })`
  - i18n keys `skills.rankings.*`.

- [ ] **Step 1: Add the i18n strings.** Inside `skills` in `en/admin.json`:

```json
"rankings": {
  "overallTab": "Overall Skills",
  "loading": "Loading skills rankings...",
  "empty": "No skills attempts recorded yet.",
  "columnAttempts": "Attempts",
  "columnSession": "From session",
  "overallRule": "Sum of each team's best attempt in each type in one session. Ties go to the higher {{bests}}, then the higher second-best attempts, and so on.",
  "typeBest": "{{label}} best",
  "bestsJoin": ", then ",
  "typeRule": "Each team's best {{label}} attempt. Ties go to the higher second-best attempt, and so on.",
  "seasonRule": "Season scores come from the team's best session."
}
```

and in `zh/admin.json`:

```json
"rankings": {
  "overallTab": "技能赛总分",
  "loading": "正在加载技能赛排名...",
  "empty": "尚未记录任何技能赛尝试。",
  "columnAttempts": "尝试",
  "columnSession": "来自场次",
  "overallRule": "每支队伍在同一场次中各类型最佳尝试之和。平分时依次比较{{bests}}，再比较第二佳尝试之和，依此类推。",
  "typeBest": "{{label}}最佳成绩",
  "bestsJoin": "、",
  "typeRule": "每支队伍的最佳{{label}}尝试。平分时比较第二佳尝试，依此类推。",
  "seasonRule": "赛季成绩取自该队最佳的一个场次。"
}
```

- [ ] **Step 2: Write the failing tests.** Create `tests/unit/skillsRules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { skillsRuleSentence } from "../../src/skills/skillsRules";

const t = initI18n({ en: { translation: enAdmin } }).t;
const TYPES = [
  { key: "autonomous", label: "Autonomous" },
  { key: "driver", label: "Driver" },
];

describe("skillsRuleSentence", () => {
  it("explains Overall with the types in priority order", () => {
    expect(skillsRuleSentence(t, "overall", TYPES, false)).toBe(
      "Sum of each team's best attempt in each type in one session. Ties go to the higher Autonomous best, then Driver best, then the higher second-best attempts, and so on."
    );
  });

  it("explains a type tab", () => {
    expect(skillsRuleSentence(t, "driver", TYPES, false)).toBe(
      "Each team's best Driver attempt. Ties go to the higher second-best attempt, and so on."
    );
  });

  it("adds the season sentence on the season page", () => {
    expect(skillsRuleSentence(t, "driver", TYPES, true)).toBe(
      "Each team's best Driver attempt. Ties go to the higher second-best attempt, and so on. Season scores come from the team's best session."
    );
  });
});
```

In `tests/unit/SessionRankingsRoute.test.tsx`:

Replace the `stub` function with this version. Its two new options default to skills being off, so the existing tests are unchanged:

```tsx
const SKILL_TYPES = [
  { key: "autonomous", label: "Autonomous" },
  { key: "driver", label: "Driver" },
];

function stub({
  gameModel = "cooperative_score",
  divisions = [],
  rankings = {},
  skillsEnabled = false,
  skillsRankings = {},
}: {
  gameModel?: GameModel;
  divisions?: Division[];
  rankings?: Record<string, RankingRead[]>;
  skillsEnabled?: boolean;
  skillsRankings?: Record<string, SkillsRankingRead[]>;
}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string) => {
    if (path === "/api/ranking-settings") return settings(gameModel) as never;
    if (path === "/api/divisions") return divisions as never;
    if (path === "/api/teams") return TEAMS as never;
    if (path === "/api/skills/settings") {
      return { enabled: skillsEnabled, attempts: { autonomous: 3, driver: 3 }, types: SKILL_TYPES } as never;
    }
    if (path.startsWith("/api/skills/rankings?")) return (skillsRankings[path] ?? []) as never;
    if (path in rankings) return rankings[path] as never;
    if (path.startsWith("/api/rankings?")) return [] as never;
    throw new Error(`unexpected request: ${path}`);
  });
}
```

Add `SkillsRankingRead` to the `types` import.

In the existing test "refetches when the session channel reports a ranking update", replace the `mockImplementation` with:

```tsx
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      if (options.path === "/ws/session/1") onEvent = options.onEvent;
      return { connected: true };
    });
```

The page now also opens `/ws/active-session` for skills, and that channel's handler must not overwrite the one under test.

Append:

```tsx
  it("shows only the Teamwork tab while skills are off", async () => {
    stub({ rankings: { "/api/rankings?session_id=1": [ranking(1, 1)] } });
    renderRankings();
    await screen.findByRole("row", { name: /Alpha/ });
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/skills/settings"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Teamwork"]);
  });

  it("adds a tab per skills type and Overall Skills, and shows a skills table", async () => {
    stub({
      skillsEnabled: true,
      skillsRankings: {
        "/api/skills/rankings?tab=overall&session_id=1": [
          { rank: 1, team_id: 2, score: 58, attempts: [28, 30], session_id: 1 },
          { rank: 2, team_id: 1, score: 54, attempts: [20, 34], session_id: 1 },
        ],
      },
    });
    renderRankings();
    await screen.findByRole("tab", { name: "Overall Skills" });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Teamwork",
      "Autonomous",
      "Driver",
      "Overall Skills",
    ]);

    fireEvent.click(screen.getByRole("tab", { name: "Overall Skills" }));
    expect(screen.getByRole("tab", { name: "Overall Skills" })).toHaveAttribute("aria-selected", "true");
    const table = await screen.findByRole("table", { name: "Overall Skills" });
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("202");
    expect(rows[1]).toHaveTextContent("58");
    expect(rows[1]).toHaveTextContent("28 · 30");
    expect(within(table).queryByRole("columnheader", { name: "From session" })).not.toBeInTheDocument();
    expect(screen.getByText(/^Sum of each team's best attempt/)).toBeInTheDocument();
  });

  it("shows the empty state on a skills tab with no attempts", async () => {
    stub({ skillsEnabled: true });
    renderRankings();
    fireEvent.click(await screen.findByRole("tab", { name: "Driver" }));
    expect(await screen.findByText("No skills attempts recorded yet.")).toBeInTheDocument();
  });
```

Add `fireEvent` to the `@testing-library/react` import if it is missing.

In `tests/unit/SeasonRankingsRoute.test.tsx`:

Replace `stub` with:

```tsx
const SKILL_TYPES = [
  { key: "autonomous", label: "Autonomous" },
  { key: "driver", label: "Driver" },
];

function stub(settings: Partial<RankingSettingsRead> = {}, skillsEnabled = false) {
  vi.mocked(apiRequest).mockImplementation(async (path: string) => {
    if (path === "/api/ranking-settings") return { ...SETTINGS, ...settings } as never;
    if (path === "/api/divisions") return [] as never;
    if (path === "/api/teams") return [{ id: 1, number: "101", name: "Alpha", division_id: null }] as never;
    if (path === "/api/rankings?event_wide=true") return [ROW] as never;
    if (path === "/api/skills/settings") {
      return { enabled: skillsEnabled, attempts: { autonomous: 3, driver: 3 }, types: SKILL_TYPES } as never;
    }
    if (path === "/api/sessions") {
      return [{ id: 4, event_id: 1, label: "Saturday", session_date: null, timezone: null, has_scored_matches: false,
        qualification_finalized_at: null, qualification_drops: null }] as never;
    }
    if (path === "/api/skills/rankings?tab=overall&season=true") {
      return [{ rank: 1, team_id: 1, score: 54, attempts: [34, 20], session_id: 4 }] as never;
    }
    throw new Error(`unexpected request: ${path}`);
  });
}
```

Append:

```tsx
  it("hides the skills tabs while skills are off", async () => {
    stub();
    renderSeason();
    await screen.findByRole("row", { name: /Alpha/ });
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/skills/settings"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Teamwork"]);
  });

  it("shows season skills from the best session, naming it", async () => {
    stub({}, true);
    renderSeason();
    fireEvent.click(await screen.findByRole("tab", { name: "Overall Skills" }));
    const table = await screen.findByRole("table", { name: "Overall Skills" });
    expect(within(table).getByRole("columnheader", { name: "From session" })).toBeInTheDocument();
    const row = within(table).getAllByRole("row")[1];
    expect(row).toHaveTextContent("54");
    expect(row).toHaveTextContent("34 · 20");
    expect(await within(row).findByText("Saturday")).toBeInTheDocument();
    expect(screen.getByText(/Season scores come from the team's best session\.$/)).toBeInTheDocument();
  });

  it("refetches season skills rankings on skills_changed", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      onEvent = options.onEvent;
      return { connected: true };
    });
    stub({}, true);
    renderSeason();
    fireEvent.click(await screen.findByRole("tab", { name: "Overall Skills" }));
    await screen.findByRole("table", { name: "Overall Skills" });
    const fetches = () =>
      vi.mocked(apiRequest).mock.calls.filter(([path]) => path === "/api/skills/rankings?tab=overall&season=true")
        .length;
    const before = fetches();
    act(() => onEvent?.({ event: "skills_changed", data: { session_id: 4 } }));
    await waitFor(() => expect(fetches()).toBeGreaterThan(before));
  });
```

Add `fireEvent` and `within` to the `@testing-library/react` import.

Run `cd frontend && npm test --workspace apps/admin -- --run skillsRules SessionRankingsRoute SeasonRankingsRoute`. Expected: FAIL (no tabs, module missing).

- [ ] **Step 3: Implement the tabs.** Create `src/rankings/RankingTabs.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSkillsSettings } from "../skills/useSkillsSettings";
import type { SkillsType } from "../types";

export const TEAMWORK_TAB = "teamwork";
const SKILLS_PREFIX = "skills-";

export interface RankingTab {
  id: string;
  label: string;
}

/** A skills tab's id from its rankings tab ("overall" or a type key), and back. */
export const skillsTabId = (tab: string) => `${SKILLS_PREFIX}${tab}`;
export function skillsTabOf(tabId: string): string | null {
  return tabId.startsWith(SKILLS_PREFIX) ? tabId.slice(SKILLS_PREFIX.length) : null;
}

/** Teamwork, then each skills type in plugin order, then Overall Skills. The skills tabs show only while skills are on. */
export function useRankingTabs() {
  const { t } = useTranslation();
  const settings = useSkillsSettings();
  const types: SkillsType[] = settings.data?.enabled ? settings.data.types : [];
  const tabs: RankingTab[] = [
    { id: TEAMWORK_TAB, label: t("rankings.teamworkTab") },
    ...types.map((type) => ({ id: skillsTabId(type.key), label: type.label })),
    ...(types.length > 0 ? [{ id: skillsTabId("overall"), label: t("skills.rankings.overallTab") }] : []),
  ];
  const [chosen, setChosen] = useState(TEAMWORK_TAB);
  // If skills are turned off while a skills tab is open, fall back to Teamwork.
  const selected = tabs.some((tab) => tab.id === chosen) ? chosen : TEAMWORK_TAB;
  return { tabs, selected, select: setChosen, types };
}

export function RankingTabs({
  tabs,
  selected,
  onSelect,
  label,
  idPrefix,
}: {
  tabs: RankingTab[];
  selected: string;
  onSelect: (id: string) => void;
  label: string;
  idPrefix: string;
}) {
  return (
    <div className="division-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${tab.id}`}
          aria-selected={tab.id === selected}
          aria-controls={`${idPrefix}-panel`}
          className="division-tabs__tab"
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Implement the skills rankings view.** Create `src/skills/useSkillsRankings.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@tournament-admin/shared";
import type { SkillsRankingRead } from "../types";

export type SkillsScope = { kind: "session"; sessionId: number } | { kind: "season" };

export function skillsRankingsKey(scope: SkillsScope, tab: string): (string | number)[] {
  return ["skillsRankings", scope.kind === "session" ? scope.sessionId : "season", tab];
}

export function skillsRankingsPath(scope: SkillsScope, tab: string): string {
  const params = new URLSearchParams({ tab });
  if (scope.kind === "session") params.set("session_id", String(scope.sessionId));
  else params.set("season", "true");
  return `/api/skills/rankings?${params}`;
}

export function useSkillsRankings(scope: SkillsScope, tab: string) {
  return useQuery({
    queryKey: skillsRankingsKey(scope, tab),
    queryFn: () => apiRequest<SkillsRankingRead[]>(skillsRankingsPath(scope, tab)),
  });
}
```

Create `src/skills/skillsRules.ts`:

```ts
import type { TFunction } from "i18next";
import type { SkillsType } from "../types";

/** The one sentence explaining a skills rankings tab. */
export function skillsRuleSentence(t: TFunction, tab: string, types: SkillsType[], season: boolean): string {
  const rule =
    tab === "overall"
      ? t("skills.rankings.overallRule", {
          bests: types
            .map((type) => t("skills.rankings.typeBest", { label: type.label }))
            .join(t("skills.rankings.bestsJoin")),
        })
      : t("skills.rankings.typeRule", { label: types.find((type) => type.key === tab)?.label ?? tab });
  return season ? `${rule} ${t("skills.rankings.seasonRule")}` : rule;
}
```

Create `src/skills/SkillsRankingsPanel.tsx`:

```tsx
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import type { SessionRead, SkillsType, TeamSummary } from "../types";
import { skillsRuleSentence } from "./skillsRules";
import { useSkillsRankings, type SkillsScope } from "./useSkillsRankings";

/** One skills tab: its rule sentence and one table across every division. */
export function SkillsRankingsPanel({ scope, tab, types }: { scope: SkillsScope; tab: string; types: SkillsType[] }) {
  const { t } = useTranslation();
  const season = scope.kind === "season";
  const rankings = useSkillsRankings(scope, tab);
  const teams = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamSummary[]>("/api/teams"),
  });
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => apiRequest<SessionRead[]>("/api/sessions"),
    enabled: season,
  });
  const teamById = useMemo(() => new Map((teams.data ?? []).map((team) => [team.id, team])), [teams.data]);
  const sessionLabel = useMemo(
    () => new Map((sessions.data ?? []).map((session) => [session.id, session.label])),
    [sessions.data]
  );
  const label = tab === "overall" ? t("skills.rankings.overallTab") : (types.find((type) => type.key === tab)?.label ?? tab);
  const rows = rankings.data ?? [];

  return (
    <>
      <p className="rankings-rules">{skillsRuleSentence(t, tab, types, season)}</p>
      {rankings.isLoading ? (
        <p>{t("skills.rankings.loading")}</p>
      ) : rankings.isError ? (
        <p className="alert alert-danger" role="alert">
          {t("errors.generic")}
        </p>
      ) : rows.length === 0 ? (
        <p className="table__empty">{t("skills.rankings.empty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table" aria-label={label}>
            <thead>
              <tr>
                <th className="table__num">{t("rankings.columnRank")}</th>
                <th>{t("rankings.columnTeam")}</th>
                <th className="table__num">{t("rankings.columnScore")}</th>
                <th>{t("skills.rankings.columnAttempts")}</th>
                {season && <th>{t("skills.rankings.columnSession")}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const team = teamById.get(row.team_id);
                return (
                  <tr key={row.team_id}>
                    <td className="table__num">{row.rank}</td>
                    <td>
                      {team?.number ?? row.team_id} <span className="table__secondary">{team?.name ?? ""}</span>
                    </td>
                    <td className="table__num">{row.score}</td>
                    <td>{row.attempts.join(" · ")}</td>
                    {season && <td>{sessionLabel.get(row.session_id) ?? ""}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 5: Wire the pages.** Replace `src/routes/SessionRankingsRoute.tsx` with:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import { RankingTabs, skillsTabOf, useRankingTabs } from "../rankings/RankingTabs";
import { RankingsView } from "../rankings/RankingsView";
import { rankingsKeyPrefix } from "../rankings/useRankingGroups";
import { SkillsRankingsPanel } from "../skills/SkillsRankingsPanel";
import { useSkillsLiveUpdates } from "../skills/liveUpdates";
import type { SessionRead } from "../types";

export function SessionRankingsRoute() {
  const { t } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const queryClient = useQueryClient();
  const scope = { kind: "session" as const, sessionId: session.id };
  useRealtimeChannel({
    path: `/ws/session/${session.id}`,
    onEvent: (realtimeEvent: RealtimeEvent) => {
      if (realtimeEvent.event === "ranking_updated") {
        queryClient.invalidateQueries({ queryKey: rankingsKeyPrefix(scope) });
      }
    },
  });
  useSkillsLiveUpdates();
  const { tabs, selected, select, types } = useRankingTabs();
  const skillsTab = skillsTabOf(selected);

  return (
    <div>
      <RankingTabs
        tabs={tabs}
        selected={selected}
        onSelect={select}
        label={t("rankings.seasonTabsLabel")}
        idPrefix="session-rankings"
      />
      <div role="tabpanel" id="session-rankings-panel" aria-labelledby={`session-rankings-tab-${selected}`}>
        {skillsTab === null ? (
          <RankingsView scope={scope} />
        ) : (
          <SkillsRankingsPanel scope={scope} tab={skillsTab} types={types} />
        )}
      </div>
    </div>
  );
}
```

Replace `src/routes/SeasonRankingsRoute.tsx` with:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import { RankingTabs, skillsTabOf, useRankingTabs } from "../rankings/RankingTabs";
import { RankingsView } from "../rankings/RankingsView";
import { describeSeasonRules } from "../rankings/seasonRulesSummary";
import { rankingsKeyPrefix } from "../rankings/useRankingGroups";
import { RANKING_SETTINGS_KEY, useRankingSettings } from "../rankings/useRankingSettings";
import { SkillsRankingsPanel } from "../skills/SkillsRankingsPanel";
import { handleSkillsEvent } from "../skills/liveUpdates";

const SEASON_SCOPE = { kind: "season" as const };

/**
 * Season standings: Teamwork, then a tab per skills type and Overall Skills
 * while skills are on. Event-wide ranking updates and every skills event go
 * out on the active-session channel, so that's the one this page listens to.
 */
export function SeasonRankingsRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useRankingSettings();
  const { tabs, selected, select, types } = useRankingTabs();
  const skillsTab = skillsTabOf(selected);
  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (realtimeEvent: RealtimeEvent) => {
      const data = realtimeEvent.data as { event_wide?: boolean } | null;
      if (realtimeEvent.event === "ranking_updated" && data?.event_wide) {
        queryClient.invalidateQueries({ queryKey: rankingsKeyPrefix(SEASON_SCOPE) });
        // A settings change recomputes everything, so the rules sentence follows.
        queryClient.invalidateQueries({ queryKey: RANKING_SETTINGS_KEY });
      }
      handleSkillsEvent(queryClient, realtimeEvent);
    },
  });

  return (
    <div>
      <h1>{t("rankings.seasonHeading")}</h1>
      <RankingTabs
        tabs={tabs}
        selected={selected}
        onSelect={select}
        label={t("rankings.seasonTabsLabel")}
        idPrefix="season"
      />
      <div role="tabpanel" id="season-panel" aria-labelledby={`season-tab-${selected}`}>
        {skillsTab === null ? (
          <>
            {settings.data?.game_model === "cooperative_score" && (
              <p className="rankings-rules">{describeSeasonRules(t, settings.data)}</p>
            )}
            <RankingsView scope={SEASON_SCOPE} />
          </>
        ) : (
          <SkillsRankingsPanel scope={SEASON_SCOPE} tab={skillsTab} types={types} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run the frontend checks.** `cd frontend && npm test --workspace apps/admin -- --run && npx tsc -b apps/admin`. Expected: all pass and tsc is clean.

- [ ] **Step 7: Document.** In `frontend/CLAUDE.md`:
- Add `skills` to the list of session tabs: `/sessions/:sessionId/{checkin,fields,schedule,matches,skills,rankings}`.
- Replace "(Season rankings, a Teamwork tab for now — skills tabs come later)" with "(Season rankings)".
- After the Rankings paragraph, add:

> Skills challenges live in `src/skills/`.
> - **Settings:** `useSkillsSettings` (key `["skillsSettings"]`) drives everything. Event Setup's `SkillsSettingsPanel` is shown disabled, with the reason, until a game with skills types is chosen. Selecting a plugin invalidates that key, so it enables without a reload.
> - **Skills page:** the session Skills tab (`SessionSkillsRoute`) appears only while skills are on. Opened directly while they are off, it says so and links to Event Setup. It holds:
>   - `SessionAttemptsSettings`: the attempts line and the session override;
>   - `RecordAttemptForm`: `TeamPicker` over checked-in teams (`["participants", sessionId]`, shared with Check-In), type buttons hidden for a one-type game, and the shared scoresheet;
>   - `AttemptsTable`: the team filter, plus `EditAttemptDialog` for admin edit and delete.
> - **Rankings:** both rankings pages use `RankingTabs`/`useRankingTabs` (Teamwork, each type, Overall Skills). A skills tab renders `SkillsRankingsPanel` (key `["skillsRankings", sessionId | "season", tab]`).
> - **Live updates:** every skills event reaches `/ws/active-session`, so skills UI listens there through `useSkillsLiveUpdates` / `handleSkillsEvent`.
> - **Scoresheet forms:** they come from `@tournament-admin/shared`'s `ScoresheetForm`, which takes the caller's `t` (`useScoresheetT`) and knows nothing about skills. The future scorer app reuses it for skills and teamwork. A 422's per-field `violations` reach it through `ApiError.body` (`violationsByField`).

- [ ] **Step 8: Commit.**

```bash
git add frontend/apps/admin/src frontend/apps/admin/tests/unit frontend/CLAUDE.md
git commit -m "Add skills tabs to session and season rankings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: End-to-end coverage, final verification and docs

**Files:**
- Modify: `frontend/apps/admin/tests/e2e/fixtures/buildPluginZip.ts` (add `buildSampleCooperativePluginZip`)
- Create: `frontend/apps/admin/tests/e2e/skillsChallenges.spec.ts` (isolated server, ports 8128/5188)
- Docs: `frontend/CLAUDE.md` (E2E section), `docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md`

**Interfaces:**
- Consumes: every earlier task's UI text (the en strings), Task 1's sample plugin (`sample_cooperative`, with `autonomous` then `driver` and a `Score` counter from 0 to 999) and `startIsolatedServer`.

- [ ] **Step 1: Add the sample plugin zip helper.** Append to `tests/e2e/fixtures/buildPluginZip.ts`:

```ts
const SAMPLE_COOPERATIVE_PLUGIN_DIR = path.resolve(
  __dirname,
  "../../../../../../server/plugins/games/sample_cooperative"
);

/** The game that ships with the server (two skills types). Only manifest.json and plugin.py. */
export async function buildSampleCooperativePluginZip(): Promise<string> {
  const outPath = path.join(os.tmpdir(), `sample-cooperative-${Date.now()}.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    archive.file(path.join(SAMPLE_COOPERATIVE_PLUGIN_DIR, "manifest.json"), { name: "manifest.json" });
    archive.file(path.join(SAMPLE_COOPERATIVE_PLUGIN_DIR, "plugin.py"), { name: "plugin.py" });
    void archive.finalize();
  });
  return outPath;
}
```

- [ ] **Step 2: Write the spec.** Create `tests/e2e/skillsChallenges.spec.ts`:

```ts
import fs from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { buildSampleCooperativePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

const PASSWORD = "skills-e2e-pw";

test.describe.serial("skills challenges", () => {
  test.describe.configure({ timeout: 90_000 });

  let server: IsolatedServer;
  let token = "";
  let saturday = 0;
  let sunday = 0;
  const teams: Record<string, number> = {};
  const api = (route: string) => `${server.apiUrl}${route}`;
  const headers = () => ({ Authorization: `Bearer ${token}` });

  async function login(page: Page) {
    await page.goto(`${server.baseUrl}/login`);
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(`${server.baseUrl}/`);
  }

  async function post(request: APIRequestContext, route: string, data: unknown) {
    const response = await request.post(api(route), { headers: headers(), data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  }

  async function recordViaApi(request: APIRequestContext, session: number, team: string, skillsType: string, score: number) {
    await post(request, `/api/sessions/${session}/skills/attempts`, {
      team_id: teams[team],
      skills_type: skillsType,
      data: { score },
    });
  }

  const recordRegion = (page: Page) => page.getByRole("region", { name: "Record an attempt" });
  const attemptsTable = (page: Page) => page.getByRole("table", { name: "Attempts", exact: true });

  async function pick(page: Page, number: string, typeLabel: string) {
    const region = recordRegion(page);
    const change = region.getByRole("button", { name: "Change team" });
    if (await change.isVisible()) await change.click();
    await region.getByRole("combobox", { name: "Team" }).fill(number);
    await region.getByRole("option", { name: new RegExp(`^${number} `) }).click();
    await region.getByRole("button", { name: typeLabel, exact: true }).click();
  }

  test.beforeAll(async ({ request }) => {
    server = await startIsolatedServer({ backendPort: 8128, frontendPort: 5188 });
    expect((await request.post(api("/api/event"), { data: { name: "Skills League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json())
      .access_token;
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: headers(),
      multipart: {
        file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildSampleCooperativePluginZip()) },
      },
    });
    expect(uploaded.status()).toBe(201);
    for (const [number, name] of [["S1", "Skills One"], ["S2", "Skills Two"], ["S3", "Skills Three"], ["S4", "Skills Four"]]) {
      teams[number] = (await post(request, "/api/teams", { number, name })).id;
    }
    saturday = (await post(request, "/api/sessions", { label: "Skills Saturday", session_date: "2026-10-10" })).id;
    sunday = (await post(request, "/api/sessions", { label: "Skills Sunday", session_date: "2026-10-11" })).id;
    for (const number of ["S1", "S2", "S3"]) {
      await post(request, `/api/sessions/${saturday}/participants`, { team_id: teams[number], checked_in: true });
    }
    await post(request, `/api/sessions/${sunday}/participants`, { team_id: teams.S1, checked_in: true });
  });

  test.afterAll(() => server?.stop());

  test("Event Setup enables the skills panel once a game is chosen, and skills turn on", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/events/setup`);
    await expect(page.getByText("Choose a game plugin above before setting up skills challenges.")).toBeVisible();
    const toggle = page.getByRole("switch", { name: "Run skills challenges" });
    await expect(toggle).toBeDisabled();

    await page.getByRole("button", { name: "Select for this event" }).click();
    await expect(toggle).toBeEnabled();
    await expect(page.getByLabel("Autonomous attempts")).toHaveValue("3");
    await expect(page.getByLabel("Driver attempts")).toHaveValue("3");
    await toggle.check();
    await page.getByRole("button", { name: "Save skills settings" }).click();
    await expect(page.getByText("Skills settings saved.")).toBeVisible();
  });

  test("a team not checked in is not offered, and attempts are recorded for two types", async ({ page, request }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/matches`);
    await page.getByRole("link", { name: "Skills", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${saturday}/skills$`));
    await expect(page.getByText("Autonomous 3 · Driver 3 (event setting)")).toBeVisible();

    const region = recordRegion(page);
    await region.getByRole("combobox", { name: "Team" }).fill("S4");
    await expect(region.getByRole("option")).toHaveCount(0);
    await expect(region.getByText("No checked-in team matches.")).toBeVisible();

    await region.getByRole("combobox", { name: "Team" }).fill("S1");
    await region.getByRole("option", { name: "S1 Skills One" }).click();
    await region.getByRole("button", { name: "Autonomous", exact: true }).click();
    await expect(region.getByText("Attempt 1 of 3")).toBeVisible();
    await region.getByLabel("Score", { exact: true }).fill("20");
    await region.getByRole("button", { name: "Save attempt" }).click();
    await expect(region.getByText("Saved: 20 points")).toBeVisible();
    await expect(region.getByText("Attempt 2 of 3")).toBeVisible();

    await region.getByRole("button", { name: "Driver", exact: true }).click();
    await region.getByLabel("Score", { exact: true }).fill("34");
    await region.getByRole("button", { name: "Save attempt" }).click();
    await expect(region.getByText("Saved: 34 points")).toBeVisible();

    await recordViaApi(request, saturday, "S2", "autonomous", 28);
    await recordViaApi(request, saturday, "S2", "driver", 30);
    await recordViaApi(request, saturday, "S3", "driver", 34);
    // Recorded elsewhere: the table follows over the realtime channel.
    await expect(attemptsTable(page).locator("tbody tr")).toHaveCount(3);
  });

  test("Session Rankings rank the Overall and per-type tabs", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/rankings`);
    await expect(page.getByRole("tab", { name: "Teamwork", exact: true })).toHaveAttribute("aria-selected", "true");

    await page.getByRole("tab", { name: "Overall Skills", exact: true }).click();
    await expect(page.getByText("Ties go to the higher Autonomous best, then Driver best", { exact: false })).toBeVisible();
    const overall = page.getByRole("table", { name: "Overall Skills" }).locator("tbody tr");
    await expect(overall).toHaveCount(3);
    await expect(overall.nth(0)).toContainText("S2");
    await expect(overall.nth(0)).toContainText("58");
    await expect(overall.nth(1)).toContainText("S1");
    await expect(overall.nth(1)).toContainText("54");
    await expect(overall.nth(2)).toContainText("S3");

    await page.getByRole("tab", { name: "Driver", exact: true }).click();
    const driver = page.getByRole("table", { name: "Driver" }).locator("tbody tr");
    await expect(driver.locator("td:first-child")).toHaveText(["1", "1", "3"]);
    await expect(driver.nth(0)).toContainText("S1");
    await expect(driver.nth(1)).toContainText("S3");
    await expect(driver.nth(2)).toContainText("S2");
  });

  test("the attempts table filters by team, and editing an attempt changes the rankings", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/skills`);
    const rows = attemptsTable(page).locator("tbody tr");
    await expect(rows).toHaveCount(3);
    const find = page.getByLabel("Find team");
    await find.fill("s1");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("S1");
    await find.fill("zz");
    await expect(page.getByText("No teams match 'zz'")).toBeVisible();
    await find.fill("");
    await expect(rows).toHaveCount(3);

    await attemptsTable(page).getByRole("button", { name: "Edit Autonomous attempt 1 for team S2: 28 points" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Autonomous attempt 1 · Team S2" });
    await expect(dialog.getByLabel("Score", { exact: true })).toHaveValue("28");
    await dialog.getByLabel("Score", { exact: true }).fill("18");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      attemptsTable(page).getByRole("button", { name: "Edit Autonomous attempt 1 for team S2: 18 points" })
    ).toBeVisible();

    await page.getByRole("link", { name: "Rankings", exact: true }).click();
    await page.getByRole("tab", { name: "Overall Skills", exact: true }).click();
    const overall = page.getByRole("table", { name: "Overall Skills" }).locator("tbody tr");
    await expect(overall.nth(0)).toContainText("S1");
    await expect(overall.nth(0)).toContainText("54");
    await expect(overall.nth(1)).toContainText("S2");
    await expect(overall.nth(1)).toContainText("48");
  });

  test("a session override limits attempts until the event setting is restored", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/skills`);
    await page.getByRole("button", { name: "Change for this session" }).click();
    await page.getByLabel("Driver attempts").fill("1");
    await page.getByRole("button", { name: "Save for this session" }).click();
    await expect(page.getByText("Autonomous 3 · Driver 1 (this session)")).toBeVisible();

    await pick(page, "S1", "Driver");
    const region = recordRegion(page);
    await expect(region.getByText("Team S1 has used all 1 Driver attempts.")).toBeVisible();
    await expect(region.getByRole("button", { name: "Save attempt" })).toBeDisabled();

    await page.getByRole("button", { name: "Use event setting" }).click();
    await expect(page.getByText("Autonomous 3 · Driver 3 (event setting)")).toBeVisible();
    await expect(region.getByText("Attempt 2 of 3")).toBeVisible();
    await expect(region.getByRole("button", { name: "Save attempt" })).toBeEnabled();
  });

  test("an out-of-range score is reported beside the field and nothing is saved", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/skills`);
    await pick(page, "S2", "Autonomous");
    const region = recordRegion(page);
    const score = region.getByLabel("Score", { exact: true });
    await score.fill("1000");
    await region.getByRole("button", { name: "Save attempt" }).click();
    await expect(region.getByText("Must be at most 999.")).toBeVisible();
    await expect(score).toHaveAttribute("aria-invalid", "true");
    await expect(attemptsTable(page).getByRole("button", { name: /for team S2:/ })).toHaveCount(2);
  });

  test("deleting an attempt gives it back", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${saturday}/skills`);
    await attemptsTable(page).getByRole("button", { name: "Edit Driver attempt 1 for team S2: 30 points" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete attempt" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete this attempt?" });
    await expect(confirm.getByText("Team S2 gets this Driver attempt back.")).toBeVisible();
    await confirm.getByRole("button", { name: "Delete attempt" }).click();
    await expect(confirm).toBeHidden();
    await expect(attemptsTable(page).getByRole("button", { name: /^Edit Driver attempt .* team S2:/ })).toHaveCount(0);

    await pick(page, "S2", "Driver");
    await expect(recordRegion(page).getByText("Attempt 1 of 3")).toBeVisible();
  });

  test("Season Rankings show the best session's score, not a mix of sessions", async ({ page, request }) => {
    // Sunday: S1 24 + 28 = 52. Saturday stays 20 + 34 = 54. Mixing bests would give 24 + 34 = 58.
    await recordViaApi(request, sunday, "S1", "autonomous", 24);
    await recordViaApi(request, sunday, "S1", "driver", 28);
    await login(page);
    await page.goto(`${server.baseUrl}/rankings`);
    await page.getByRole("tab", { name: "Overall Skills", exact: true }).click();
    await expect(page.getByText("Season scores come from the team's best session.", { exact: false })).toBeVisible();
    const row = page.getByRole("table", { name: "Overall Skills" }).locator("tbody tr").filter({ hasText: "S1" });
    await expect(row).toContainText("54");
    await expect(row).toContainText("20 · 34");
    await expect(row).toContainText("Skills Saturday");
  });

  test("turning skills off hides the Skills page and tabs", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/events/setup`);
    const toggle = page.getByRole("switch", { name: "Run skills challenges" });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await page.getByRole("button", { name: "Save skills settings" }).click();
    await expect(page.getByText("Skills settings saved.")).toBeVisible();

    await page.goto(`${server.baseUrl}/sessions/${saturday}/rankings`);
    await expect(page.getByRole("tab", { name: "Teamwork", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Overall Skills", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Skills", exact: true })).toHaveCount(0);

    await page.goto(`${server.baseUrl}/sessions/${saturday}/skills`);
    await expect(page.getByText("Skills challenges are turned off for this event.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to Event Setup" })).toHaveAttribute("href", "/events/setup");
  });
});
```

Notes for the implementer:
- The Overall attempts cell lists each type's list in plugin order: Autonomous, then Driver. S1's Saturday cell is therefore "20 · 34".
- `toHaveCount(0)` immediately after navigation can pass before the skills settings load. In the last test, the direct visit to `/skills` is the decisive check. Keep the order shown.
- If the multipart upload or the `apiUrl`/`baseUrl` field names differ from `finalizeQualification.spec.ts`, match that file. Adapt only those mechanics, never the asserted text.

- [ ] **Step 3: Run the new spec.** `cd frontend/apps/admin && npx playwright test skillsChallenges.spec.ts`. Expected: all 9 tests pass.

- [ ] **Step 4: Update the docs.**
- In `frontend/CLAUDE.md`'s Testing section, extend the isolated-server sentence: "... as `cooperativeRankings.spec.ts` does on ports 8125/5185, `finalizeQualification.spec.ts` on 8127/5187, and `skillsChallenges.spec.ts` (the shipped sample game, with skills on) on 8128/5188."
- In `docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md`:
  - Directly after the **SkillsAttempt** bullet (which ends `skills_type, data (JSON), attempt_number`.), add an indented line:

    > *As built (see `2026-10-08-skills-challenges-design.md`): `division_id` and `attempt_number` were dropped. Skills rank event-wide, and attempt numbers are derived from `(recorded_at, id)`. The score, plugin name and version, and `recorded_at`/`updated_at` were added.*

  - After the `skills_scoresheet_schema()` / `calculate_skills_score()` bullet, add:

    > *As built: both take the skills type key, and a required `skills_types()` lists the types in tie-break priority order.*

- [ ] **Step 5: Run everything.**
  - `cd server && .venv/bin/pytest -q`. Expected: all pass.
  - `cd frontend && npm test --workspace packages/shared && npm test --workspace apps/admin -- --run && npx tsc -b apps/admin && npx tsc -p packages/shared`. Expected: all pass and tsc is clean.
  - `cd frontend/apps/admin && npx playwright test`. Expected: the whole E2E suite passes, including the shared-event specs, which still submit scores as admin.
  - Read `git diff master --stat` and skim `git diff master` for any real-world competition brand or product name, in code, strings, comments, test data and commit messages (`git log master..`). Expected: none. If one slipped in, replace it with a neutral term.

- [ ] **Step 6: Commit.**

```bash
git add frontend/apps/admin/tests/e2e/fixtures/buildPluginZip.ts frontend/apps/admin/tests/e2e/skillsChallenges.spec.ts frontend/CLAUDE.md docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md
git commit -m "Cover skills challenges end to end

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
