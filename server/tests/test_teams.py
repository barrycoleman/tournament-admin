from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.bracket_alliance import BracketAlliance, BracketAllianceTeam
from tournament_server.models.field_set import FieldSet
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.match import Match
from tournament_server.models.ranking import Ranking


def test_create_team_assigns_tiebreaker_seed(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response1 = client.post(
        "/api/teams",
        json={"number": "1234A", "name": "Robo Raiders", "organization": "Example School"},
    )
    assert response1.status_code == 201
    body1 = response1.json()
    assert body1["number"] == "1234A"
    assert body1["organization"] == "Example School"
    assert isinstance(body1["tiebreaker_seed"], int)

    response2 = client.post(
        "/api/teams",
        json={"number": "5678B", "name": "Circuit Breakers", "organization": "Another School"},
    )
    assert response2.status_code == 201
    body2 = response2.json()
    assert isinstance(body2["tiebreaker_seed"], int)

    # Verify randomness by confirming two teams have different seeds
    # With random.randint(1, 1_000_000_000), collision probability is vanishingly small
    assert body1["tiebreaker_seed"] != body2["tiebreaker_seed"]


def test_create_team_requires_event(client):
    response = client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    assert response.status_code == 401


def test_list_teams(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    client.post("/api/teams", json={"number": "5678B", "name": "Circuit Breakers"})

    response = client.get("/api/teams")
    assert response.status_code == 200
    numbers = {t["number"] for t in response.json()}
    assert numbers == {"1234A", "5678B"}


def test_get_team(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.get(f"/api/teams/{team_id}")
    assert response.status_code == 200
    assert response.json()["number"] == "1234A"


def test_get_missing_team_returns_404(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.get("/api/teams/999")
    assert response.status_code == 404


def test_update_team(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.patch(f"/api/teams/{team_id}", json={"name": "Robo Raiders Renamed"})
    assert response.status_code == 200
    assert response.json()["name"] == "Robo Raiders Renamed"
    assert response.json()["number"] == "1234A"


def test_create_team_with_nonexistent_division_returns_404(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post(
        "/api/teams",
        json={"number": "1234A", "name": "Robo Raiders", "division_id": 999},
    )
    assert response.status_code == 404


def test_create_team_with_valid_division_succeeds(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division_id = client.post("/api/divisions", json={"name": "Elementary"}).json()["id"]

    response = client.post(
        "/api/teams",
        json={"number": "1234A", "name": "Robo Raiders", "division_id": division_id},
    )
    assert response.status_code == 201
    assert response.json()["division_id"] == division_id


def test_update_team_with_nonexistent_division_returns_404(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.patch(f"/api/teams/{team_id}", json={"division_id": 999})
    assert response.status_code == 404


def test_update_team_with_null_name_returns_422(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.patch(f"/api/teams/{team_id}", json={"name": None})
    assert response.status_code == 422


def test_update_team_with_null_number_returns_422(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.patch(f"/api/teams/{team_id}", json={"number": None})
    assert response.status_code == 422


def test_update_team_with_valid_name_still_returns_200(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.patch(f"/api/teams/{team_id}", json={"name": "New Name"})
    assert response.status_code == 200
    assert response.json()["name"] == "New Name"


def test_patch_team_rejects_front_desk(client):
    """front_desk's broadened access is scoped to exactly
    POST /api/sessions/{id}/participants -- every other admin-only
    endpoint, including this one, must still 403 it."""
    from tests.auth_helpers import bearer, login_as

    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    front_desk_token = login_as(client, "front_desk")
    response = client.patch(
        f"/api/teams/{team_id}",
        json={"name": "New Name"},
        headers=bearer(front_desk_token),
    )
    assert response.status_code == 403


def test_create_team_with_robot_name(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/teams",
        json={"number": "1234A", "name": "Robo Raiders", "robot_name": "Ironclad"},
    )
    assert response.status_code == 201
    assert response.json()["robot_name"] == "Ironclad"


def test_create_team_duplicate_number_returns_409(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    response = client.post("/api/teams", json={"number": "1234A", "name": "Circuit Breakers"})
    assert response.status_code == 409


def test_update_team_to_duplicate_number_returns_409(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    second = client.post("/api/teams", json={"number": "5678B", "name": "Circuit Breakers"})
    team_id = second.json()["id"]
    response = client.patch(f"/api/teams/{team_id}", json={"number": "1234A"})
    assert response.status_code == 409


def test_delete_team(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    created = client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    team_id = created.json()["id"]

    response = client.delete(f"/api/teams/{team_id}")
    assert response.status_code == 204

    get_response = client.get(f"/api/teams/{team_id}")
    assert get_response.status_code == 404


def test_delete_team_404s_when_not_found(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.delete("/api/teams/999")
    assert response.status_code == 404


def test_delete_team_409s_with_session_participation(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team = client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"}).json()
    session = client.post("/api/sessions", json={"label": "Day 1"}).json()
    client.post(
        f"/api/sessions/{session['id']}/participants",
        json={"team_id": team["id"]},
    )

    response = client.delete(f"/api/teams/{team['id']}")
    assert response.status_code == 409
    assert "participation" in response.json()["detail"].lower()


def test_delete_team_409s_with_ranking(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team = client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"}).json()

    db = client.app.state.session_factory()
    db.add(Ranking(team_id=team["id"]))
    db.commit()
    db.close()

    response = client.delete(f"/api/teams/{team['id']}")
    assert response.status_code == 409
    assert "rankings" in response.json()["detail"]


def test_delete_team_409s_with_alliance_assignment(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team = client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"}).json()
    session = client.post("/api/sessions", json={"label": "Day 1"}).json()

    db = client.app.state.session_factory()
    match = Match(session_id=session["id"], round_type="qualification", match_number=1)
    db.add(match)
    db.flush()
    alliance = Alliance(match_id=match.id, station="red")
    db.add(alliance)
    db.flush()
    db.add(AllianceTeam(alliance_id=alliance.id, team_id=team["id"]))
    db.commit()
    db.close()

    response = client.delete(f"/api/teams/{team['id']}")
    assert response.status_code == 409
    assert "alliance assignments" in response.json()["detail"]


def test_delete_team_409s_with_bracket_alliance_assignment(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team = client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"}).json()
    session = client.post("/api/sessions", json={"label": "Day 1"}).json()

    db = client.app.state.session_factory()
    field_set = FieldSet(session_id=session["id"], name="Main Fields")
    db.add(field_set)
    db.flush()
    bracket = FinalsBracket(
        session_id=session["id"],
        field_set_id=field_set.id,
        format="single_elimination",
        bracket_size=2,
    )
    db.add(bracket)
    db.flush()
    bracket_alliance = BracketAlliance(bracket_id=bracket.id, seed=1)
    db.add(bracket_alliance)
    db.flush()
    db.add(
        BracketAllianceTeam(bracket_alliance_id=bracket_alliance.id, team_id=team["id"])
    )
    db.commit()
    db.close()

    response = client.delete(f"/api/teams/{team['id']}")
    assert response.status_code == 409
    assert "bracket alliance assignments" in response.json()["detail"]


def test_bulk_upsert_creates_new_teams(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/teams/bulk",
        json={
            "rows": [
                {"number": "1234A", "name": "Robo Raiders"},
                {"number": "5678B", "name": "Circuit Breakers", "robot_name": "Ironclad"},
            ]
        },
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert [r["status"] for r in results] == ["created", "created"]
    assert results[1]["team"]["robot_name"] == "Ironclad"


def test_bulk_upsert_updates_existing_team_by_number(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})

    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "1234A", "name": "Robo Raiders Renamed"}]},
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert results[0]["status"] == "updated"
    assert results[0]["team"]["name"] == "Robo Raiders Renamed"

    list_response = client.get("/api/teams")
    assert len(list_response.json()) == 1  # no duplicate created


def test_bulk_upsert_with_id_changes_number_in_place(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post("/api/teams", json={"number": "101", "name": "Robo Raiders"}).json()["id"]

    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"id": team_id, "number": "101F", "name": "Robo Raiders"}]},
    )
    result = response.json()["results"][0]
    assert result["status"] == "updated"
    assert result["team"]["id"] == team_id
    assert result["team"]["number"] == "101F"

    teams = client.get("/api/teams").json()
    assert [(t["id"], t["number"]) for t in teams] == [(team_id, "101F")]


def test_bulk_upsert_with_id_rejects_number_taken_by_another_team(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    first_id = client.post("/api/teams", json={"number": "101", "name": "A"}).json()["id"]
    client.post("/api/teams", json={"number": "202", "name": "B"})

    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"id": first_id, "number": "202", "name": "A"}]},
    )
    result = response.json()["results"][0]
    assert result["status"] == "error"
    assert "202" in result["error"]

    numbers = sorted(t["number"] for t in client.get("/api/teams").json())
    assert numbers == ["101", "202"]


def test_bulk_upsert_with_unknown_id_is_a_row_error(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"id": 9999, "number": "101", "name": "A"}]},
    )
    result = response.json()["results"][0]
    assert result["status"] == "error"
    assert client.get("/api/teams").json() == []


def test_bulk_upsert_partial_failure_still_commits_good_rows(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/teams/bulk",
        json={
            "rows": [
                {"number": "1234A", "name": "Robo Raiders"},
                {"number": "5678B", "name": "Circuit Breakers", "division": "Nonexistent Division"},
                {"number": "9999C", "name": "Third Team"},
            ]
        },
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert results[0]["status"] == "created"
    assert results[1]["status"] == "error"
    assert "Nonexistent Division" in results[1]["error"]
    assert results[2]["status"] == "created"

    list_response = client.get("/api/teams")
    numbers = {t["number"] for t in list_response.json()}
    assert numbers == {"1234A", "9999C"}


def test_bulk_upsert_division_name_is_case_insensitive(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division = client.post("/api/divisions", json={"name": "Elementary"}).json()

    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "1234A", "name": "Robo Raiders", "division": "elementary"}]},
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert results[0]["status"] == "created"
    assert results[0]["team"]["division_id"] == division["id"]


def test_bulk_upsert_missing_required_field_is_a_row_error(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "", "name": "Robo Raiders"}]},
    )
    assert response.status_code == 200
    assert response.json()["results"][0]["status"] == "error"


def test_bulk_upsert_omitted_required_key_is_a_row_error_not_a_422(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"name": "Robo Raiders"}]},  # no "number" key at all
    )
    assert response.status_code == 200
    assert response.json()["results"][0]["status"] == "error"


def test_bulk_upsert_assign_random_division_distributes_across_divisions(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/divisions", json={"name": "A"})
    client.post("/api/divisions", json={"name": "B"})

    response = client.post(
        "/api/teams/bulk",
        json={
            "rows": [
                {"number": "0001A", "name": "T1", "assign_random_division": True},
                {"number": "0002A", "name": "T2", "assign_random_division": True},
            ]
        },
    )
    assert response.status_code == 200
    results = response.json()["results"]
    division_ids = {r["team"]["division_id"] for r in results}
    assert None not in division_ids
    # The event now has 3 divisions (the 2 created above plus the
    # auto-seeded "Division 1") and no pre-existing teams, so the
    # balanced algorithm's fewest-count selection must still put the 2
    # teams in 2 distinct divisions among the 3 available -- not
    # necessarily "one in each of exactly two".
    assert len(division_ids) == 2


def test_bulk_upsert_matches_existing_team_despite_surrounding_whitespace(client):
    """A pasted or CSV-sourced number can carry stray whitespace. It must
    match the existing team rather than attempting a second team with a
    visually identical number (which the (event_id, number) uniqueness
    constraint would then reject with a 409 for the whole request)."""
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})

    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "  1234A  ", "name": "  Robo Raiders Renamed  "}]},
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert results[0]["status"] == "updated"
    assert results[0]["team"]["number"] == "1234A"
    assert results[0]["team"]["name"] == "Robo Raiders Renamed"

    assert len(client.get("/api/teams").json()) == 1  # no duplicate created


def test_bulk_upsert_empty_rows_is_a_no_op(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/teams/bulk", json={"rows": []})
    assert response.status_code == 200
    assert response.json()["results"] == []


def test_create_team_with_no_division_specified_joins_the_sole_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division_id = client.get("/api/divisions").json()[0]["id"]  # the auto-seeded "Division 1"

    response = client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    assert response.status_code == 201
    assert response.json()["division_id"] == division_id


def test_bulk_upsert_with_no_division_specified_joins_the_sole_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division_id = client.get("/api/divisions").json()[0]["id"]  # the auto-seeded "Division 1"

    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "1234A", "name": "Robo Raiders"}]},
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert results[0]["status"] == "created"
    assert results[0]["team"]["division_id"] == division_id

    # No dedicated GET /api/divisions/{id} endpoint exists to check a
    # division's team count directly -- confirm via GET /api/teams instead,
    # which is what the user actually observed as wrong (a team with no
    # division_id, which is what made the Divisions page's count read 0).
    teams = client.get("/api/teams").json()
    assert len(teams) == 1
    assert teams[0]["division_id"] == division_id


def test_bulk_upsert_updated_row_with_no_division_specified_rejoins_the_sole_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division_id = client.get("/api/divisions").json()[0]["id"]  # the auto-seeded "Division 1"
    client.post(
        "/api/teams",
        json={"number": "1234A", "name": "Robo Raiders", "division_id": division_id},
    )

    # Re-uploading a roster CSV that omits the division column is the
    # single most common real operation on this endpoint -- the team
    # must rejoin the sole division, not stay unassigned, and the HTTP
    # response itself must reflect that (not just the database).
    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "1234A", "name": "Robo Raiders Renamed"}]},
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert results[0]["status"] == "updated"
    assert results[0]["team"]["division_id"] == division_id

    teams = client.get("/api/teams").json()
    assert teams[0]["division_id"] == division_id


def test_bulk_upsert_does_not_override_an_explicitly_named_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/divisions", json={"name": "Elementary"})
    # The event now has two divisions ("Division 1" and "Elementary"), so
    # assign_sole_division must not fire at all here.

    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "1234A", "name": "Robo Raiders", "division": "Elementary"}]},
    )
    assert response.status_code == 200
    results = response.json()["results"]
    matched_division = next(d for d in client.get("/api/divisions").json() if d["name"] == "Elementary")
    assert results[0]["team"]["division_id"] == matched_division["id"]


def test_bulk_upsert_with_multiple_divisions_leaves_unspecified_rows_unassigned(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/divisions", json={"name": "Elementary"})
    # Two divisions now exist ("Division 1" plus "Elementary") -- omitting
    # a division for a row is a genuine ambiguity here, not an implicit
    # single choice, so the team must stay unassigned.

    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "1234A", "name": "Robo Raiders"}]},
    )
    assert response.status_code == 200
    assert response.json()["results"][0]["team"]["division_id"] is None
