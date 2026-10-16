from __future__ import annotations

from sqlalchemy import select

from device_helpers import paired_device
from display_helpers import (
    add_field_set,
    add_match,
    add_teams,
    assign,
    assignments,
    groups,
    setup_event,
)
from tournament_server.app import create_app
from tournament_server.models.display import DisplayGroup
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.match import Match
from tournament_server.services.deletion import delete_matches


def test_a_field_set_gets_an_audience_group_and_each_field_a_field_group(client):
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    audience = groups(client, kind="audience")
    assert [(g.field_set_id, g.session_id, g.screen, g.screen_settings, g.play_sounds) for g in audience] == [
        (field_set["id"], session_id, "logo", {}, False)
    ]
    field_groups = groups(client, kind="field")
    assert [g.field_id for g in field_groups] == field_set["field_ids"]
    assert all(g.session_id == session_id and g.screen is None for g in field_groups)


def test_the_default_field_set_made_by_adding_a_field_gets_its_audience_group(client):
    session_id = setup_event(client)
    field = client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"}).json()
    assert len(groups(client, kind="audience")) == 1
    assert [g.field_id for g in groups(client, kind="field")] == [field["id"]]


def test_deleting_a_field_deletes_its_group_and_assignments(client):
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    display = paired_device(client, role="display_device")
    field_id = field_set["field_ids"][0]
    assign(client, session_id, groups(client, field_id=field_id)[0].id, display["id"])
    assert client.delete(f"/api/fields/{field_id}").status_code == 204
    assert groups(client, field_id=field_id) == []
    assert assignments(client) == []


def test_deleting_a_field_set_deletes_its_audience_and_field_groups(client):
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    display = paired_device(client, role="display_device")
    assign(client, session_id, groups(client, kind="audience")[0].id, display["id"])
    assert client.delete(f"/api/field-sets/{field_set['id']}").status_code == 204
    assert groups(client) == []
    assert assignments(client) == []


def test_copying_fields_creates_groups_for_the_new_fields(client):
    session_id = setup_event(client)
    add_field_set(client, session_id)
    other = client.post("/api/sessions", json={"label": "Sunday"}).json()["id"]
    copied = client.post(f"/api/sessions/{other}/copy-fields", json={"source_session_id": session_id})
    assert copied.status_code == 201, copied.text
    assert len(groups(client, session_id=other, kind="audience")) == 1
    assert len(groups(client, session_id=other, kind="field")) == 2


def test_deleting_a_session_deletes_its_groups_and_assignments(client):
    session_id = setup_event(client)
    add_field_set(client, session_id)
    display = paired_device(client, role="display_device")
    assign(client, session_id, groups(client, kind="audience")[0].id, display["id"])
    with client.app.state.session_factory() as db:
        db.add(DisplayGroup(session_id=session_id, kind="pit", name="Pits", screen="teamwork_rankings", screen_settings={}))
        db.commit()
    assert client.delete(f"/api/sessions/{session_id}").status_code == 204
    assert groups(client) == []
    assert assignments(client) == []


def test_deleting_a_division_takes_it_off_pit_groups(client):
    session_id = setup_event(client)
    second = client.post("/api/divisions", json={"name": "Division 2"}).json()["id"]
    with client.app.state.session_factory() as db:
        db.add(DisplayGroup(session_id=session_id, kind="pit", name="Pits", division_id=second, screen="logo", screen_settings={}))
        db.commit()
    assert client.delete(f"/api/divisions/{second}").status_code == 204
    assert groups(client, kind="pit")[0].division_id is None


def test_startup_creates_missing_groups_once(client, tmp_path):
    session_id = setup_event(client)
    with client.app.state.session_factory() as db:
        field_set = FieldSet(session_id=session_id, name="Old Fields")
        db.add(field_set)
        db.flush()
        db.add(Field(field_set_id=field_set.id, name="Old 1"))
        db.commit()
    assert groups(client) == []
    for _ in range(2):
        app = create_app(
            db_path=str(tmp_path / "test.db"),
            plugins_root=str(tmp_path / "plugins"),
            config_path=tmp_path / "server-config.json",
        )
        with app.state.session_factory() as db:
            kinds = sorted(g.kind for g in db.execute(select(DisplayGroup)).scalars().all())
        assert kinds == ["audience", "field"]


def test_deleting_matches_clears_a_queued_override(client):
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    match = add_match(client, session_id, field_set["field_ids"][0], 1, add_teams(client))
    with client.app.state.session_factory() as db:
        db.get(FieldSet, field_set["id"]).queued_match_id = match["id"]
        db.commit()
    with client.app.state.session_factory() as db:
        delete_matches(db, [db.get(Match, match["id"])])
        db.commit()
    with client.app.state.session_factory() as db:
        assert db.get(FieldSet, field_set["id"]).queued_match_id is None
