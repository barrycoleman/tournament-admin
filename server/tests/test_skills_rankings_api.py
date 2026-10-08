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
