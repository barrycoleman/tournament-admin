# Game Plugin Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the game plugin the obvious first step: an admin banner until one is chosen, plugin-dependent screens locked with an explanation, a plugin that can be switched or cleared until it is in use, and an award form that only offers sources that can produce a winner.

**Architecture:**
- **Server.** The server gains change/clear/dry-run on the existing `/api/event/game-plugin` route.
  - A new `services/game_plugin.py` owns the in-use lock, the settings reset and the dry-run preview.
  - A new `broadcast_all` sends `game_plugin_changed` to every socket.
  - `services/awards.py` gains one availability rule used by both the award endpoints and the preview.
- **Admin app.** It gets one shared check (`useGamePlugin`), one panel (`NeedsGamePlugin`) and one route wrapper (`RequiresGamePlugin`), plus an app-shell banner and live-update hook.
  - Event Setup's plugin section is rebuilt around three states, with a dry-run confirm dialog.
  - The award form switches to a pure `availableSources` rule.

**Tech Stack:**
- Server: FastAPI, SQLAlchemy 2.x, pytest.
- Admin app: React 19, TanStack Query, react-i18next (en and zh), Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-11-game-plugin-gating-design.md`

## Global Constraints

- Never reference any real-world competition brand or product name anywhere: code, comments, commits, docs or UI text.
- Every backend change ships with pytest tests. Every UI change ships with Vitest tests and Playwright coverage. A task is not done until its tests pass.
- Work on branch `game-plugin-gating` in the main checkout. No worktrees.
- **Commit messages:** plain sentences, no `feat:` prefixes, ending with a blank line then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **UI strings:** every new string goes in both `frontend/apps/admin/src/i18n/en/admin.json` and `.../zh/admin.json`. The zh values are real Simplified Chinese translations.
- **Exact strings (verbatim):**
  - Lock (409): `The game plugin can't be changed after matches are scheduled or skills attempts are recorded.`
  - Award 422 details:
    - `Performance awards need a game plugin.`
    - `Event-wide performance awards come from skills challenges, which are off.`
    - `Skills awards need skills challenges turned on.`
  - Banner: `Choose a game plugin to set up scheduling, matches, rankings and skills.` with link text `Choose a game plugin`.
  - Panel for admin: `This needs a game plugin. Choose one in Event Setup.` (link text `Choose one in Event Setup`). For other roles: `The organizer hasn't chosen a game plugin yet.`
  - Event Setup:
    - hint: `Choose the game first. Scheduling, matches, rankings and skills depend on it.`
    - buttons: `Select for this event` (unchanged), `Switch to this`, `Clear selection`
    - locked note: `Locked because matches are scheduled or skills attempts are recorded.`
  - Award form reasons:
    - `Needs a game plugin.`
    - `Event-wide performance awards come from skills challenges, which are off.`
    - suffix ` (not available)`
- **Realtime:** the event name is `game_plugin_changed`, with data `{"game_plugin_name": <str|null>}`.
- **Anchor:** the Event Setup game plugin section has `id="game-plugins"`. Links go to `/events/setup#game-plugins`.
- **Commands:**
  - Server tests: `cd server && .venv/bin/python -m pytest -q`
  - Admin unit tests: `cd frontend && npm run test --workspace apps/admin -- --run`
  - Type check: `cd frontend && npx tsc -p apps/admin --noEmit`
  - Playwright: `cd frontend/apps/admin && npx playwright test`

## Review Focus

1. **Two admins, one switch.** One admin switches the plugin while another tab has Event Setup open. The second tab must update live, from the broadcast, and must not offer stale buttons. A switch attempted from a stale tab after a schedule exists must show the 409 detail, not fail silently. Task 4 tests the 409 display.
2. **Name-only edit of an award whose source became unavailable.** It must save without a 422 and without changing the source. If `draftToBody` still silently swaps the source to `skills_overall`, this breaks. Task 5 tests it.
3. **Re-choosing the selected plugin.** This must not reset settings or broadcast. An admin double-clicking or a retried request would otherwise wipe their skills settings. Task 2 tests it.
4. **Judges and front desk with no plugin.** They must see the non-admin panel wording with no Event Setup link, and never the banner. Task 3 tests it.
5. **Existing shared-server Playwright specs.** They now run with the banner visible before `eventSetup.spec.ts` chooses a plugin. They must still pass, and no locator may become ambiguous because of the banner. Task 6 runs the full suite.

---

### Task 1: Award availability rule and award endpoint check

**Files:**
- Modify: `server/src/tournament_server/services/awards.py`
- Modify: `server/src/tournament_server/routers/awards.py`
- Create: `server/tests/test_award_availability.py`
- Modify (only if they now fail): award API tests that create skills-sourced awards over HTTP with skills off

**Interfaces:**
- Produces:
  - in `services/awards.py`: `NEEDS_PLUGIN_DETAIL`, `EVENT_NEEDS_SKILLS_DETAIL`, `SKILLS_OFF_DETAIL`, `SKILLS_SOURCES`;
  - `availability_error(d: dict, plugin_selected: bool, skills_enabled: bool) -> str | None`. `d` is a normalized definition dict with keys `kind`, `scope`, `source`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_award_availability.py`:

```python
from __future__ import annotations

import pytest

from award_helpers import create_session
from skills_helpers import enable_skills
from tournament_server.services.awards import availability_error

JUDGED = {"name": "Excellence Award", "kind": "judged", "scope": "event"}
TEAMWORK = {
    "name": "Teamwork Champion", "kind": "performance", "scope": "division",
    "source": "teamwork_ranking", "basis": "session", "placement": 1,
}
SKILLS_EVENT = {
    "name": "Skills Champion", "kind": "performance", "scope": "event",
    "source": "skills_overall", "basis": "session", "placement": 1,
}
SKILLS_DIVISION = {**SKILLS_EVENT, "scope": "division"}

NEEDS_PLUGIN = "Performance awards need a game plugin."
EVENT_NEEDS_SKILLS = "Event-wide performance awards come from skills challenges, which are off."
SKILLS_OFF = "Skills awards need skills challenges turned on."


@pytest.mark.parametrize(("definition", "plugin", "skills", "expected"), [
    (JUDGED, False, False, None),
    (TEAMWORK, False, False, NEEDS_PLUGIN),
    (SKILLS_EVENT, False, False, NEEDS_PLUGIN),
    (TEAMWORK, True, False, None),
    (SKILLS_EVENT, True, False, EVENT_NEEDS_SKILLS),
    (SKILLS_DIVISION, True, False, SKILLS_OFF),
    ({**SKILLS_DIVISION, "source": "skills_type", "skills_type": "driver"}, True, False, SKILLS_OFF),
    (SKILLS_EVENT, True, True, None),
    (SKILLS_DIVISION, True, True, None),
])
def test_availability_rules(definition, plugin, skills, expected):
    assert availability_error(definition, plugin, skills) == expected


def _event(client, plugin: bool = True) -> int:
    client.post("/api/event", json={"name": "League"})
    if plugin:
        assert client.post("/api/event/game-plugin", json={"name": "example-game"}).status_code == 200
    return create_session(client)


def test_create_refuses_a_performance_award_without_a_plugin(client):
    session_id = _event(client, plugin=False)
    response = client.post(f"/api/sessions/{session_id}/awards", json=TEAMWORK)
    assert response.status_code == 422
    assert response.json()["detail"] == NEEDS_PLUGIN
    assert client.post(f"/api/sessions/{session_id}/awards", json=JUDGED).status_code == 201


def test_create_refuses_skills_awards_while_skills_are_off(client):
    session_id = _event(client)
    event_wide = client.post(f"/api/sessions/{session_id}/awards", json=SKILLS_EVENT)
    assert (event_wide.status_code, event_wide.json()["detail"]) == (422, EVENT_NEEDS_SKILLS)
    division = client.post(f"/api/sessions/{session_id}/awards", json=SKILLS_DIVISION)
    assert (division.status_code, division.json()["detail"]) == (422, SKILLS_OFF)
    assert client.post(f"/api/sessions/{session_id}/awards", json=TEAMWORK).status_code == 201


def test_a_name_only_edit_is_allowed_after_skills_turn_off_but_a_rule_edit_is_not(client):
    session_id = _event(client)
    enable_skills(client)
    award = client.post(f"/api/sessions/{session_id}/awards", json=SKILLS_EVENT).json()
    assert client.put("/api/skills/settings", json={"enabled": False, "attempts": {}}).status_code == 200

    renamed = client.patch(f"/api/awards/{award['id']}", json={"name": "Robot Skills Champion", "description": "Top score"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["source"] == "skills_overall"

    rule_edit = client.patch(f"/api/awards/{award['id']}", json={"placement": 2})
    assert (rule_edit.status_code, rule_edit.json()["detail"]) == (422, EVENT_NEEDS_SKILLS)


def test_copy_keeps_unavailable_awards(client):
    saturday = _event(client)
    enable_skills(client)
    client.post(f"/api/sessions/{saturday}/awards", json=SKILLS_EVENT)
    assert client.put("/api/skills/settings", json={"enabled": False, "attempts": {}}).status_code == 200
    sunday = create_session(client, "Sunday")
    copied = client.post(f"/api/sessions/{sunday}/awards/copy", json={"from_session_id": saturday})
    assert copied.status_code in (200, 201), copied.text
    names = [a["name"] for a in client.get(f"/api/sessions/{sunday}/awards").json()["awards"]]
    assert names == ["Skills Champion"]
```

Before relying on it, check the copy endpoint's request body and status code in `routers/awards.py` (`copy_awards`), and adjust the copy call to match. Do not change the endpoint.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_award_availability.py -q`
Expected: FAIL with `ImportError: cannot import name 'availability_error'`.

- [ ] **Step 3: Add the rule to `services/awards.py`**

Add after `DESCRIPTION_MAX`:

```python
SKILLS_SOURCES = ("skills_overall", "skills_type")
NEEDS_PLUGIN_DETAIL = "Performance awards need a game plugin."
EVENT_NEEDS_SKILLS_DETAIL = "Event-wide performance awards come from skills challenges, which are off."
SKILLS_OFF_DETAIL = "Skills awards need skills challenges turned on."
```

Add after `definition_error`:

```python
def availability_error(d: dict, plugin_selected: bool, skills_enabled: bool) -> str | None:
    """Why a valid definition can never produce a winner in the event's current
    state (no game plugin, or skills challenges off), or None."""
    if d["kind"] != PERFORMANCE:
        return None
    if not plugin_selected:
        return NEEDS_PLUGIN_DETAIL
    if d["source"] in SKILLS_SOURCES and not skills_enabled:
        return EVENT_NEEDS_SKILLS_DETAIL if d["scope"] == EVENT else SKILLS_OFF_DETAIL
    return None
```

- [ ] **Step 4: Check it in the award router**

In `routers/awards.py`, add the import `from tournament_server.services import skills as skills_service` and this helper after `_validated`:

```python
def _ensure_available(db: Session, definition: dict) -> None:
    event = get_event_or_404(db)
    error = rules.availability_error(
        definition, event.game_plugin_name is not None, skills_service.is_enabled(db, event.id)
    )
    if error is not None:
        raise HTTPException(status_code=422, detail=error)
```

- **`create_award`:** call `_ensure_available(db, definition)` right after `definition = _validated(...)`.
- **`update_award`:** call it right after `rule_changed` is computed, only `if rule_changed:`, before any `setattr`.
- **`copy_awards`:** leave unchanged.

- [ ] **Step 5: Run the new tests, then the full server suite**

Run: `cd server && .venv/bin/python -m pytest tests/test_award_availability.py -q`
Expected: PASS.

Run: `cd server && .venv/bin/python -m pytest -q`
Expected: all pass.

If an existing test fails because it creates a skills-sourced award over HTTP while skills are off, fix it as follows:
- Add `enable_skills(client)` from `skills_helpers` before the create.
- Do not weaken the new rule.
- Do not touch tests whose body is already invalid; `definition_error` still answers those first.

- [ ] **Step 6: Commit**

```bash
git add server/src/tournament_server/services/awards.py server/src/tournament_server/routers/awards.py server/tests
git commit -m "Refuse performance awards that can never have a winner: none without a game plugin, and no skills awards while skills challenges are off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Change, clear and dry-run the game plugin, with reset, lock and broadcast

**Files:**
- Create: `server/src/tournament_server/services/game_plugin.py`
- Modify: `server/src/tournament_server/routers/event.py`
- Modify: `server/src/tournament_server/schemas/event.py`
- Modify: `server/src/tournament_server/realtime.py`
- Modify: `server/tests/test_event.py` (replace `test_select_game_plugin_is_immutable`)
- Create: `server/tests/test_game_plugin_change.py`
- Modify: `server/CLAUDE.md` (document the endpoints, the lock, the reset and the `game_plugin_changed` event in the events list)

**Interfaces:**
- Consumes (Task 1): `availability_error`, `SKILLS_SOURCES`, `PERFORMANCE` from `services/awards.py`.
- Produces:
  - **HTTP routes:**
    - `POST /api/event/game-plugin?dry_run=true|false` with body `{name}`;
    - `DELETE /api/event/game-plugin?dry_run=true|false`.
  - **Return values:** both return `EventRead` normally and `GamePluginChangePreview` on a dry run.
  - **Schemas:**
    - `EventRead.game_plugin_locked: bool`.
    - `GamePluginChangePreview` with `would_reset: {skills_enabled: bool, session_attempt_overrides: int, ranking_settings: bool}` and `awards_needing_attention: list[{award_id: int, session_id: int, session_label: str, name: str, reason: "unavailable" | "unknown_skills_type"}]`.
  - **Realtime:** `realtime.broadcast_all(app, event: str, data: dict) -> None`.

- [ ] **Step 1: Write the failing tests**

Replace `test_select_game_plugin_is_immutable` in `server/tests/test_event.py` with:

```python
def test_selecting_the_same_game_plugin_again_changes_nothing(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})

    response = client.post("/api/event/game-plugin", json={"name": "example-game"})
    assert response.status_code == 200
    assert response.json()["game_plugin_name"] == "example-game"
```

Create `server/tests/test_game_plugin_change.py`:

```python
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from plugin_helpers import zip_fixture_plugin
from skills_helpers import SECOND_GAME, admin_token, create_session, enable_skills, next_event, record_attempt

LOCKED = "The game plugin can't be changed after matches are scheduled or skills attempts are recorded."
DRIVER_AWARD = {
    "name": "Driver Champion", "kind": "performance", "scope": "event",
    "source": "skills_type", "skills_type": "driver", "basis": "session", "placement": 1,
}


def _event(client) -> None:
    """An event with example-game and second-game (no skills types) installed, none selected."""
    assert client.post("/api/event", json={"name": "League"}).status_code == 201
    uploaded = client.post(
        "/api/plugins/games",
        files={"file": ("second-game.zip", zip_fixture_plugin(SECOND_GAME), "application/zip")},
    )
    assert uploaded.status_code == 201, uploaded.text


def _select(client, name: str) -> dict:
    response = client.post("/api/event/game-plugin", json={"name": name})
    assert response.status_code == 200, response.text
    return response.json()


def _schedule_one_match(client) -> None:
    session_id = create_session(client, "Match day")
    team_ids = [client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"] for n in range(1, 5)]
    response = client.post("/api/matches", json={
        "session_id": session_id, "round_type": "qualification", "match_number": 1, "field_id": None,
        "alliances": [
            {"station": "red", "team_ids": team_ids[:2]},
            {"station": "blue", "team_ids": team_ids[2:]},
        ],
    })
    assert response.status_code == 201, response.text


def test_switch_and_clear_while_unused(client):
    _event(client)
    assert _select(client, "example-game")["game_plugin_locked"] is False
    assert _select(client, "second-game")["game_plugin_name"] == "second-game"
    cleared = client.delete("/api/event/game-plugin")
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["game_plugin_name"] is None
    assert client.get("/api/event").json()["game_plugin_name"] is None


def test_unknown_plugin_is_404(client):
    _event(client)
    assert client.post("/api/event/game-plugin", json={"name": "no-such-game"}).status_code == 404


def test_reselecting_the_same_plugin_keeps_settings_and_does_not_broadcast(client, monkeypatch):
    _event(client)
    _select(client, "example-game")
    enable_skills(client, {"driver": 5})
    sent = []
    monkeypatch.setattr("tournament_server.routers.event.broadcast_all", lambda *args: sent.append(args))
    _select(client, "example-game")
    assert client.get("/api/skills/settings").json()["enabled"] is True
    assert client.get("/api/skills/settings").json()["attempts"]["driver"] == 5
    assert sent == []


def test_switching_resets_skills_session_overrides_and_ranking_settings(client):
    _event(client)
    _select(client, "example-game")
    enable_skills(client, {"driver": 5})
    session_id = create_session(client)
    assert client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {"driver": 2}}).status_code == 200
    ranking = client.get("/api/ranking-settings").json()
    ranking.pop("game_model")
    ranking["session_drop_no_show"] = True
    assert client.put("/api/ranking-settings", json=ranking).status_code == 200, "ranking settings save"

    _select(client, "second-game")

    assert client.get("/api/skills/settings").json() == {"enabled": False, "attempts": {}, "types": []}
    assert client.get(f"/api/sessions/{session_id}/skills").json()["override"] is None
    assert client.get("/api/ranking-settings").json()["session_drop_no_show"] is False


def test_clearing_resets_settings_too(client):
    _event(client)
    _select(client, "example-game")
    enable_skills(client)
    assert client.delete("/api/event/game-plugin").status_code == 200
    _select(client, "example-game")
    assert client.get("/api/skills/settings").json()["enabled"] is False


def test_a_scheduled_match_locks_the_plugin(client):
    _event(client)
    _select(client, "example-game")
    _schedule_one_match(client)
    assert client.get("/api/event").json()["game_plugin_locked"] is True
    for response in (
        client.post("/api/event/game-plugin", json={"name": "second-game"}),
        client.delete("/api/event/game-plugin"),
        client.post("/api/event/game-plugin?dry_run=true", json={"name": "second-game"}),
        client.delete("/api/event/game-plugin?dry_run=true"),
    ):
        assert (response.status_code, response.json()["detail"]) == (409, LOCKED)
    assert _select(client, "example-game")["game_plugin_name"] == "example-game"


def test_a_skills_attempt_locks_the_plugin(client):
    _event(client)
    _select(client, "example-game")
    team_id = client.post("/api/teams", json={"number": "1", "name": "Team 1"}).json()["id"]
    session_id = create_session(client, checked_in=[team_id])
    enable_skills(client)
    assert record_attempt(client, session_id, team_id).status_code == 201
    response = client.post("/api/event/game-plugin", json={"name": "second-game"})
    assert (response.status_code, response.json()["detail"]) == (409, LOCKED)


@pytest.mark.parametrize("role", ["scorer", "judge", "referee", "attendee", "front_desk"])
def test_only_admins_choose_change_or_clear(client, role):
    _event(client)
    raw = TestClient(client.app)
    headers = bearer(login_as(raw, role))
    assert raw.post("/api/event/game-plugin", json={"name": "example-game"}, headers=headers).status_code == 403
    _select(client, "example-game")
    assert raw.post("/api/event/game-plugin", json={"name": "second-game"}, headers=headers).status_code == 403
    assert raw.post("/api/event/game-plugin?dry_run=true", json={"name": "second-game"}, headers=headers).status_code == 403
    assert raw.delete("/api/event/game-plugin", headers=headers).status_code == 403
    assert raw.delete("/api/event/game-plugin?dry_run=true", headers=headers).status_code == 403


def test_dry_run_reports_what_would_reset_and_changes_nothing(client):
    _event(client)
    _select(client, "example-game")
    enable_skills(client)
    session_id = create_session(client)
    assert client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {"driver": 2}}).status_code == 200
    award = client.post(f"/api/sessions/{session_id}/awards", json=DRIVER_AWARD).json()
    judged = {"name": "Excellence Award", "kind": "judged", "scope": "event"}
    assert client.post(f"/api/sessions/{session_id}/awards", json=judged).status_code == 201

    switch = client.post("/api/event/game-plugin?dry_run=true", json={"name": "second-game"})
    assert switch.status_code == 200, switch.text
    assert switch.json() == {
        "would_reset": {"skills_enabled": True, "session_attempt_overrides": 1, "ranking_settings": False},
        "awards_needing_attention": [{
            "award_id": award["id"], "session_id": session_id, "session_label": "Saturday",
            "name": "Driver Champion", "reason": "unknown_skills_type",
        }],
    }
    clear = client.delete("/api/event/game-plugin?dry_run=true").json()
    assert clear["awards_needing_attention"][0]["reason"] == "unavailable"

    assert client.get("/api/event").json()["game_plugin_name"] == "example-game"
    assert client.get("/api/skills/settings").json()["enabled"] is True
    assert client.get(f"/api/sessions/{session_id}/skills").json()["override"] == {"driver": 2}


def test_dry_run_of_the_current_plugin_reports_nothing(client):
    _event(client)
    _select(client, "example-game")
    enable_skills(client)
    response = client.post("/api/event/game-plugin?dry_run=true", json={"name": "example-game"})
    assert response.json() == {
        "would_reset": {"skills_enabled": False, "session_attempt_overrides": 0, "ranking_settings": False},
        "awards_needing_attention": [],
    }


def test_a_change_broadcasts_on_every_channel(client):
    _event(client)
    _select(client, "example-game")
    session_id = create_session(client)
    token = admin_token(client)
    with client.websocket_connect(f"/ws/session/{session_id}?token={token}") as session_socket, \
            client.websocket_connect(f"/ws/active-session?token={token}") as active_socket:
        _select(client, "second-game")
        expected = {"game_plugin_name": "second-game"}
        assert next_event(session_socket, "game_plugin_changed")["data"] == expected
        assert next_event(active_socket, "game_plugin_changed")["data"] == expected
```

Before running, check two things against the code:
- **Session skills GET.** Confirm in `routers/skills.py` that `GET /api/sessions/{id}/skills` returns an `override` key. Adjust the key name in the tests if it differs, and leave the endpoint alone.
- **Ranking-settings round-trip.** Confirm that `GET /api/ranking-settings` minus `game_model` is a valid `PUT` body.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_game_plugin_change.py tests/test_event.py -q`
Expected: FAIL. Switching returns 409, `game_plugin_locked` is a KeyError, and DELETE returns 405.

- [ ] **Step 3: Add `broadcast_all` to `realtime.py`**

Add after `broadcast_session`:

```python
def broadcast_all(app: "FastAPI", event: str, data: dict) -> None:
    """Sends to every connected socket: the active-session channel and every
    per-session channel. Dead sockets are left for their own channel's next
    broadcast or unregister to clean up."""
    registry = app.state.realtime
    if registry.event_loop is None:
        return
    sockets = set(registry.active_session)
    for subscribers in registry.by_session.values():
        sockets |= subscribers
    if not sockets:
        return
    asyncio.run_coroutine_threadsafe(_send_to_all(sockets, event, data), registry.event_loop)
```

- [ ] **Step 4: Add the schemas**

In `schemas/event.py`, add `game_plugin_locked: bool = False` to `EventRead` after `game_plugin_name`, and append:

```python
class WouldReset(BaseModel):
    skills_enabled: bool
    session_attempt_overrides: int
    ranking_settings: bool


class AwardNeedingAttention(BaseModel):
    award_id: int
    session_id: int
    session_label: str
    name: str
    reason: str  # "unavailable" | "unknown_skills_type"


class GamePluginChangePreview(BaseModel):
    would_reset: WouldReset
    awards_needing_attention: list[AwardNeedingAttention]
```

- [ ] **Step 5: Create `services/game_plugin.py`**

```python
"""Changing an event's game plugin: the in-use lock, the settings reset a change
causes, and the dry-run preview of that reset."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.award import Award
from tournament_server.models.event import Event
from tournament_server.models.match import Match
from tournament_server.models.ranking_settings import RankingSettings
from tournament_server.models.session import TournamentSession
from tournament_server.models.skills import SkillsAttempt
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.schemas.event import AwardNeedingAttention, GamePluginChangePreview, WouldReset
from tournament_server.services import skills as skills_service
from tournament_server.services.awards import PERFORMANCE, availability_error
from tournament_server.services.ranking_rules import RankingRules
from tournament_server.services.ranking_settings import RULE_FIELDS, rules_from_settings

LOCKED_DETAIL = (
    "The game plugin can't be changed after matches are scheduled or skills attempts are recorded."
)


def is_in_use(db: Session) -> bool:
    """A match (scores and finals need one) or a skills attempt exists."""
    return (
        db.execute(select(Match.id).limit(1)).first() is not None
        or db.execute(select(SkillsAttempt.id).limit(1)).first() is not None
    )


def is_locked(db: Session, event: Event) -> bool:
    return event.game_plugin_name is not None and is_in_use(db)


def _ranking_row(db: Session, event_id: int) -> RankingSettings | None:
    return db.execute(
        select(RankingSettings).where(RankingSettings.event_id == event_id)
    ).scalars().first()


def _sessions(db: Session, event_id: int) -> list[TournamentSession]:
    return list(
        db.execute(
            select(TournamentSession).where(TournamentSession.event_id == event_id).order_by(TournamentSession.id)
        ).scalars().all()
    )


def _attention_reason(award: Award, target: LoadedPlugin | None, type_keys: list[str]) -> str | None:
    if award.kind != PERFORMANCE:
        return None
    if target is None:
        return "unavailable"
    if award.source == "skills_type" and award.skills_type not in type_keys:
        return "unknown_skills_type"
    definition = {"kind": award.kind, "scope": award.scope, "source": award.source}
    # The reset turns skills challenges off, so the target state has them off.
    if availability_error(definition, True, False) is not None:
        return "unavailable"
    return None


def preview(db: Session, event: Event, target: LoadedPlugin | None) -> GamePluginChangePreview:
    """What changing to `target` (None clears) would reset; writes nothing."""
    ranking = _ranking_row(db, event.id)
    type_keys = [t["key"] for t in skills_service.plugin_types(target)]
    sessions = _sessions(db, event.id)
    labels = {s.id: s.label for s in sessions}
    attention = []
    for award in db.execute(select(Award).order_by(Award.session_id, Award.position)).scalars().all():
        reason = _attention_reason(award, target, type_keys)
        if reason is not None:
            attention.append(AwardNeedingAttention(
                award_id=award.id, session_id=award.session_id, session_label=labels.get(award.session_id, ""),
                name=award.name, reason=reason,
            ))
    return GamePluginChangePreview(
        would_reset=WouldReset(
            skills_enabled=skills_service.is_enabled(db, event.id),
            session_attempt_overrides=sum(1 for s in sessions if s.skills_attempts is not None),
            ranking_settings=ranking is not None and rules_from_settings(ranking) != RankingRules(),
        ),
        awards_needing_attention=attention,
    )


def empty_preview() -> GamePluginChangePreview:
    return GamePluginChangePreview(
        would_reset=WouldReset(skills_enabled=False, session_attempt_overrides=0, ranking_settings=False),
        awards_needing_attention=[],
    )


def reset_settings(db: Session, event: Event) -> None:
    """Puts every plugin-specific setting back to its default. The caller commits."""
    skills = skills_service.find_settings(db, event.id)
    if skills is not None:
        skills.enabled = False
        skills.attempts = {}
    for session_obj in _sessions(db, event.id):
        session_obj.skills_attempts = None
    ranking = _ranking_row(db, event.id)
    if ranking is not None:
        defaults = RankingRules()
        for name in RULE_FIELDS:
            setattr(ranking, name, getattr(defaults, name))
```

`RankingRules` is a dataclass, so `!=` compares field values. Confirm this in `services/ranking_rules.py`. If it is not a dataclass, compare `RULE_FIELDS` one by one.

- [ ] **Step 6: Rewrite the plugin endpoints in `routers/event.py`**

- **Imports:** add `Query` to the fastapi import. Import `get_event_or_404` from `deps`, `broadcast_all` from `realtime`, and `GamePluginChangePreview` from `schemas.event`. Add `from tournament_server.services import game_plugin as game_plugin_service`.
- **`_event_read`:** add the helper below, and make every handler in this file that returns an `Event` (`create_event`, `read_event`, `update_event`, `set_active_session`) return `_event_read(db, event)` instead. Keep their `response_model=EventRead`.

```python
def _event_read(db: Session, event: Event) -> EventRead:
    return EventRead(
        id=event.id,
        name=event.name,
        active_session_id=event.active_session_id,
        game_plugin_name=event.game_plugin_name,
        game_plugin_locked=game_plugin_service.is_locked(db, event),
        created_at=event.created_at,
    )
```

Replace `select_game_plugin` with:

```python
def _change_game_plugin(
    request: Request, db: Session, event: Event, target_name: str | None, dry_run: bool
) -> EventRead | GamePluginChangePreview:
    if target_name == event.game_plugin_name:
        return game_plugin_service.empty_preview() if dry_run else _event_read(db, event)
    if game_plugin_service.is_locked(db, event):
        raise HTTPException(status_code=409, detail=game_plugin_service.LOCKED_DETAIL)
    target = request.app.state.game_plugins.get(target_name) if target_name is not None else None
    if dry_run:
        return game_plugin_service.preview(db, event, target)
    game_plugin_service.reset_settings(db, event)
    event.game_plugin_name = target_name
    db.commit()
    db.refresh(event)
    broadcast_all(request.app, "game_plugin_changed", {"game_plugin_name": target_name})
    return _event_read(db, event)


@router.post("/game-plugin", response_model=EventRead | GamePluginChangePreview)
def select_game_plugin(
    payload: GamePluginSelect,
    request: Request,
    dry_run: bool = Query(False),
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> EventRead | GamePluginChangePreview:
    """Chooses, or while unused changes, the event's game plugin. Choosing the
    current plugin again changes nothing."""
    event = get_event_or_404(db)
    if payload.name not in request.app.state.game_plugins:
        raise HTTPException(
            status_code=404, detail=f"No game plugin named {payload.name!r} is loaded"
        )
    return _change_game_plugin(request, db, event, payload.name, dry_run)


@router.delete("/game-plugin", response_model=EventRead | GamePluginChangePreview)
def clear_game_plugin(
    request: Request,
    dry_run: bool = Query(False),
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> EventRead | GamePluginChangePreview:
    """Clears the event's game plugin while it is unused."""
    return _change_game_plugin(request, db, get_event_or_404(db), None, dry_run)
```

Watch for one pitfall: with `response_model=EventRead | GamePluginChangePreview`, FastAPI must not coerce one model into the other. The two have no overlapping required fields, so validation picks the right one. If FastAPI still mangles the output, set `response_model=None` and return the models directly.

- [ ] **Step 7: Run the tests**

Run: `cd server && .venv/bin/python -m pytest tests/test_game_plugin_change.py tests/test_event.py -q`
Expected: PASS.

Run: `cd server && .venv/bin/python -m pytest -q`
Expected: all pass.

- [ ] **Step 8: Document it in `server/CLAUDE.md`**

- **Event section:** describe the choose/change/clear/dry-run behavior, the in-use lock and its detail, `game_plugin_locked`, and the reset.
- **Realtime events list:** add `game_plugin_changed` (all sockets, `{"game_plugin_name"}`) next to the existing `awards_changed` and `finals_changed` entries.
- **Awards section:** add the availability rule from Task 1.

- [ ] **Step 9: Commit**

```bash
git add server/src/tournament_server server/tests server/CLAUDE.md
git commit -m "Let an admin switch or clear the game plugin until a match or skills attempt exists, resetting plugin settings, with a dry run and a game_plugin_changed broadcast

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Shared gate, banner, live updates and locked screens (admin app)

**Files:**
- Modify: `frontend/apps/admin/src/types.ts`
- Create: `frontend/apps/admin/src/gamePlugin/useGamePlugin.ts`
- Create: `frontend/apps/admin/src/gamePlugin/NeedsGamePlugin.tsx`
- Create: `frontend/apps/admin/src/gamePlugin/GamePluginBanner.tsx`
- Create: `frontend/apps/admin/src/gamePlugin/liveUpdates.ts`
- Modify: `frontend/apps/admin/src/components/AppShell.tsx`
- Modify: `frontend/apps/admin/src/router.tsx`
- Modify: `frontend/apps/admin/src/schedule/ReadinessChecklist.tsx` (link target)
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `.../zh/admin.json`
- Create: `frontend/apps/admin/tests/unit/gamePlugin.test.tsx`
- Modify (if they break): `tests/unit/AppShell.test.tsx`, `tests/unit/readiness*.test.ts*`

**Interfaces:**
- Consumes (Task 2): `EventRead.game_plugin_locked`, the realtime event `game_plugin_changed`.
- Produces:
  - `useGamePlugin(): { selected: boolean; locked: boolean; name: string | null; isLoading: boolean }`.
  - `<NeedsGamePlugin />`.
  - `<RequiresGamePlugin>{children}</RequiresGamePlugin>`, exported from `NeedsGamePlugin.tsx`.
  - `<GamePluginBanner />`.
  - `handleGamePluginEvent(queryClient, realtimeEvent): void` and `useGamePluginLiveUpdates(): void`.
  - `GAME_PLUGIN_SECTION_PATH = "/events/setup#game-plugins"`.
  - Types `GamePluginChangePreview` and `AwardNeedingAttention`.

- [ ] **Step 1: Add the types**

In `types.ts`, add `game_plugin_locked: boolean;` to `EventRead` after `game_plugin_name`, and add:

```ts
export interface AwardNeedingAttention {
  award_id: number;
  session_id: number;
  session_label: string;
  name: string;
  reason: "unavailable" | "unknown_skills_type";
}

export interface GamePluginChangePreview {
  would_reset: { skills_enabled: boolean; session_attempt_overrides: number; ranking_settings: boolean };
  awards_needing_attention: AwardNeedingAttention[];
}
```

Then run `cd frontend && npx tsc -p apps/admin --noEmit`. Any test fixture that builds an `EventRead` literal and now fails to type-check gets `game_plugin_locked: false`.

- [ ] **Step 2: Add the i18n strings**

In `en/admin.json`, add a top-level `"gamePlugin"` object:

```json
"gamePlugin": {
  "banner": "Choose a game plugin to set up scheduling, matches, rankings and skills.",
  "bannerLink": "Choose a game plugin",
  "needsAdmin": "This needs a game plugin.",
  "needsAdminLink": "Choose one in Event Setup",
  "needsOther": "The organizer hasn't chosen a game plugin yet."
}
```

Add the same keys to `zh/admin.json`, with Simplified Chinese translations.

- [ ] **Step 3: Write the failing tests**

Create `tests/unit/gamePlugin.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { NeedsGamePlugin, RequiresGamePlugin } from "../../src/gamePlugin/NeedsGamePlugin";
import { GamePluginBanner } from "../../src/gamePlugin/GamePluginBanner";
import { handleGamePluginEvent } from "../../src/gamePlugin/liveUpdates";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useAuth: vi.fn() };
});

import { apiRequest, useAuth } from "@tournament-admin/shared";

function event(name: string | null) {
  return { id: 1, name: "League", active_session_id: null, game_plugin_name: name, game_plugin_locked: false, created_at: "" };
}

function renderAt(ui: React.ReactNode, path = "/") {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

function asRole(role: string) {
  vi.mocked(useAuth).mockReturnValue({ role } as never);
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

describe("NeedsGamePlugin", () => {
  it("tells an admin where to choose one", () => {
    asRole("admin");
    renderAt(<NeedsGamePlugin />);
    expect(screen.getByText(/This needs a game plugin\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Choose one in Event Setup" })).toHaveAttribute(
      "href",
      "/events/setup#game-plugins"
    );
  });

  it("tells other roles the organizer hasn't chosen one, with no link", () => {
    asRole("judge");
    renderAt(<NeedsGamePlugin />);
    expect(screen.getByText("The organizer hasn't chosen a game plugin yet.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("RequiresGamePlugin", () => {
  it("shows the panel instead of the screen when no plugin is chosen", async () => {
    asRole("admin");
    vi.mocked(apiRequest).mockResolvedValue(event(null) as never);
    renderAt(<RequiresGamePlugin><p>Matches grid</p></RequiresGamePlugin>);
    expect(await screen.findByText(/This needs a game plugin\./)).toBeInTheDocument();
    expect(screen.queryByText("Matches grid")).not.toBeInTheDocument();
  });

  it("shows the screen once a plugin is chosen", async () => {
    asRole("admin");
    vi.mocked(apiRequest).mockResolvedValue(event("example-game") as never);
    renderAt(<RequiresGamePlugin><p>Matches grid</p></RequiresGamePlugin>);
    expect(await screen.findByText("Matches grid")).toBeInTheDocument();
  });
});

describe("GamePluginBanner", () => {
  it("shows for an admin while no plugin is chosen", async () => {
    asRole("admin");
    vi.mocked(apiRequest).mockResolvedValue(event(null) as never);
    renderAt(<GamePluginBanner />, "/teams");
    expect(
      await screen.findByText("Choose a game plugin to set up scheduling, matches, rankings and skills.")
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Choose a game plugin" })).toHaveAttribute("href", "/events/setup#game-plugins");
  });

  it("is hidden on Event Setup, once a plugin is chosen, and for other roles", async () => {
    asRole("admin");
    vi.mocked(apiRequest).mockResolvedValue(event(null) as never);
    const setup = renderAt(<GamePluginBanner />, "/events/setup");
    await vi.waitFor(() => expect(apiRequest).toHaveBeenCalled());
    expect(screen.queryByText(/Choose a game plugin to set up/)).not.toBeInTheDocument();
    setup.unmount();

    vi.mocked(apiRequest).mockResolvedValue(event("example-game") as never);
    const chosen = renderAt(<GamePluginBanner />, "/teams");
    await vi.waitFor(() => expect(apiRequest).toHaveBeenCalled());
    expect(screen.queryByText(/Choose a game plugin to set up/)).not.toBeInTheDocument();
    chosen.unmount();

    asRole("judge");
    vi.mocked(apiRequest).mockResolvedValue(event(null) as never);
    renderAt(<GamePluginBanner />, "/teams");
    expect(screen.queryByText(/Choose a game plugin to set up/)).not.toBeInTheDocument();
  });
});

describe("handleGamePluginEvent", () => {
  it("refetches everything that depends on the plugin", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    handleGamePluginEvent(queryClient, { event: "game_plugin_changed", data: { game_plugin_name: "x" } });
    const keys = spy.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    for (const key of ['["event"]', '["matchFormat"]', '["awards"]', '["rankings"]', '["skillsRankings"]', '["sessionSkills"]']) {
      expect(keys).toContain(key);
    }
  });

  it("ignores other events", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    handleGamePluginEvent(queryClient, { event: "score_saved", data: {} });
    expect(spy).not.toHaveBeenCalled();
  });
});
```

Check `RealtimeEvent` in `frontend/packages/shared/src/realtime.ts` for its exact shape, and match the literal objects to it.

- [ ] **Step 4: Run them to verify they fail**

Run: `cd frontend && npm run test --workspace apps/admin -- --run tests/unit/gamePlugin.test.tsx`
Expected: FAIL, because the modules do not exist.

- [ ] **Step 5: Implement the modules**

`src/gamePlugin/useGamePlugin.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@tournament-admin/shared";
import type { EventRead } from "../types";

export const GAME_PLUGIN_SECTION_PATH = "/events/setup#game-plugins";

/** Whether the event has a game plugin; every gated screen asks this one hook. */
export function useGamePlugin() {
  const { data, isLoading } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });
  return {
    selected: Boolean(data?.game_plugin_name),
    locked: data?.game_plugin_locked ?? false,
    name: data?.game_plugin_name ?? null,
    isLoading,
  };
}
```

`src/gamePlugin/NeedsGamePlugin.tsx`:

```tsx
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@tournament-admin/shared";
import { GAME_PLUGIN_SECTION_PATH, useGamePlugin } from "./useGamePlugin";

/** Stands in for a screen that can't work without a game plugin. */
export function NeedsGamePlugin() {
  const { t } = useTranslation();
  const { role } = useAuth();
  if (role !== "admin") {
    return (
      <p className="alert alert-warning" role="status">
        {t("gamePlugin.needsOther")}
      </p>
    );
  }
  return (
    <p className="alert alert-warning" role="status">
      {t("gamePlugin.needsAdmin")} <Link to={GAME_PLUGIN_SECTION_PATH}>{t("gamePlugin.needsAdminLink")}</Link>
    </p>
  );
}

/** Renders `children` only once the event has a game plugin; nothing while that's loading. */
export function RequiresGamePlugin({ children }: { children: ReactNode }) {
  const { selected, isLoading } = useGamePlugin();
  if (isLoading) return null;
  return selected ? <>{children}</> : <NeedsGamePlugin />;
}
```

`src/gamePlugin/GamePluginBanner.tsx`:

```tsx
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@tournament-admin/shared";
import { GAME_PLUGIN_SECTION_PATH, useGamePlugin } from "./useGamePlugin";

/** Admin-only, on every page but Event Setup, until a game plugin is chosen. */
export function GamePluginBanner() {
  const { t } = useTranslation();
  const { role } = useAuth();
  const { pathname } = useLocation();
  const { selected, isLoading } = useGamePlugin();
  if (role !== "admin" || isLoading || selected || pathname === "/events/setup") return null;
  return (
    <p className="alert alert-warning game-plugin-banner" role="status">
      {t("gamePlugin.banner")} <Link to={GAME_PLUGIN_SECTION_PATH}>{t("gamePlugin.bannerLink")}</Link>
    </p>
  );
}
```

`useGamePlugin` runs only after the role check returns. Hooks must not be conditional, though, so call it unconditionally as written above. The `["event"]` query is already shared app-wide, so a non-admin pays nothing extra.

`src/gamePlugin/liveUpdates.ts`:

```ts
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import { RANKING_SETTINGS_KEY } from "../rankings/useRankingSettings";
import { SKILLS_SETTINGS_KEY } from "../skills/useSkillsSettings";

/** game_plugin_changed reaches every socket; on it, refetch everything the plugin shapes. */
export function handleGamePluginEvent(queryClient: QueryClient, realtimeEvent: RealtimeEvent): void {
  if (realtimeEvent.event !== "game_plugin_changed") return;
  for (const queryKey of [
    ["event"],
    SKILLS_SETTINGS_KEY,
    RANKING_SETTINGS_KEY,
    ["matchFormat"],
    ["awards"],
    ["rankings"],
    ["skillsRankings"],
    ["sessionSkills"],
  ]) {
    queryClient.invalidateQueries({ queryKey });
  }
}

export function useGamePluginLiveUpdates(): void {
  const queryClient = useQueryClient();
  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (realtimeEvent: RealtimeEvent) => handleGamePluginEvent(queryClient, realtimeEvent),
  });
}
```

`["rankings"]` must be a prefix of the real rankings keys. Check `rankingsKeyPrefix` in `rankings/useRankingGroups.ts`, and use its actual first element(s) if they differ. Do the same for `["skillsRankings"]` and `["sessionSkills"]` against `skills/liveUpdates.ts`.

- [ ] **Step 6: Wire the shell, the routes and the readiness link**

- **`AppShell.tsx`:**
  - Call `useGamePluginLiveUpdates()` at the top of `AppShell`, for every role, so judges' pages unlock live too.
  - Render `<GamePluginBanner />` right after `<TransientErrorBanner />`.
  - Hooks must come before the early `return` for `switchStatus === "waiting"`.
- **`router.tsx`:** wrap these route elements in `<RequiresGamePlugin>`:
  - `rankings` → `<SeasonRankingsRoute />`
  - judge `rankings` → `<SessionRankingsRoute />`
  - session `matches` → `<SessionMatchesRoute />`
  - session `skills` → `<SessionSkillsRoute />`
  - session `rankings` → `<SessionRankingsRoute />`

  For example: `{ path: "matches", element: <RequiresGamePlugin><SessionMatchesRoute /></RequiresGamePlugin> }`. Import from `./gamePlugin/NeedsGamePlugin`.
- **`ReadinessChecklist.tsx`:** in `fixLink`, return `GAME_PLUGIN_SECTION_PATH` (imported) for `"gamePlugin"` instead of `"/events/setup"`.

- [ ] **Step 7: Run unit tests and the type check**

Run: `cd frontend && npm run test --workspace apps/admin -- --run && npx tsc -p apps/admin --noEmit`
Expected: all pass.

If `AppShell.test.tsx` now fails, keep its assertions. Make its `apiRequest` mock return `{ game_plugin_name: "example-game", game_plugin_locked: false }` for `/api/event`, or assert the banner where that is the point of the test. Also add one AppShell test: an admin with `game_plugin_name: null` sees the banner text.

- [ ] **Step 8: Commit**

```bash
git add frontend/apps/admin
git commit -m "Show admins a banner until a game plugin is chosen, lock matches, rankings and skills behind it, and refresh everything live when the plugin changes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Event Setup — plugin section first, with select, switch, clear and the reset confirm

**Files:**
- Modify: `frontend/apps/admin/src/routes/EventSetupRoute.tsx`
- Create: `frontend/apps/admin/src/gamePlugin/GamePluginChangeDialog.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `.../zh/admin.json` (`eventSetup` keys)
- Modify: `frontend/apps/admin/tests/unit/EventSetupRoute.test.tsx`

**Interfaces:**
- Consumes:
  - Task 2's `POST|DELETE /api/event/game-plugin[?dry_run=true]` and `EventRead.game_plugin_locked`;
  - Task 3's `GamePluginChangePreview` type and `useGamePlugin`.
- Produces: `GamePluginChangeDialog({ target: { name: string; displayName: string } | null, preview: GamePluginChangePreview, isPending: boolean, error: string | null, onConfirm, onCancel })`. Here `target: null` means clearing the plugin.

- [ ] **Step 1: Add the strings**

Add to `eventSetup` in `en/admin.json`, and the same keys in zh with translations:

```json
"chooseFirstHint": "Choose the game first. Scheduling, matches, rankings and skills depend on it.",
"switchSubmit": "Switch to this",
"clearSubmit": "Clear selection",
"lockedNote": "Locked because matches are scheduled or skills attempts are recorded.",
"switchHeading": "Switch to {{name}}?",
"clearHeading": "Clear the game plugin?",
"resetIntro": "This resets settings that belong to the current game:",
"resetSkills": "Skills challenges will be turned off.",
"resetOverrides_one": "Skills attempts set for {{count}} session go back to the default.",
"resetOverrides_other": "Skills attempts set for {{count}} sessions go back to the default.",
"resetRanking": "Ranking settings go back to their defaults.",
"resetNothing": "No settings need resetting.",
"awardsIntro": "These awards won't be able to pick a winner until you edit them:",
"awardItem": "{{session}}: {{name}}",
"switchConfirm": "Switch plugin",
"clearConfirm": "Clear plugin",
"cancel": "Cancel"
```

Check that the i18n setup uses i18next v21+ plural suffixes (`_one`/`_other`). Grep the en file for an existing `_one` key. If plurals are done differently there, follow that pattern.

- [ ] **Step 2: Write the failing tests**

Extend `tests/unit/EventSetupRoute.test.tsx`. Keep the existing test, and add `game_plugin_locked: false` to its event literals. Factor the mock into a `mockServer(state)` helper in the same file:
- `state = { selected: string | null, locked: boolean, preview?: GamePluginChangePreview, failWith?: string }`.
- It serves two games: `example-game` "Example Game" and `second-game` "Second Game".
- It records calls in `calls: {path, method}[]`.

Then add:

```tsx
it("puts the game plugin section first and says to choose the game first", async () => {
  mockServer({ selected: null, locked: false });
  renderSetup();
  const headings = await screen.findAllByRole("heading", { level: 2 });
  expect(headings[0]).toHaveTextContent("Game plugins");
  expect(headings[0].closest("section")).toHaveAttribute("id", "game-plugins");
  expect(screen.getByText("Choose the game first. Scheduling, matches, rankings and skills depend on it.")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Select for this event" })).toHaveLength(2);
});

it("offers switch and clear while the plugin is unused, and confirms with the reset list", async () => {
  const calls = mockServer({
    selected: "example-game",
    locked: false,
    preview: {
      would_reset: { skills_enabled: true, session_attempt_overrides: 2, ranking_settings: true },
      awards_needing_attention: [
        { award_id: 7, session_id: 1, session_label: "Saturday", name: "Driver Champion", reason: "unknown_skills_type" },
      ],
    },
  });
  renderSetup();
  fireEvent.click(await screen.findByRole("button", { name: "Switch to this" }));
  const dialog = await screen.findByRole("dialog", { name: "Switch to Second Game?" });
  expect(dialog).toHaveTextContent("Skills challenges will be turned off.");
  expect(dialog).toHaveTextContent("Skills attempts set for 2 sessions go back to the default.");
  expect(dialog).toHaveTextContent("Ranking settings go back to their defaults.");
  expect(dialog).toHaveTextContent("Saturday: Driver Champion");
  expect(calls.some((c) => c.path === "/api/event/game-plugin?dry_run=true")).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Switch plugin" }));
  await vi.waitFor(() =>
    expect(calls.some((c) => c.path === "/api/event/game-plugin" && c.method === "POST")).toBe(true)
  );
  expect(screen.getByRole("button", { name: "Clear selection" })).toBeInTheDocument();
});

it("shows the locked note and no switch or clear buttons once the plugin is in use", async () => {
  mockServer({ selected: "example-game", locked: true });
  renderSetup();
  expect(await screen.findByText("Locked because matches are scheduled or skills attempts are recorded.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Switch to this" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Clear selection" })).not.toBeInTheDocument();
});

it("shows the server's reason when a switch is refused", async () => {
  mockServer({
    selected: "example-game",
    locked: false,
    failWith: "The game plugin can't be changed after matches are scheduled or skills attempts are recorded.",
  });
  renderSetup();
  fireEvent.click(await screen.findByRole("button", { name: "Switch to this" }));
  expect(
    await screen.findByText("The game plugin can't be changed after matches are scheduled or skills attempts are recorded.")
  ).toBeInTheDocument();
});
```

For `failWith`, the mock makes the dry-run request reject with `new ApiError(...)`. Check `ApiError`'s constructor in `frontend/packages/shared/src/api-client.ts` and build it accordingly. The page must show `apiErrorMessage(error, ...)`, either in the section's alert (when the dry run fails) or in the dialog (when the real call fails).

- [ ] **Step 3: Run them to verify they fail**

Run: `cd frontend && npm run test --workspace apps/admin -- --run tests/unit/EventSetupRoute.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement**

**`GamePluginChangeDialog.tsx`** is a `Modal` (from `../components/Modal`, `labelledBy` + `onCancel`, `role="dialog"` named by its heading). It contains:
- a heading: `switchHeading` with `{name: target.displayName}`, or `clearHeading` when `target` is null;
- then `resetIntro` and a list:
  - `resetSkills` if `would_reset.skills_enabled`;
  - `resetOverrides` with `count` if `session_attempt_overrides > 0`;
  - `resetRanking` if `ranking_settings`;
  - `resetNothing` alone if none apply;
- if `awards_needing_attention` is non-empty: `awardsIntro` and a list of `awardItem` with `{session: session_label, name}`;
- `error` in `alert alert-danger`;
- buttons: confirm (`btn btn-primary`, `switchConfirm`/`clearConfirm`, disabled while `isPending`) and `cancel`.

Base its layout on `ConfirmDialog.tsx`: copy its markup classes (`dialog__actions`, etc.) so it looks the same.

**`EventSetupRoute.tsx`** changes:
- **Move the game list.** Pull the game plugin list out of the generic `PluginList` into a new `GamePluginSection` component in the same file, rendered first. `PluginList` stays for schedulers only, so remove its `kind === "games"` branch and the select mutation.
- **`GamePluginSection` layout:** `<section className="panel" id="game-plugins">`, an `h2` with `eventSetup.gamePluginsHeading`, then the plugin rows, then the install field. Keep the install mutation/UI for games exactly as it behaves today, just moved. For simplicity, the install code can stay shared in a small `InstallPluginField({kind, labelKey})` component used by both.
- **States**, from `useGamePlugin()`:
  - **None selected:** show `chooseFirstHint` as a `field__hint` under the heading. Each row gets a **Select for this event** button, which calls `POST /api/event/game-plugin` directly, with no dialog.
  - **Selected, not locked:** the chosen row shows the `selectedLabel` badge. Other rows get **Switch to this**. Under the list sits a **Clear selection** button (`btn btn-small`).
  - **Selected, locked:** the chosen row shows the badge, other rows have no button, and `lockedNote` appears as a `field__hint`.
- **Switch / clear flow:**
  1. Run the dry run: `POST /api/event/game-plugin?dry_run=true {name}` or `DELETE /api/event/game-plugin?dry_run=true`.
  2. Open `GamePluginChangeDialog` with the result.
  3. On confirm, make the real call. On success, close the dialog and invalidate `["event"]`, `RANKING_SETTINGS_KEY`, `SKILLS_SETTINGS_KEY`, `["matchFormat"]` and `["awards"]`.
  4. On cancel, close.
- **Errors:**
  - Select or dry-run failure: `alert alert-danger` in the section with `apiErrorMessage(error, t("errors.generic"))`.
  - Confirm failure: shown inside the dialog.
- **Order:** `<GamePluginSection />`, scheduler `<PluginList kind="schedulers" … />`, `<RankingSettingsPanel />`, `<SkillsSettingsPanel />`, `<ServerInfoPanel />`.

Use `apiRequest` with `method: "DELETE"` for clearing. Check that `apiRequest` handles a JSON body on a DELETE response; the server returns JSON in both modes.

- [ ] **Step 5: Run unit tests and the type check**

Run: `cd frontend && npm run test --workspace apps/admin -- --run && npx tsc -p apps/admin --noEmit`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/admin
git commit -m "Put the game plugin first on Event Setup and let an admin switch or clear it while unused, confirming what will reset

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Award form offers only sources that can produce a winner

**Files:**
- Modify: `frontend/apps/admin/src/awards/awardForm.ts`
- Modify: `frontend/apps/admin/src/awards/AwardFormDialog.tsx`
- Modify: `frontend/apps/admin/src/awards/AwardsView.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `.../zh/admin.json` (`awards.form` keys)
- Modify: `frontend/apps/admin/tests/unit/awardForm.test.ts`
- Modify: `frontend/apps/admin/tests/unit/AwardsView.test.tsx` (or add `AwardFormDialog.test.tsx`)

**Interfaces:**
- Consumes: Task 3's `useGamePlugin`, and the existing `useSkillsSettings` (`data.enabled`, `data.types`).
- Produces:
  - `interface SourceAvailability { pluginSelected: boolean; skillsEnabled: boolean }`;
  - `availableSources(scope: AwardScope, availability: SourceAvailability): AwardSource[]`;
  - `performanceBlockedReason(scope, availability): "awards.form.needsPlugin" | "awards.form.eventNeedsSkills" | null`.
  - `allowedSources` is removed.
  - `AwardFormDialog` gains the prop `availability: SourceAvailability`.

- [ ] **Step 1: Add the strings**

Add to `awards.form` in en (and zh, translated):

```json
"needsPlugin": "Needs a game plugin.",
"eventNeedsSkills": "Event-wide performance awards come from skills challenges, which are off.",
"notAvailable": "{{label}} (not available)"
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/unit/awardForm.test.ts`. Remove the existing `allowedSources` tests and replace them with:

```ts
import { availableSources, draftFromAward, draftToBody, performanceBlockedReason } from "../../src/awards/awardForm";

const NONE = { pluginSelected: false, skillsEnabled: false };
const PLUGIN = { pluginSelected: true, skillsEnabled: false };
const SKILLS = { pluginSelected: true, skillsEnabled: true };

describe("availableSources", () => {
  it.each([
    ["division", NONE, []],
    ["event", NONE, []],
    ["division", PLUGIN, ["teamwork_ranking", "finals"]],
    ["event", PLUGIN, []],
    ["division", SKILLS, ["teamwork_ranking", "finals", "skills_overall", "skills_type"]],
    ["event", SKILLS, ["skills_overall", "skills_type"]],
  ] as const)("%s scope with %o offers %o", (scope, availability, expected) => {
    expect(availableSources(scope, availability)).toEqual(expected);
  });
});

describe("performanceBlockedReason", () => {
  it("names the missing plugin first, then skills for event-wide awards", () => {
    expect(performanceBlockedReason("division", NONE)).toBe("awards.form.needsPlugin");
    expect(performanceBlockedReason("event", PLUGIN)).toBe("awards.form.eventNeedsSkills");
    expect(performanceBlockedReason("division", PLUGIN)).toBeNull();
    expect(performanceBlockedReason("event", SKILLS)).toBeNull();
  });
});

describe("draftToBody keeps an unavailable source", () => {
  it("does not swap a skills award's source when only the name changes", () => {
    const award = {
      name: "Skills Champion", description: null, kind: "performance" as const, scope: "event" as const,
      division_ids: [], source: "skills_overall" as const, skills_type: null, basis: "session" as const, placement: 1,
    };
    const draft = { ...draftFromAward(award), name: "Robot Skills Champion" };
    expect(draftToBody(draft)).toMatchObject({ source: "skills_overall", name: "Robot Skills Champion" });
  });
});
```

Add dialog tests, in `AwardsView.test.tsx` or a new `AwardFormDialog.test.tsx` rendering `AwardFormDialog` directly with a `QueryClientProvider` + i18n:

```tsx
it("disables Performance with the reason when there is no game plugin", () => {
  renderDialog({ award: null, availability: { pluginSelected: false, skillsEnabled: false } });
  expect(screen.getByRole("radio", { name: "Performance" })).toBeDisabled();
  expect(screen.getByText("Needs a game plugin.")).toBeInTheDocument();
});

it("offers only teamwork and finals while skills are off", () => {
  renderDialog({ award: null, availability: { pluginSelected: true, skillsEnabled: false } });
  fireEvent.click(screen.getByRole("radio", { name: "Performance" }));
  const options = within(screen.getByRole("combobox", { name: "Winner comes from" })).getAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual(["Teamwork ranking", "Finals"]);
});

it("keeps an existing skills award's source, marked not available, so a rename saves", async () => {
  renderDialog({ award: SKILLS_EVENT_AWARD, availability: { pluginSelected: true, skillsEnabled: false } });
  const source = screen.getByRole("combobox", { name: "Winner comes from" });
  expect(source).toHaveDisplayValue("Skills overall (not available)");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Robot Skills Champion" } });
  fireEvent.click(screen.getByRole("button", { name: "Save award" }));
  await vi.waitFor(() =>
    expect(apiRequest).toHaveBeenCalledWith(
      `/api/awards/${SKILLS_EVENT_AWARD.id}`,
      expect.objectContaining({ method: "PATCH", body: expect.objectContaining({ source: "skills_overall" }) })
    )
  );
});
```

Fill in the exact labels from `en/admin.json` before running: the radio label for performance, the source select's label, the source option labels, the name field label and the save button text. Replace the placeholders above (`"Performance"`, `"Winner comes from"`, `"Teamwork ranking"`, `"Finals"`, `"Skills overall"`, `"Name"`, `"Save award"`) with the real strings.

`SKILLS_EVENT_AWARD` is an `AwardRead` fixture with event scope, `skills_overall` source and one slot with `status: "no_result"`, `note: "skills_disabled"`. Model it on the existing fixtures in `AwardsView.test.tsx`.

- [ ] **Step 3: Run them to verify they fail**

Run: `cd frontend && npm run test --workspace apps/admin -- --run tests/unit/awardForm.test.ts tests/unit/AwardsView.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement `awardForm.ts`**

Replace `allowedSources` with:

```ts
export interface SourceAvailability {
  pluginSelected: boolean;
  skillsEnabled: boolean;
}

const DIVISION_SOURCES: AwardSource[] = ["teamwork_ranking", "finals"];
const SKILLS_SOURCES: AwardSource[] = ["skills_overall", "skills_type"];

/** Sources that can produce a winner now. Teamwork rankings and finals never
 *  compare teams across divisions, so event-wide awards only come from skills. */
export function availableSources(scope: AwardScope, availability: SourceAvailability): AwardSource[] {
  if (!availability.pluginSelected) return [];
  const skills = availability.skillsEnabled ? SKILLS_SOURCES : [];
  return scope === "event" ? skills : [...DIVISION_SOURCES, ...skills];
}

/** Why the Performance choice is disabled for this scope, as an i18n key, or null. */
export function performanceBlockedReason(
  scope: AwardScope,
  availability: SourceAvailability
): "awards.form.needsPlugin" | "awards.form.eventNeedsSkills" | null {
  if (!availability.pluginSelected) return "awards.form.needsPlugin";
  if (availableSources(scope, availability).length === 0) return "awards.form.eventNeedsSkills";
  return null;
}
```

- **Delete `ALL_SOURCES`.**
- **`draftToBody`:** remove the source coercion line. Use `draft.source` as-is:

```ts
  const source = draft.source;
```

  The dialog now keeps `draft.source` valid when scope changes (Step 5). The server refuses anything else.

- [ ] **Step 5: Implement the dialog changes**

In `AwardFormDialog.tsx`:
- **New prop:** `availability: SourceAvailability`.
- **Original values:** let `originalSource = award?.kind === "performance" ? award.source : null` and `originalKind = award?.kind ?? null`.
- **Source options:** `availableSources(draft.scope, availability)`, plus `originalSource` appended when it is not in that list and `draft.scope === award?.scope`. An appended option is labeled `t("awards.form.notAvailable", { label: t(SOURCE_LABEL_KEYS[source]) })`.
- **Performance radio:**
  - disabled when `performanceBlockedReason(draft.scope, availability) !== null && originalKind !== "performance"`;
  - when that reason is non-null, show `t(reason)` as a `field__hint` directly under the kind fieldset's radios.
- **Scope change:**

```ts
onChange={() => {
  const options = availableSources(scope, availability);
  const keep = options.includes(draft.source) || (originalSource === draft.source && scope === award?.scope);
  set({ scope, source: keep ? draft.source : (options[0] ?? draft.source) });
}}
```

  If the new scope makes Performance unavailable and this isn't an existing performance award, also set `kind: "judged"`.
- **Skills type list:** keep `skillsTypes` as is. If an existing award's `skills_type` is not in `skillsTypes`, append it as an option labeled `t("awards.form.notAvailable", { label: award.skills_type })`.

In `AwardsView.tsx`:
- read `const plugin = useGamePlugin();` (it already has `skills = useSkillsSettings()`);
- pass `availability={{ pluginSelected: plugin.selected, skillsEnabled: Boolean(skills.data?.enabled) }}` to `AwardFormDialog`.
- The view's unit tests mock `apiRequest`. Make sure their mock answers `/api/event` (with `game_plugin_name` set and `game_plugin_locked: false`).

- [ ] **Step 6: Run unit tests and the type check**

Run: `cd frontend && npm run test --workspace apps/admin -- --run && npx tsc -p apps/admin --noEmit`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/admin
git commit -m "Offer award sources only when they can produce a winner, and keep an existing award's unavailable source so a rename still saves

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Playwright coverage, full-suite run and docs

**Files:**
- Create: `frontend/apps/admin/tests/e2e/gamePluginGating.spec.ts` (isolated server on ports **8130/5190**)
- Modify (only if they break): shared-server specs
- Modify: `frontend/CLAUDE.md` (gating note, and the new spec's ports in the isolated-ports list)
- Modify: `frontend/apps/admin/tests/e2e/awards.spec.ts` only if the new award rules break it

**Interfaces:**
- Consumes everything above. Use the fixtures `startIsolatedServer({ backendPort, frontendPort })`, `buildExampleGamePluginZip()` and `buildSampleCooperativePluginZip()`.

- [ ] **Step 1: Write the spec**

Use `awards.spec.ts`'s structure: `test.describe.serial`, a `login(page, role)` helper, and API `post` helpers with a bearer token. Use the timeout of 90 s.

`beforeAll`:
1. Start the server on 8130/5190.
2. Create the event "Gating League" with password `gating-e2e-pw` and log in as admin via the API.
3. Upload both game plugin zips with `POST /api/plugins/games` multipart, and remember their returned `name`s and `display_name`s.
4. Create teams T1–T4 and a session "Gating Saturday", and make it active.
5. Do **not** select a plugin.

Tests, in order:

```ts
test("with no plugin, admins see the banner and locked screens", async ({ page }) => {
  await login(page);
  await page.goto(`${server.baseUrl}/teams`);
  await expect(page.getByText("Choose a game plugin to set up scheduling, matches, rankings and skills.")).toBeVisible();
  await page.goto(`${server.baseUrl}/sessions/${saturday}/matches`);
  await expect(page.getByText(/This needs a game plugin\./)).toBeVisible();
  await page.goto(`${server.baseUrl}/sessions/${saturday}/rankings`);
  await expect(page.getByText(/This needs a game plugin\./)).toBeVisible();
  await page.goto(`${server.baseUrl}/rankings`);
  await expect(page.getByText(/This needs a game plugin\./)).toBeVisible();
  await page.goto(`${server.baseUrl}/sessions/${saturday}/awards`);
  await page.getByRole("button", { name: /add award/i }).click();
  await expect(page.getByRole("radio", { name: "Performance" })).toBeDisabled();
  await expect(page.getByText("Needs a game plugin.")).toBeVisible();
});

test("judges see the no-link panel and no banner", async ({ page }) => {
  await login(page, "judge");
  await page.goto(`${server.baseUrl}/judge/rankings`);
  await expect(page.getByText("The organizer hasn't chosen a game plugin yet.")).toBeVisible();
  await expect(page.getByText(/Choose a game plugin to set up/)).toHaveCount(0);
});

test("choosing a plugin unlocks every open page live", async ({ browser }) => {
  const other = await browser.newPage();
  await login(other);
  await other.goto(`${server.baseUrl}/sessions/${saturday}/matches`);
  await expect(other.getByText(/This needs a game plugin\./)).toBeVisible();

  const page = await browser.newPage();
  await login(page);
  await page.getByRole("link", { name: "Choose a game plugin" }).click();
  await expect(page).toHaveURL(/\/events\/setup#game-plugins/);
  await page.getByRole("button", { name: "Select for this event" }).first().click();
  await expect(page.getByRole("button", { name: "Clear selection" })).toBeVisible();

  await expect(other.getByText(/This needs a game plugin\./)).toHaveCount(0);
  await expect(other.getByText(/Choose a game plugin to set up/)).toHaveCount(0);
  await other.close();
  await page.close();
});

test("switching while unused confirms what resets, then turns skills off", async ({ page, request }) => {
  // Make sure the sample cooperative game (which has skills types) is selected, then turn skills on.
  await post(request, "/api/event/game-plugin", { name: sampleName });
  const skills = await request.put(api("/api/skills/settings"), { headers: headers(), data: { enabled: true, attempts: {} } });
  expect(skills.ok(), await skills.text()).toBeTruthy();
  await login(page);
  await page.goto(`${server.baseUrl}/events/setup`);
  await page.getByRole("button", { name: "Switch to this" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Skills challenges will be turned off.");
  await dialog.getByRole("button", { name: "Switch plugin" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Run skills challenges" })).not.toBeChecked();
});

test("award sources follow the skills switch", async ({ page, request }) => {
  await post(request, "/api/event/game-plugin", { name: sampleName });
  await login(page);
  await page.goto(`${server.baseUrl}/sessions/${saturday}/awards`);
  await page.getByRole("button", { name: /add award/i }).click();
  await page.getByRole("radio", { name: "Performance" }).check();
  const source = page.getByRole("combobox", { name: "Winner comes from" });
  await expect(source.locator("option")).toHaveText(["Teamwork ranking", "Finals"]);
  await page.getByRole("radio", { name: "Whole event" }).check();
  await expect(page.getByText("Event-wide performance awards come from skills challenges, which are off.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  const skills = await request.put(api("/api/skills/settings"), { headers: headers(), data: { enabled: true, attempts: {} } });
  expect(skills.ok()).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: /add award/i }).click();
  await page.getByRole("radio", { name: "Performance" }).check();
  await expect(page.getByRole("combobox", { name: "Winner comes from" }).locator("option")).toHaveText([
    "Teamwork ranking", "Finals", "Skills overall", "Skills type",
  ]);
});

test("a scheduled match locks the plugin", async ({ page, request }) => {
  await post(request, "/api/matches", {
    session_id: saturday, round_type: "qualification", match_number: 1, field_id: null,
    alliances: [
      { station: "red", team_ids: [teams.T1, teams.T2] },
      { station: "blue", team_ids: [teams.T3, teams.T4] },
    ],
  });
  await login(page);
  await page.goto(`${server.baseUrl}/events/setup`);
  await expect(page.getByText("Locked because matches are scheduled or skills attempts are recorded.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch to this" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clear selection" })).toHaveCount(0);
});
```

Before running, replace the guessed UI strings with the real ones from `en/admin.json`:
- the add-award button;
- the Performance and Whole-event radio labels;
- the source select label and option labels.

Also check the match-create body against the sample cooperative game's `match_format()`: its round types, alliance count and teams per alliance. If it is a single-alliance cooperative game, send one alliance with the right station name and team count. Read `server/plugins/games/sample_cooperative/plugin.py`.

`sampleName` is the uploaded sample cooperative plugin's `name`.

- [ ] **Step 2: Run the new spec**

Run: `cd frontend/apps/admin && npx playwright test tests/e2e/gamePluginGating.spec.ts`
Expected: PASS. Fix the product code, not the assertions, if a spec expectation fails for a reason the spec covers.

- [ ] **Step 3: Run the full Playwright suite**

Run: `cd frontend/apps/admin && npx playwright test`
Expected: all pass.

The shared-server specs run with the banner visible until `eventSetup.spec.ts` selects a plugin. If one fails, see whether a locator now also matches the banner, for example a broad `getByText`, `getByRole("status")`, or `getByRole("link", { name: /game plugin/i })`. Make the locator precise. Do not hide the banner.

- [ ] **Step 4: Run every other suite once more**

Run:
- `cd server && .venv/bin/python -m pytest -q`
- `cd frontend && npm run test --workspace apps/admin -- --run && npx tsc -p apps/admin --noEmit`

Expected: all pass.

- [ ] **Step 5: Update `frontend/CLAUDE.md`**

- **Gating note:** add a short paragraph near the Awards note. Cover:
  - `useGamePlugin` / `RequiresGamePlugin` / `NeedsGamePlugin` / `GamePluginBanner`;
  - which routes are wrapped in `router.tsx`;
  - `game_plugin_changed` handled in `AppShell` via `useGamePluginLiveUpdates`;
  - Event Setup's three plugin states.
- **Ports:** add `gamePluginGating.spec.ts` on 8130/5190 to the isolated-ports sentence.

- [ ] **Step 6: Commit**

```bash
git add frontend
git commit -m "Cover game plugin gating end to end: banner, locked screens, live unlock, switching with reset, award sources and the in-use lock

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
