from auth_helpers import bearer, login_as


def test_create_and_list_divisions(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post("/api/divisions", json={"name": "Elementary"})
    assert response.status_code == 201
    division_id = response.json()["id"]

    list_response = client.get("/api/divisions")
    assert list_response.status_code == 200
    assert list_response.json()[0]["id"] == division_id
    assert list_response.json()[0]["name"] == "Elementary"


def test_create_division_requires_event(client):
    response = client.post("/api/divisions", json={"name": "Elementary"})
    assert response.status_code == 401


def test_create_division_401s_without_a_token(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)  # a client sharing the same app, no auth header
    response = raw.post("/api/divisions", json={"name": "Elementary"})
    assert response.status_code == 401


def test_create_division_403s_for_non_admin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    attendee_token = login_as(raw, "attendee")

    response = raw.post(
        "/api/divisions", json={"name": "Elementary"}, headers=bearer(attendee_token)
    )
    assert response.status_code == 403


def test_list_divisions_open_to_any_authenticated_role(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    attendee_token = login_as(raw, "attendee")

    response = raw.get("/api/divisions", headers=bearer(attendee_token))
    assert response.status_code == 200
