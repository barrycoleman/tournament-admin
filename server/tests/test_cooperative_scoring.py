def _setup_cooperative_match(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    match = client.post(
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
    red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    blue_id = next(a["id"] for a in match["alliances"] if a["station"] == "blue")
    return match["id"], red_id, blue_id, t1, t2


def test_submitting_to_one_alliance_mirrors_data_and_completes_match(cooperative_client):
    client = cooperative_client
    match_id, red_id, blue_id, t1, t2 = _setup_cooperative_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"objects_scored": 10}},
    )
    assert response.status_code == 200
    assert response.json()["computed_score"] == 20

    match = client.get(f"/api/matches/{match_id}").json()
    assert match["status"] == "completed"

    blue_response = client.get(f"/api/matches/{match_id}").json()
    blue_alliance = next(a for a in blue_response["alliances"] if a["id"] == blue_id)
    assert blue_alliance["team_ids"] == [t2]


def test_dq_on_one_alliance_does_not_affect_the_other(cooperative_client):
    client = cooperative_client
    match_id, red_id, blue_id, t1, t2 = _setup_cooperative_match(client)

    client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"objects_scored": 10}},
    )

    dq_response = client.post(
        f"/api/matches/{match_id}/alliances/{blue_id}/score",
        json={"data": {"objects_scored": 10}, "dq": True},
    )
    assert dq_response.status_code == 200
    assert dq_response.json()["computed_score"] == 0

    red_after = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"objects_scored": 10}},
    )
    assert red_after.status_code == 200
    assert red_after.json()["computed_score"] == 20
    assert red_after.json()["dq"] is False


def test_no_show_submitted_after_a_real_score_does_not_overwrite_the_real_score(
    cooperative_client,
):
    client = cooperative_client
    match_id, red_id, blue_id, t1, t2 = _setup_cooperative_match(client)

    red_response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"objects_scored": 15}},
    )
    assert red_response.status_code == 200
    assert red_response.json()["computed_score"] == 30

    blue_response = client.post(
        f"/api/matches/{match_id}/alliances/{blue_id}/score",
        json={"data": {"objects_scored": 0}, "no_show": True},
    )
    assert blue_response.status_code == 200
    assert blue_response.json()["computed_score"] == 0

    # Red's own scoresheet data must survive the blue no-show submission
    # unmirrored: re-submitting red's own real data should still compute the
    # same real score, not the zeroed data blue submitted.
    red_after = client.get(f"/api/matches/{match_id}").json()
    assert red_after["status"] == "completed"

    response = client.get("/api/rankings?event_wide=true")
    rows = {row["team_id"]: row for row in response.json()}
    assert rows[t1]["average_score"] == 30.0


def test_dq_submitted_after_a_real_score_does_not_overwrite_the_real_score(
    cooperative_client,
):
    client = cooperative_client
    match_id, red_id, blue_id, t1, t2 = _setup_cooperative_match(client)

    red_response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"objects_scored": 15}},
    )
    assert red_response.status_code == 200
    assert red_response.json()["computed_score"] == 30

    blue_response = client.post(
        f"/api/matches/{match_id}/alliances/{blue_id}/score",
        json={"data": {"objects_scored": 0}, "dq": True},
    )
    assert blue_response.status_code == 200
    assert blue_response.json()["computed_score"] == 0

    response = client.get("/api/rankings?event_wide=true")
    rows = {row["team_id"]: row for row in response.json()}
    assert rows[t1]["average_score"] == 30.0


def test_cooperative_score_ranking_is_average_no_win_loss(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    t3 = client.post("/api/teams", json={"number": "3", "name": "Team Three"}).json()["id"]

    # Match 1: T1 (red) + T2 (blue) share a scoresheet scoring 20 total.
    match1 = client.post(
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
    red1 = next(a["id"] for a in match1["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match1['id']}/alliances/{red1}/score",
        json={"data": {"objects_scored": 10}},
    )

    # Match 2: T1 (red) + T3 (blue) share a scoresheet scoring 30 total.
    match2 = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 2,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t3]},
            ],
        },
    ).json()
    red2 = next(a["id"] for a in match2["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match2['id']}/alliances/{red2}/score",
        json={"data": {"objects_scored": 15}},
    )

    response = client.get(f"/api/rankings?session_id={session_id}")
    assert response.status_code == 200
    rows = {row["team_id"]: row for row in response.json()}

    # T1 played both matches: average = (20 + 30) / 2 = 25.
    assert rows[t1]["average_score"] == 25.0
    assert rows[t1]["matches_played"] == 2
    assert rows[t1]["win_points"] == 0
    # T2 played only match 1: average = 20.
    assert rows[t2]["average_score"] == 20.0
    assert rows[t2]["matches_played"] == 1
    # T3 played only match 2: average = 30.
    assert rows[t3]["average_score"] == 30.0
    assert rows[t3]["matches_played"] == 1

    # rank_teams sorts by -average_score, so T3 (30) > T1 (25) > T2 (20).
    assert rows[t3]["rank"] == 1
    assert rows[t1]["rank"] == 2
    assert rows[t2]["rank"] == 3


def test_exclude_mode_drops_lowest_non_protected_match(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    client.post("/api/ranking-configuration", json={"mode": "exclude", "count": 1})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]

    scores = [30, 10, 20]
    for i, total in enumerate(scores, start=1):
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": i,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [t1]},
                    {"station": "blue", "team_ids": [t2]},
                ],
            },
        ).json()
        red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        client.post(
            f"/api/matches/{match['id']}/alliances/{red}/score",
            json={"data": {"objects_scored": total // 2}},
        )

    response = client.get(f"/api/rankings?session_id={session_id}")
    rows = {row["team_id"]: row for row in response.json()}

    # Lowest match (10) is dropped: average of (30, 20) = 25. matches_played
    # still reports all 3 real matches played, not the post-exclusion count.
    assert rows[t1]["average_score"] == 25.0
    assert rows[t1]["matches_played"] == 3


def test_exclude_mode_protects_no_show_match_until_toggle_allows_dropping_it(
    cooperative_client,
):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    client.post(
        "/api/ranking-configuration",
        json={"mode": "exclude", "count": 1, "allow_drop_no_show": False},
    )
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]

    # Three matches for T1: real scores of 10 and 20, plus a no_show (effective
    # score 0 regardless of the submitted data).
    match_plans = [
        {"objects_scored": 5, "no_show": False},  # score 10
        {"objects_scored": 10, "no_show": False},  # score 20
        {"objects_scored": 0, "no_show": True},  # score 0 (no_show)
    ]
    matches = []
    for i, plan in enumerate(match_plans, start=1):
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": i,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [t1]},
                    {"station": "blue", "team_ids": [t2]},
                ],
            },
        ).json()
        red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        blue = next(a["id"] for a in match["alliances"] if a["station"] == "blue")
        matches.append((match["id"], red, plan))
        if plan["no_show"]:
            # A flags-only no_show ruling no longer mirrors onto the partner
            # alliance (that's the fix under test elsewhere), so seed blue
            # with its own real record first to let the match complete.
            client.post(
                f"/api/matches/{match['id']}/alliances/{blue}/score",
                json={"data": {"objects_scored": plan["objects_scored"]}},
            )
        client.post(
            f"/api/matches/{match['id']}/alliances/{red}/score",
            json={"data": {"objects_scored": plan["objects_scored"]}, "no_show": plan["no_show"]},
        )

    response = client.get(f"/api/rankings?session_id={session_id}")
    rows = {row["team_id"]: row for row in response.json()}

    # Scores are 10, 20, 0 (no_show). allow_drop_no_show=False means the
    # no_show match is not eligible to be the dropped one even though it is
    # the lowest; the drop loop instead drops the next-lowest *droppable*
    # match (10), leaving (0 + 20) / 2 = 10.0.
    assert rows[t1]["average_score"] == 10.0

    # Flip the toggle: the no_show match becomes droppable and, being the
    # lowest score, is the one actually dropped: (10 + 20) / 2 = 15.0.
    client.post(
        "/api/ranking-configuration",
        json={"mode": "exclude", "count": 1, "allow_drop_no_show": True},
    )
    # Re-submitting a score (any alliance in the session) triggers a ranking
    # recompute against the now-updated configuration.
    match_id, red_id, plan = matches[0]
    client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"objects_scored": plan["objects_scored"]}, "no_show": plan["no_show"]},
    )

    response = client.get(f"/api/rankings?session_id={session_id}")
    rows = {row["team_id"]: row for row in response.json()}
    assert rows[t1]["average_score"] == 15.0


def test_include_mode_zero_pads_a_team_with_fewer_matches_than_count(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    client.post("/api/ranking-configuration", json={"mode": "include", "count": 3})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]

    match = client.post(
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
    red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match['id']}/alliances/{red}/score",
        json={"data": {"objects_scored": 15}},
    )

    response = client.get(f"/api/rankings?session_id={session_id}")
    rows = {row["team_id"]: row for row in response.json()}

    # T1 played 1 real match scoring 30; count=3 pads in 2 zero matches:
    # (30 + 0 + 0) / 3 = 10.
    assert rows[t1]["average_score"] == 10.0
    assert rows[t1]["matches_played"] == 1


def test_event_wide_ranking_aggregates_across_sessions(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]

    session_scores = {"Session 1": 20, "Session 2": 40}
    for label, total in session_scores.items():
        session_id = client.post("/api/sessions", json={"label": label}).json()["id"]
        match = client.post(
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
        red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        client.post(
            f"/api/matches/{match['id']}/alliances/{red}/score",
            json={"data": {"objects_scored": total // 2}},
        )

    response = client.get("/api/rankings?event_wide=true")
    assert response.status_code == 200
    rows = {row["team_id"]: row for row in response.json()}

    # Average across both sessions: (20 + 40) / 2 = 30.
    assert rows[t1]["average_score"] == 30.0
    assert rows[t1]["matches_played"] == 2
    assert rows[t1]["session_id"] is None


def test_clearing_a_session_removes_stale_event_wide_ranking_for_a_team_with_no_matches_left(
    cooperative_client,
):
    client = cooperative_client
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    t3 = client.post("/api/teams", json={"number": "3", "name": "Team Three"}).json()["id"]

    session1_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    session2_id = client.post("/api/sessions", json={"label": "Session 2"}).json()["id"]

    # Session 1: T1 + T2 share a scoresheet scoring 20 total. T1's only
    # event-wide completed match lives here.
    match1 = client.post(
        "/api/matches",
        json={
            "session_id": session1_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t2]},
            ],
        },
    ).json()
    red1 = next(a["id"] for a in match1["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match1['id']}/alliances/{red1}/score",
        json={"data": {"objects_scored": 10}},
    )

    # Session 2: T2 + T3 share a scoresheet scoring 40 total.
    match2 = client.post(
        "/api/matches",
        json={
            "session_id": session2_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t2]},
                {"station": "blue", "team_ids": [t3]},
            ],
        },
    ).json()
    red2 = next(a["id"] for a in match2["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match2['id']}/alliances/{red2}/score",
        json={"data": {"objects_scored": 20}},
    )

    # Before clearing: T1 has a real event-wide ranking row (1 match, average
    # 20). T2 aggregates both sessions: (20 + 40) / 2 = 30, 2 matches.
    before = {
        row["team_id"]: row
        for row in client.get("/api/rankings?event_wide=true").json()
    }
    assert before[t1]["average_score"] == 20.0
    assert before[t1]["matches_played"] == 1
    assert before[t2]["average_score"] == 30.0
    assert before[t2]["matches_played"] == 2

    # Clear Session 1's schedule. T1's only completed match anywhere in the
    # event disappears with it, so T1 should have no event-wide ranking row
    # at all afterward — not a stale row still showing its pre-deletion
    # average_score/matches_played.
    delete_response = client.delete(
        "/api/schedule",
        params={"session_id": session1_id, "round_type": "qualification"},
    )
    assert delete_response.status_code == 200

    after = {
        row["team_id"]: row
        for row in client.get("/api/rankings?event_wide=true").json()
    }
    assert t1 not in after

    # T2's remaining event-wide match is only Session 2's now: average 40,
    # 1 match played.
    assert after[t2]["average_score"] == 40.0
    assert after[t2]["matches_played"] == 1


def test_clearing_every_completed_match_in_the_event_persists_empty_event_wide_rankings(
    cooperative_client,
):
    client = cooperative_client
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]

    session1_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    session2_id = client.post("/api/sessions", json={"label": "Session 2"}).json()["id"]

    # Score and complete one match in each of the event's two sessions, so
    # real event-wide Ranking rows exist for both teams before we clear
    # every completed match in the event.
    match1 = client.post(
        "/api/matches",
        json={
            "session_id": session1_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t2]},
            ],
        },
    ).json()
    red1 = next(a["id"] for a in match1["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match1['id']}/alliances/{red1}/score",
        json={"data": {"objects_scored": 10}},
    )

    match2 = client.post(
        "/api/matches",
        json={
            "session_id": session2_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t2]},
            ],
        },
    ).json()
    red2 = next(a["id"] for a in match2["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match2['id']}/alliances/{red2}/score",
        json={"data": {"objects_scored": 20}},
    )

    before = client.get("/api/rankings?event_wide=true").json()
    assert {row["team_id"] for row in before} == {t1, t2}

    # Clear both sessions' schedules, leaving zero completed matches
    # anywhere in the event. recompute_event_rankings exits early (no
    # commit) on this path since there are no team results left, so the
    # event-wide deletion above it must be durably committed on its own —
    # not just flushed within a transaction that never gets committed.
    for session_id in (session1_id, session2_id):
        delete_response = client.delete(
            "/api/schedule",
            params={"session_id": session_id, "round_type": "qualification"},
        )
        assert delete_response.status_code == 200

    after = client.get("/api/rankings?event_wide=true").json()
    assert after == []
