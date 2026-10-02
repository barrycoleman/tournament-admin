def _make_session(client) -> int:
    client.post("/api/event", json={"name": "Regional Qualifier"})
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


def _make_match_on_field(client, session_id: int, field_id: int) -> None:
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    team_ids = [
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in range(1, 5)
    ]
    response = client.post(
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
    assert response.status_code == 201, response.text


def test_patch_field_renames_it(client):
    session_id = _make_session(client)
    field_id = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    ).json()["id"]

    response = client.patch(f"/api/fields/{field_id}", json={"name": "  Arena 2  "})
    assert response.status_code == 200
    assert response.json()["name"] == "Arena 2"


def test_patch_field_rejects_an_empty_name(client):
    session_id = _make_session(client)
    field_id = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    ).json()["id"]

    response = client.patch(f"/api/fields/{field_id}", json={"name": "   "})
    assert response.status_code == 422


def test_patch_field_rejects_unknown_field(client):
    _make_session(client)
    response = client.patch("/api/fields/999", json={"name": "Arena"})
    assert response.status_code == 404


def test_delete_field_removes_it(client):
    session_id = _make_session(client)
    field_id = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    ).json()["id"]

    response = client.delete(f"/api/fields/{field_id}")
    assert response.status_code == 204
    assert client.get(f"/api/fields?session_id={session_id}").json() == []


def test_delete_field_with_a_match_is_refused(client):
    session_id = _make_session(client)
    field_id = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    ).json()["id"]
    _make_match_on_field(client, session_id, field_id)

    response = client.delete(f"/api/fields/{field_id}")
    assert response.status_code == 409
    assert response.json()["detail"] == "Field has scheduled matches; clear the schedule first"
    assert len(client.get(f"/api/fields?session_id={session_id}").json()) == 1


def test_delete_field_rejects_unknown_field(client):
    _make_session(client)
    assert client.delete("/api/fields/999").status_code == 404


def test_field_writes_reject_front_desk(client):
    from tests.auth_helpers import bearer, login_as

    session_id = _make_session(client)
    field_id = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    ).json()["id"]
    headers = bearer(login_as(client, "front_desk"))

    assert client.patch(f"/api/fields/{field_id}", json={"name": "X"}, headers=headers).status_code == 403
    assert client.delete(f"/api/fields/{field_id}", headers=headers).status_code == 403
