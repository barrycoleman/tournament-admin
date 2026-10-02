def _make_session(client) -> int:
    client.post("/api/event", json={"name": "Regional Qualifier"})
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
    assert response.status_code == 401


def test_create_field_set_rejects_unknown_session_when_authenticated(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
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


def test_create_field_set_with_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    division_id = client.post("/api/divisions", json={"name": "Red"}).json()["id"]

    response = client.post(
        "/api/field-sets",
        json={
            "session_id": session_id,
            "name": "Red Fields",
            "division_id": division_id,
        },
    )
    assert response.status_code == 201
    assert response.json()["division_id"] == division_id


def test_create_field_set_without_division_defaults_to_none(client):
    session_id = _make_session(client)
    response = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Main Fields"}
    )
    assert response.status_code == 201
    assert response.json()["division_id"] is None


def test_create_field_set_rejects_unknown_division(client):
    session_id = _make_session(client)
    response = client.post(
        "/api/field-sets",
        json={"session_id": session_id, "name": "Main Fields", "division_id": 999},
    )
    assert response.status_code == 404


def test_patch_field_set_sets_division(client):
    session_id = _make_session(client)
    field_set_id = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Main Fields"}
    ).json()["id"]
    division_id = client.post("/api/divisions", json={"name": "Red"}).json()["id"]

    response = client.patch(
        f"/api/field-sets/{field_set_id}", json={"division_id": division_id}
    )
    assert response.status_code == 200
    assert response.json()["division_id"] == division_id


def test_patch_field_set_clears_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    division_id = client.post("/api/divisions", json={"name": "Red"}).json()["id"]
    field_set_id = client.post(
        "/api/field-sets",
        json={"session_id": session_id, "name": "Red Fields", "division_id": division_id},
    ).json()["id"]

    response = client.patch(
        f"/api/field-sets/{field_set_id}", json={"division_id": None}
    )
    assert response.status_code == 200
    assert response.json()["division_id"] is None


def test_patch_field_set_rejects_unknown_field_set(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.patch("/api/field-sets/999", json={"division_id": None})
    assert response.status_code == 404


def test_patch_field_set_rejects_unknown_division(client):
    session_id = _make_session(client)
    field_set_id = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Main Fields"}
    ).json()["id"]

    response = client.patch(
        f"/api/field-sets/{field_set_id}", json={"division_id": 999}
    )
    assert response.status_code == 404


def _make_session_with_set(client) -> tuple[int, int]:
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    field_set_id = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Gym A"}
    ).json()["id"]
    return session_id, field_set_id


def test_patch_field_set_with_empty_body_is_a_noop(client):
    session_id, field_set_id = _make_session_with_set(client)
    division_id = client.post("/api/divisions", json={"name": "Red"}).json()["id"]
    client.patch(f"/api/field-sets/{field_set_id}", json={"division_id": division_id})

    response = client.patch(f"/api/field-sets/{field_set_id}", json={})
    assert response.status_code == 200
    assert response.json()["name"] == "Gym A"
    assert response.json()["division_id"] == division_id


def test_patch_field_set_renames_without_touching_division(client):
    session_id, field_set_id = _make_session_with_set(client)
    division_id = client.post("/api/divisions", json={"name": "Red"}).json()["id"]
    client.patch(f"/api/field-sets/{field_set_id}", json={"division_id": division_id})

    response = client.patch(f"/api/field-sets/{field_set_id}", json={"name": " Gym B "})
    assert response.status_code == 200
    assert response.json()["name"] == "Gym B"
    assert response.json()["division_id"] == division_id


def test_patch_field_set_rejects_null_or_empty_name(client):
    _, field_set_id = _make_session_with_set(client)
    assert client.patch(f"/api/field-sets/{field_set_id}", json={"name": None}).status_code == 422
    assert client.patch(f"/api/field-sets/{field_set_id}", json={"name": "  "}).status_code == 422


def test_delete_field_set_removes_it_and_its_fields(client):
    session_id, field_set_id = _make_session_with_set(client)
    for name in ("Field 1", "Field 2"):
        client.post(
            "/api/fields",
            json={"session_id": session_id, "name": name, "field_set_id": field_set_id},
        )

    response = client.delete(f"/api/field-sets/{field_set_id}")
    assert response.status_code == 204
    assert client.get(f"/api/field-sets?session_id={session_id}").json() == []
    assert client.get(f"/api/fields?session_id={session_id}").json() == []


def test_delete_field_set_with_a_match_is_refused_and_keeps_its_fields(client):
    session_id, field_set_id = _make_session_with_set(client)
    field_id = client.post(
        "/api/fields",
        json={"session_id": session_id, "name": "Field 1", "field_set_id": field_set_id},
    ).json()["id"]
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    team_ids = [
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in range(1, 5)
    ]
    client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": field_id,
            "alliances": [
                {"station": "red", "team_ids": team_ids[:2]},
                {"station": "blue", "team_ids": team_ids[2:]},
            ],
        },
    )

    response = client.delete(f"/api/field-sets/{field_set_id}")
    assert response.status_code == 409
    assert response.json()["detail"] == "Field set has scheduled matches; clear the schedule first"
    assert len(client.get(f"/api/fields?session_id={session_id}").json()) == 1


def test_delete_field_set_rejects_unknown_set(client):
    _make_session_with_set(client)
    assert client.delete("/api/field-sets/999").status_code == 404


def test_field_set_writes_reject_front_desk(client):
    from tests.auth_helpers import bearer, login_as

    _, field_set_id = _make_session_with_set(client)
    headers = bearer(login_as(client, "front_desk"))
    assert client.patch(f"/api/field-sets/{field_set_id}", json={"name": "X"}, headers=headers).status_code == 403
    assert client.delete(f"/api/field-sets/{field_set_id}", headers=headers).status_code == 403
