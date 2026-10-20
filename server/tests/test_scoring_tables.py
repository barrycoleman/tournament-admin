"""The live-scoring tables: defaults, unique keys, cascades and the audit
exclusions (live scoring design section 4)."""
from __future__ import annotations

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from device_helpers import paired_device
from display_helpers import add_field_set, add_match, add_teams, setup_event
from tournament_server.audit import AuditLog
from tournament_server.models.field_set import SKILLS, TEAMWORK, FieldSet
from tournament_server.models.match import Match
from tournament_server.models.scoring_draft import ScoreDraft, ScorerBinding, SkillsRun, SkillsSetTimer
from tournament_server.models.session import TournamentSession
from tournament_server.models.skills import SkillsAttempt
from tournament_server.services.deletion import delete_matches

LIVE_TABLES = ("score_drafts", "skills_set_timers", "skills_runs", "scorer_bindings")


def _skills_rows(client) -> dict:
    """A set with two fields, a timer on the set, a run and a binding on its first field."""
    session_id = setup_event(client)
    skills_set = add_field_set(client, session_id, name="Skills", fields=("Skills 1", "Skills 2"))
    team_id = add_teams(client, count=1)[0]
    device = paired_device(client, role="scorer")
    with client.app.state.session_factory() as db:
        db.add(SkillsSetTimer(field_set_id=skills_set["id"]))
        db.add(
            SkillsRun(
                field_id=skills_set["field_ids"][0],
                field_set_id=skills_set["id"],
                session_id=session_id,
                team_id=team_id,
                skills_type="driver",
            )
        )
        db.add(ScorerBinding(session_id=session_id, device_id=device["id"], field_id=skills_set["field_ids"][0]))
        db.commit()
    return {"session_id": session_id, "set": skills_set, "team_id": team_id, "device": device}


def _count(client, model) -> int:
    with client.app.state.session_factory() as db:
        return len(db.execute(select(model)).scalars().all())


def test_field_sets_are_teamwork_and_sessions_show_qualification_scores_by_default(client):
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    assert (TEAMWORK, SKILLS) == ("teamwork", "skills")
    with client.app.state.session_factory() as db:
        assert db.get(FieldSet, field_set["id"]).purpose == "teamwork"
        session_obj = db.get(TournamentSession, session_id)
        assert session_obj.live_scores_qualification is True
        assert session_obj.live_scores_finals is False


def test_the_database_fills_the_new_defaults_for_rows_written_without_them(client):
    session_id = setup_event(client)
    with client.app.state.session_factory() as db:
        event_id = db.get(TournamentSession, session_id).event_id
        db.execute(text("INSERT INTO sessions (event_id, label) VALUES (:event_id, 'Raw')"), {"event_id": event_id})
        db.execute(
            text("INSERT INTO field_sets (session_id, name) VALUES (:session_id, 'Raw Set')"),
            {"session_id": session_id},
        )
        db.commit()
        switches = db.execute(
            text("SELECT live_scores_qualification, live_scores_finals FROM sessions WHERE label = 'Raw'")
        ).one()
        assert tuple(switches) == (1, 0)
        purpose = db.execute(text("SELECT purpose FROM field_sets WHERE name = 'Raw Set'")).scalar_one()
        assert purpose == "teamwork"


def test_a_score_draft_starts_empty_and_an_alliance_has_at_most_one(client):
    session_id = setup_event(client)
    match = add_match(client, session_id, None, 1, add_teams(client))
    red_id = match["alliances"][0]["id"]
    with client.app.state.session_factory() as db:
        draft = ScoreDraft(match_id=match["id"], alliance_id=red_id)
        db.add(draft)
        db.commit()
        db.refresh(draft)
        assert (draft.data_json, draft.teams_json, draft.item_meta_json, draft.version) == ("{}", "[]", "{}", 0)
        assert draft.updated_at is not None
        db.add(ScoreDraft(match_id=match["id"], alliance_id=red_id))
        with pytest.raises(IntegrityError):
            db.commit()


def test_skills_timers_and_runs_start_ready(client):
    _skills_rows(client)
    with client.app.state.session_factory() as db:
        timer = db.execute(select(SkillsSetTimer)).scalar_one()
        assert (timer.skills_type, timer.phase, timer.deadline, timer.paused, timer.remaining_seconds_at_pause) == (
            None, "ready", None, False, None,
        )
        run = db.execute(select(SkillsRun)).scalar_one()
        assert (
            run.data_json, run.item_meta_json, run.version, run.follows_set,
            run.phase, run.deadline, run.paused, run.remaining_seconds_at_pause, run.created_by_device,
        ) == ("{}", "{}", 0, True, "ready", None, False, None, None)
        assert run.created_at is not None


def test_one_timer_per_set_one_run_per_field_and_one_binding_per_device_and_session(client):
    rows = _skills_rows(client)
    duplicates = [
        SkillsSetTimer(field_set_id=rows["set"]["id"]),
        SkillsRun(
            field_id=rows["set"]["field_ids"][0], field_set_id=rows["set"]["id"],
            session_id=rows["session_id"], team_id=rows["team_id"], skills_type="driver",
        ),
        ScorerBinding(session_id=rows["session_id"], device_id=rows["device"]["id"], field_id=rows["set"]["field_ids"][1]),
    ]
    for duplicate in duplicates:
        with client.app.state.session_factory() as db:
            db.add(duplicate)
            with pytest.raises(IntegrityError):
                db.commit()


def test_deleting_a_field_removes_its_run_and_bindings_but_not_the_set_timer(client):
    rows = _skills_rows(client)
    assert client.delete(f"/api/fields/{rows['set']['field_ids'][0]}").status_code == 204
    assert _count(client, SkillsRun) == 0
    assert _count(client, ScorerBinding) == 0
    assert _count(client, SkillsSetTimer) == 1


def test_deleting_a_field_set_removes_its_timer_and_runs(client):
    rows = _skills_rows(client)
    assert client.delete(f"/api/field-sets/{rows['set']['id']}").status_code == 204
    assert _count(client, SkillsSetTimer) == 0
    assert _count(client, SkillsRun) == 0


def test_deleting_a_device_removes_its_binding(client):
    rows = _skills_rows(client)
    assert client.delete(f"/api/devices/{rows['device']['id']}").status_code == 204
    assert _count(client, ScorerBinding) == 0


def test_deleting_a_match_removes_its_drafts(client):
    session_id = setup_event(client)
    match = add_match(client, session_id, None, 1, add_teams(client))
    with client.app.state.session_factory() as db:
        for alliance in match["alliances"]:
            db.add(ScoreDraft(match_id=match["id"], alliance_id=alliance["id"]))
        db.commit()
    with client.app.state.session_factory() as db:
        delete_matches(db, [db.get(Match, match["id"])])
        db.commit()
    assert _count(client, ScoreDraft) == 0


def test_a_skills_attempt_keeps_its_field_id_after_the_field_is_deleted(client):
    rows = _skills_rows(client)
    field_id = rows["set"]["field_ids"][1]
    with client.app.state.session_factory() as db:
        attempt = SkillsAttempt(
            session_id=rows["session_id"], team_id=rows["team_id"], skills_type="driver", data_json="{}",
            score=0, plugin_name="example-game", plugin_version="1.0.0", field_id=field_id,
        )
        db.add(attempt)
        db.commit()
        attempt_id = attempt.id
    assert client.delete(f"/api/fields/{field_id}").status_code == 204
    with client.app.state.session_factory() as db:
        assert db.get(SkillsAttempt, attempt_id).field_id == field_id


def test_live_scoring_rows_are_never_audited(client):
    rows = _skills_rows(client)
    match = add_match(client, rows["session_id"], None, 1, add_teams(client, start=201))
    with client.app.state.session_factory() as db:
        db.add(ScoreDraft(match_id=match["id"], alliance_id=match["alliances"][0]["id"]))
        run = db.execute(select(SkillsRun)).scalar_one()
        run.version += 1
        db.commit()
        db.delete(db.execute(select(ScorerBinding)).scalar_one())
        db.commit()
        audited = db.execute(select(AuditLog.table_name).where(AuditLog.table_name.in_(LIVE_TABLES))).all()
        assert audited == []
        # The generic hook still audits everything else.
        assert db.execute(select(AuditLog.id).where(AuditLog.table_name == "field_sets")).first() is not None
