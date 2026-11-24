from __future__ import annotations

from importlib import resources

import pytest
from device_helpers import paired_device
from skills_helpers import next_event

SLOTS = ["beep", "start", "buzzer", "moment", "stop"]
MP3 = b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\x00" * 20
MP3_SYNC = b"\xff\xfb\x90\x00" + b"\x00" * 20
OGG = b"OggS\x00\x02" + b"\x00" * 20
WAV = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 20


def _default(slot: str) -> bytes:
    return (resources.files("tournament_server") / "default_sounds" / f"{slot}.mp3").read_bytes()


def _put(client, slot, data, name="mine.mp3", **kwargs):
    return client.put(f"/api/sounds/{slot}", files={"file": (name, data, "application/octet-stream")}, **kwargs)


@pytest.fixture()
def admin(client):
    client.post("/api/event", json={"name": "Sounds"})
    return client


def test_bundled_defaults_exist_and_are_small():
    for slot in SLOTS:
        data = _default(slot)
        assert 1000 < len(data) < 100_000


def test_list_shows_five_defaults_in_order(admin):
    body = admin.get("/api/sounds").json()
    assert [row["slot"] for row in body] == SLOTS
    assert all(row == {"slot": row["slot"], "replaced": False, "filename": None, "uploaded_at": None} for row in body)


def test_default_audio_is_the_bundled_file(admin):
    response = admin.get("/api/sounds/beep/audio")
    assert response.status_code == 200
    assert response.content == _default("beep")
    assert response.headers["content-type"] == "audio/mpeg"
    assert response.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize("data,content_type", [(MP3, "audio/mpeg"), (MP3_SYNC, "audio/mpeg"), (OGG, "audio/ogg"), (WAV, "audio/wav")])
def test_each_accepted_type_is_stored_and_served(admin, data, content_type):
    response = _put(admin, "start", data, name="horn.snd")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["slot"] == "start" and body["replaced"] is True and body["filename"] == "horn.snd"
    assert body["uploaded_at"]
    listed = {row["slot"]: row for row in admin.get("/api/sounds").json()}
    assert listed["start"]["replaced"] is True and listed["start"]["filename"] == "horn.snd"
    assert listed["beep"]["replaced"] is False
    audio = admin.get("/api/sounds/start/audio")
    assert audio.content == data
    assert audio.headers["content-type"] == content_type


def test_second_upload_replaces_the_first(admin):
    _put(admin, "stop", MP3, name="one.mp3")
    _put(admin, "stop", OGG, name="two.ogg")
    assert admin.get("/api/sounds/stop/audio").content == OGG
    assert {r["slot"]: r["filename"] for r in admin.get("/api/sounds").json()}["stop"] == "two.ogg"


def test_default_query_serves_bundled_even_when_replaced(admin):
    _put(admin, "moment", MP3)
    assert admin.get("/api/sounds/moment/audio").content == MP3
    assert admin.get("/api/sounds/moment/audio?default=1").content == _default("moment")


def test_delete_restores_default_and_is_a_noop_when_default(admin):
    _put(admin, "buzzer", MP3)
    assert admin.delete("/api/sounds/buzzer").status_code == 204
    assert admin.get("/api/sounds/buzzer/audio").content == _default("buzzer")
    assert {r["slot"]: r["replaced"] for r in admin.get("/api/sounds").json()}["buzzer"] is False
    assert admin.delete("/api/sounds/buzzer").status_code == 204


def test_rejections_name_the_limit(admin):
    too_big = _put(admin, "beep", b"ID3" + b"\x00" * 1_048_576)
    assert too_big.status_code == 422 and "1 MB" in too_big.json()["detail"]
    empty = _put(admin, "beep", b"")
    assert empty.status_code == 422
    text = _put(admin, "beep", b"hello, I am not audio at all", name="fake.mp3")
    assert text.status_code == 422 and "MP3, OGG or WAV" in text.json()["detail"]
    assert admin.get("/api/sounds").json()[0]["replaced"] is False


def test_exactly_one_megabyte_is_accepted(admin):
    assert _put(admin, "beep", b"ID3" + b"\x00" * (1_048_576 - 3)).status_code == 200


def test_unknown_slot_is_404(admin):
    assert admin.get("/api/sounds/nope/audio").status_code == 404
    assert _put(admin, "nope", MP3).status_code == 404
    assert admin.delete("/api/sounds/nope").status_code == 404


def test_non_admin_cannot_change_but_can_read(admin):
    device = paired_device(admin, role="scorer")
    headers = device["headers"]
    assert _put(admin, "beep", MP3, headers=headers).status_code == 403
    assert admin.delete("/api/sounds/beep", headers=headers).status_code == 403
    assert admin.get("/api/sounds", headers=headers).status_code == 200


def test_paired_display_can_fetch_audio(admin):
    _put(admin, "beep", MP3)
    device = paired_device(admin, role="display_device")
    response = admin.get("/api/sounds/beep/audio", headers=device["headers"])
    assert response.status_code == 200 and response.content == MP3


def test_changes_broadcast_sounds_changed(admin):
    token = admin.headers["Authorization"].removeprefix("Bearer ")
    with admin.websocket_connect(f"/ws/active-session?token={token}") as socket:
        _put(admin, "stop", MP3)
        assert next_event(socket, "sounds_changed")["data"] == {"slot": "stop"}
        admin.delete("/api/sounds/stop")
        assert next_event(socket, "sounds_changed")["data"] == {"slot": "stop"}


def test_audit_row_holds_a_byte_count_not_the_data(admin):
    _put(admin, "beep", MP3)
    entries = [e for e in admin.get("/api/audit-log").json() if e["table_name"] == "event_sounds"]
    assert entries[0]["action"] == "insert"
    assert entries[0]["after"]["data"] == f"<{len(MP3)} bytes>"
    _put(admin, "beep", OGG)
    update = [e for e in admin.get("/api/audit-log").json() if e["table_name"] == "event_sounds" and e["action"] == "update"][0]
    assert update["after"]["data"] == f"<{len(OGG)} bytes>"
