"""The sample cooperative game that ships with the server.

Unlike the fixtures under tests/fixtures/plugins/, this plugin is part of
the distribution (plugins/games/sample_cooperative/), so a fresh install
can select a game and build a schedule without writing a plugin first.
These tests run it through the same contract checks a plugin author would
(`tm test-plugin`) and then through a full event against a real app.
"""

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from auth_helpers import TEST_PASSWORD
from plugin_helpers import zip_fixture_plugin
from tournament_server.app import create_app
from tournament_server.cli import main
from tournament_server.plugin_registry.conformance import run_conformance_checks
from tournament_server.plugin_registry.discovery import discover_game_plugins
from tournament_server.plugin_registry.loader import GAME_PLUGIN_KIND, load_plugin
from tournament_server.plugin_registry.zip_install import install_plugin_zip

PLUGINS_ROOT = Path(__file__).parent.parent / "plugins"
SAMPLE_PLUGIN = PLUGINS_ROOT / "games" / "sample_cooperative"
SIMPLE_RANDOM_PLUGIN = PLUGINS_ROOT / "schedulers" / "simple_random"


# ---------- The plugin on its own ----------


def test_loads_as_a_game_plugin():
    plugin = load_plugin(SAMPLE_PLUGIN, GAME_PLUGIN_KIND)
    assert plugin.name == "sample_cooperative"
    assert plugin.display_name == "Sample Cooperative Game"


def test_is_discovered_from_the_shipped_plugins_folder():
    assert "sample_cooperative" in discover_game_plugins(PLUGINS_ROOT)


def test_installs_from_a_zip(tmp_path):
    plugin = install_plugin_zip(
        zip_fixture_plugin(SAMPLE_PLUGIN), tmp_path / "plugins", GAME_PLUGIN_KIND
    )
    assert plugin.name == "sample_cooperative"


def test_passes_conformance():
    report = run_conformance_checks(SAMPLE_PLUGIN)
    assert report.passed, [c for c in report.checks if not c.passed]


def test_cli_test_plugin_passes(capsys):
    assert main(["test-plugin", str(SAMPLE_PLUGIN)]) == 0


def test_match_format_is_a_cooperative_score_chase():
    match_format = load_plugin(SAMPLE_PLUGIN, GAME_PLUGIN_KIND).module.match_format()
    assert match_format == {
        "alliance_count": 2,
        "teams_per_alliance": 1,
        "autonomous_seconds": 0,
        "driver_seconds": 60,
        "round_types": ["practice", "qualification", "elimination"],
        "game_model": "cooperative_score",
        "alliance_selection": "seed_pairing",
        "finals_format": "score_chase",
    }


def test_the_score_is_the_number_entered():
    module = load_plugin(SAMPLE_PLUGIN, GAME_PLUGIN_KIND).module
    assert module.calculate_score({"score": 0}) == 0
    assert module.calculate_score({"score": 57}) == 57
    assert module.calculate_score({}) == 0
    assert module.calculate_skills_score({"score": 42}) == 42


@pytest.mark.parametrize(
    ("score", "valid"),
    [(0, True), (57, True), (999, True), (-1, False), (1000, False)],
)
def test_validate_rejects_negative_and_out_of_range_scores(score, valid):
    module = load_plugin(SAMPLE_PLUGIN, GAME_PLUGIN_KIND).module
    assert (module.validate({"score": score}) == []) is valid


# ---------- A full event against a real app ----------


@pytest.fixture()
def sample_client(tmp_path):
    """An app whose plugins folder holds only what ships: this game and a scheduler."""
    plugins_root = tmp_path / "plugins"
    shutil.copytree(SAMPLE_PLUGIN, plugins_root / "games" / "sample_cooperative")
    shutil.copytree(SIMPLE_RANDOM_PLUGIN, plugins_root / "schedulers" / "simple_random")
    app = create_app(
        db_path=str(tmp_path / "test.db"),
        plugins_root=str(plugins_root),
        config_path=tmp_path / "server-config.json",
    )
    with TestClient(app) as client:
        client.post("/api/event", json={"name": "Sample Event", "password": TEST_PASSWORD})
        token = client.post(
            "/api/auth/login", json={"role": "admin", "password": TEST_PASSWORD}
        ).json()["access_token"]
        client.headers["Authorization"] = f"Bearer {token}"
        assert (
            client.post("/api/event/game-plugin", json={"name": "sample_cooperative"}).status_code
            == 200
        )
        yield client


def _checked_in_session(client, team_count: int) -> tuple[int, list[int]]:
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})
    team_ids = []
    for i in range(team_count):
        team_id = client.post(
            "/api/teams", json={"number": str(101 + i), "name": f"Team {i + 1}"}
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
        team_ids.append(team_id)
    return session_id, team_ids


def _score(client, match_id: int, alliance_id: int, score: int, **flags) -> dict:
    response = client.post(
        f"/api/matches/{match_id}/alliances/{alliance_id}/score",
        json={"data": {"score": score}, **flags},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_match_format_endpoint_reports_a_sixty_second_match(sample_client):
    body = sample_client.get("/api/event/match-format").json()
    assert body["match_duration_seconds"] == 60
    assert body["alliance_count"] == 2
    assert body["teams_per_alliance"] == 1


def test_a_schedule_can_be_generated(sample_client):
    session_id, team_ids = _checked_in_session(sample_client, 6)
    response = sample_client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 4,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 201, response.text

    matches = sample_client.get(f"/api/matches?session_id={session_id}").json()
    assert matches
    for match in matches:
        assert [len(a["team_ids"]) for a in match["alliances"]] == [1, 1]


def test_both_teams_get_the_score_and_a_dq_zeroes_only_one(sample_client):
    session_id, (t1, t2) = _checked_in_session(sample_client, 2)
    match = sample_client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t2]},
            ],
        },
    ).json()
    red, blue = (a["id"] for a in match["alliances"])

    assert _score(sample_client, match["id"], red, 57)["computed_score"] == 57
    assert sample_client.get(f"/api/matches/{match['id']}").json()["status"] == "completed"
    rankings = {
        row["team_id"]: row["average_score"]
        for row in sample_client.get(f"/api/rankings?session_id={session_id}").json()
    }
    assert rankings == {t1: 57.0, t2: 57.0}

    assert _score(sample_client, match["id"], blue, 57, dq=True)["computed_score"] == 0
    rankings = {
        row["team_id"]: row["average_score"]
        for row in sample_client.get(f"/api/rankings?session_id={session_id}").json()
    }
    assert rankings == {t1: 57.0, t2: 0.0}


def test_rankings_order_teams_by_average_score(sample_client):
    session_id, (t1, t2, t3, t4) = _checked_in_session(sample_client, 4)
    # Two matches: t1+t2 score 80, t3+t4 score 30.
    for number, (a, b, score) in enumerate([(t1, t2, 80), (t3, t4, 30)], start=1):
        match = sample_client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": number,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [a]},
                    {"station": "blue", "team_ids": [b]},
                ],
            },
        ).json()
        _score(sample_client, match["id"], match["alliances"][0]["id"], score)

    rows = sample_client.get(f"/api/rankings?session_id={session_id}").json()
    by_rank = sorted(rows, key=lambda row: row["rank"])
    assert {row["team_id"] for row in by_rank[:2]} == {t1, t2}
    assert {row["team_id"] for row in by_rank[2:]} == {t3, t4}


def test_seed_paired_score_chase_finals_run_to_completion(sample_client):
    session_id, team_ids = _checked_in_session(sample_client, 4)
    # Rank the four teams 1..4 with one qualification match each pair:
    # (team 1, team 2) score 90, (team 3, team 4) score 40.
    pairs = [(team_ids[0], team_ids[1], 90), (team_ids[2], team_ids[3], 40)]
    for number, (a, b, score) in enumerate(pairs, start=1):
        match = sample_client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": number,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [a]},
                    {"station": "blue", "team_ids": [b]},
                ],
            },
        ).json()
        _score(sample_client, match["id"], match["alliances"][0]["id"], score)

    response = sample_client.post(
        "/api/finals/start", json={"session_id": session_id, "bracket_size": 2}
    )
    assert response.status_code == 201, response.text
    bracket = response.json()

    # Seed pairing: ranks 1+2 form the top alliance, 3+4 the second.
    alliance_team_sets = [set(a["team_ids"]) for a in bracket["alliances"]]
    assert alliance_team_sets == [set(team_ids[:2]), set(team_ids[2:])]

    # The worst seed runs first, alone, as one alliance of both its teams.
    for run_score in (70, 50):
        current = sample_client.get(f"/api/finals/{bracket['id']}").json()
        run_match_id = current["runs"][-1]["match_id"]
        run_alliances = sample_client.get(f"/api/matches/{run_match_id}").json()["alliances"]
        assert len(run_alliances) == 1
        assert len(run_alliances[0]["team_ids"]) == 2
        _score(sample_client, run_match_id, run_alliances[0]["id"], run_score)

    final = sample_client.get(f"/api/finals/{bracket['id']}").json()
    assert final["status"] == "complete"
    assert [(r["rank"], r["score"]) for r in final["results"]] == [(1, 70), (2, 50)]
