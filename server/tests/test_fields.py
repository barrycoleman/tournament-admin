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
