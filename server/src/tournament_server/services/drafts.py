"""Teamwork draft scores (live scoring spec §4.2 and §5).

A draft is one alliance's scoresheet while its match is scored. Items merge
one at a time, the last write wins per item, and each item remembers which
device wrote it and when. Drafts never count toward rankings, completion,
finals or any check; Submit turns them into official score records and
deletes them. A cooperative game keeps one shared draft per match, stored on
the match's lowest alliance id.
"""
from __future__ import annotations

import json
import re
import threading
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from tournament_server import realtime
from tournament_server.db import utc_now
from tournament_server.models.alliance import Alliance
from tournament_server.models.match import Match
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.scoring_draft import ScoreDraft
from tournament_server.schemas.draft import AllianceDraftRead, DraftPatch, ItemMeta, MatchDraftRead
from tournament_server.schemas.score_record import TeamFlags
from tournament_server.services import qualification, team_flags
from tournament_server.services.score_submission import (
    SCORE_ALREADY_SUBMITTED_DETAIL,
    ScoreRefused,
    write_alliance_score,
)
from tournament_server.services.skills_rules import _field_problem

if TYPE_CHECKING:
    from fastapi import FastAPI

    from tournament_server.plugin_registry.loader import LoadedPlugin

# One process serves one event file, so a process-wide lock makes each
# read-merge-write of a draft (and each Submit or whole-match reset) atomic.
# SQLite ignores SELECT ... FOR UPDATE, and without this two tablets patching
# different items at once could each write back a copy missing the other's.
DRAFT_WRITE_LOCK = threading.RLock()

DRAFT_EVENT_ROLES = ("admin", "scorer", "referee")

FLAG_KEY = re.compile(r"^team:(\d+):(no_show|dq)$")


def flag_key(team_id: int, flag: str) -> str:
    return f"team:{team_id}:{flag}"


def _cooperative(plugin: "LoadedPlugin") -> bool:
    return plugin.module.match_format()["game_model"] == "cooperative_score"


def _finals(match: Match) -> bool:
    return match.finals_bracket_id is not None


def match_alliance_ids(db: Session, match_id: int) -> list[int]:
    return list(
        db.execute(select(Alliance.id).where(Alliance.match_id == match_id).order_by(Alliance.id)).scalars()
    )


def draft_alliance_id(db: Session, plugin: "LoadedPlugin", match: Match, alliance_id: int) -> int:
    """The alliance whose row holds this alliance's draft: itself, or the
    match's lowest alliance id for a cooperative game."""
    if _cooperative(plugin):
        return match_alliance_ids(db, match.id)[0]
    return alliance_id


def alliances_showing(db: Session, plugin: "LoadedPlugin", match: Match, alliance_id: int) -> list[int]:
    """The alliances whose view changes when this alliance's draft changes."""
    return match_alliance_ids(db, match.id) if _cooperative(plugin) else [alliance_id]


def _match_team_ids(db: Session, match: Match) -> list[int]:
    team_ids: list[int] = []
    for alliance_id in match_alliance_ids(db, match.id):
        team_ids.extend(team_flags.alliance_team_ids(db, alliance_id))
    return team_ids


def item_violations(
    schema: list[dict[str, Any]], changes: dict[str, Any], *, scope: str, team_ids: list[int]
) -> list[str]:
    """Each changed item checked on its own: the name exists on this sheet,
    the type matches, and the value is within min/max or among the options.

    `scope` is the sheet being edited: "alliance" (a match alliance, whose
    flat data holds every schema item, team-scoped ones included, as
    `POST …/score` stores it) or "team" (a skills run, which takes
    team-scoped items only). Team flag keys (`team:<id>:no_show`,
    `team:<id>:dq`) must name a team in `team_ids` and carry a boolean."""
    fields = {
        field["name"]: field for field in schema if scope == "alliance" or field.get("scope") == scope
    }
    problems: list[str] = []
    for name, value in changes.items():
        flag = FLAG_KEY.match(name)
        if flag is not None:
            if int(flag.group(1)) not in team_ids:
                problems.append(f"Team {flag.group(1)} is not on this alliance.")
            elif not isinstance(value, bool):
                problems.append(f"{name}: Must be true or false.")
            continue
        field = fields.get(name)
        if field is None:
            problems.append(f"{name}: Unknown item.")
            continue
        problem = _field_problem(field, value)
        if problem is not None:
            problems.append(f"{name}: {problem}")
    return list(dict.fromkeys(problems))


def _draft_row(db: Session, alliance_id: int) -> ScoreDraft | None:
    return (
        db.execute(
            select(ScoreDraft)
            .where(ScoreDraft.alliance_id == alliance_id)
            .execution_options(populate_existing=True)
        )
        .scalars()
        .first()
    )


def _stored_flags(draft: ScoreDraft) -> list[TeamFlags]:
    return [TeamFlags(**entry) for entry in json.loads(draft.teams_json)]


def is_submitted(db: Session, match: Match) -> bool:
    """True once every alliance of the match has an official score record."""
    alliance_ids = match_alliance_ids(db, match.id)
    if not alliance_ids:
        return False
    scored = set(
        db.execute(select(ScoreRecord.alliance_id).where(ScoreRecord.alliance_id.in_(alliance_ids))).scalars()
    )
    return scored == set(alliance_ids)


def apply_patch(
    db: Session, plugin: "LoadedPlugin", match: Match, alliance: Alliance, patch: DraftPatch, device_name: str
) -> ScoreDraft:
    """Validates every changed item and flag, then merges them into the
    alliance's draft (last write wins per item), records who and when, bumps
    the version and commits. Raises ScoreRefused (409 submitted / not played,
    422 {"violations": [...]})."""
    with DRAFT_WRITE_LOCK:
        db.refresh(match)
        if match.status == qualification.NOT_PLAYED:
            raise ScoreRefused(status_code=409, detail=qualification.NOT_PLAYED_SCORE_DETAIL)
        if is_submitted(db, match):
            raise ScoreRefused(status_code=409, detail=SCORE_ALREADY_SUBMITTED_DETAIL)

        cooperative = _cooperative(plugin)
        team_ids = _match_team_ids(db, match) if cooperative else team_flags.alliance_team_ids(db, alliance.id)

        problems = [f"{key}: Send team flags in teams." for key in patch.changes if FLAG_KEY.match(key)]
        items = {key: value for key, value in patch.changes.items() if not FLAG_KEY.match(key)}
        flag_items: dict[str, bool] = {}
        seen: set[int] = set()
        for entry in patch.teams or []:
            if entry.team_id in seen:
                problems.append(f"Team {entry.team_id} is listed more than once.")
                continue
            seen.add(entry.team_id)
            flag_items[flag_key(entry.team_id, "no_show")] = entry.no_show
            flag_items[flag_key(entry.team_id, "dq")] = entry.dq
        problems += item_violations(
            plugin.module.scoresheet_schema(), {**items, **flag_items}, scope="alliance", team_ids=team_ids
        )
        if problems:
            raise ScoreRefused(status_code=422, detail={"violations": list(dict.fromkeys(problems))})

        now = utc_now()
        owner_id = draft_alliance_id(db, plugin, match, alliance.id)
        draft = _draft_row(db, owner_id)
        if draft is None:
            draft = ScoreDraft(
                match_id=match.id,
                alliance_id=owner_id,
                data_json="{}",
                teams_json="[]",
                item_meta_json="{}",
                version=0,
                updated_at=now,
            )
            db.add(draft)

        data = json.loads(draft.data_json)
        data.update(items)
        meta = json.loads(draft.item_meta_json)
        stamp = {"device_name": device_name, "at": now.isoformat()}
        for key in (*items, *flag_items):
            meta[key] = stamp
        if patch.teams is not None:
            flags = {entry["team_id"]: entry for entry in json.loads(draft.teams_json)}
            for entry in patch.teams:
                if entry.no_show or entry.dq:
                    flags[entry.team_id] = entry.model_dump()
                else:
                    flags.pop(entry.team_id, None)
            draft.teams_json = json.dumps([flags[team_id] for team_id in sorted(flags)])

        draft.data_json = json.dumps(data)
        draft.item_meta_json = json.dumps(meta)
        draft.version = (draft.version or 0) + 1
        draft.updated_at = now
        db.commit()
        return draft


def draft_score(plugin: "LoadedPlugin", draft: ScoreDraft | None, team_ids, finals: bool) -> int:
    """The draft's score so far, team flags applied as for an official score.
    0 when there is no draft or the plugin can't score it yet (§5.2)."""
    if draft is None:
        return 0
    if team_flags.alliance_out(_stored_flags(draft), team_ids, finals=finals):
        return 0
    try:
        return int(plugin.module.calculate_score(json.loads(draft.data_json)))
    except Exception:
        return 0


def _shown(key: str, team_ids: list[int]) -> bool:
    flag = FLAG_KEY.match(key)
    return flag is None or int(flag.group(1)) in team_ids


def empty_alliance_draft(alliance_id: int) -> AllianceDraftRead:
    return AllianceDraftRead(alliance_id=alliance_id, data={}, teams=[], item_meta={}, version=0, score=0)


def alliance_draft(db: Session, plugin: "LoadedPlugin", match: Match, alliance_id: int) -> AllianceDraftRead:
    """One alliance's view of its draft (the shared one for a cooperative
    game, with only this alliance's team flags and its own score)."""
    draft = _draft_row(db, draft_alliance_id(db, plugin, match, alliance_id))
    if draft is None:
        return empty_alliance_draft(alliance_id)
    team_ids = team_flags.alliance_team_ids(db, alliance_id)
    return AllianceDraftRead(
        alliance_id=alliance_id,
        data=json.loads(draft.data_json),
        teams=[flag for flag in _stored_flags(draft) if flag.team_id in team_ids],
        item_meta={
            key: ItemMeta(**value)
            for key, value in json.loads(draft.item_meta_json).items()
            if _shown(key, team_ids)
        },
        version=draft.version,
        score=draft_score(plugin, draft, team_ids, _finals(match)),
    )


def _official(db: Session, plugin: "LoadedPlugin", match: Match, alliance_id: int) -> AllianceDraftRead:
    record = db.execute(select(ScoreRecord).where(ScoreRecord.alliance_id == alliance_id)).scalars().first()
    if record is None:
        return empty_alliance_draft(alliance_id)
    team_ids = team_flags.alliance_team_ids(db, alliance_id)
    return AllianceDraftRead(
        alliance_id=alliance_id,
        data=json.loads(record.data_json),
        teams=[TeamFlags(team_id=flag.team_id, no_show=flag.no_show, dq=flag.dq) for flag in record.teams],
        item_meta={},
        version=0,
        score=team_flags.effective_score(plugin, record, team_ids, finals=_finals(match)),
    )


def read_match_draft(db: Session, plugin: "LoadedPlugin", match: Match) -> MatchDraftRead:
    """Every alliance's draft; once the match is submitted, its official scores instead."""
    submitted = is_submitted(db, match)
    read = _official if submitted else alliance_draft
    return MatchDraftRead(
        match_id=match.id,
        submitted=submitted,
        alliances=[read(db, plugin, match, alliance_id) for alliance_id in match_alliance_ids(db, match.id)],
    )


def broadcast_draft_changed(
    app: "FastAPI", db: Session, plugin: "LoadedPlugin", match: Match, alliance_ids: list[int]
) -> None:
    for alliance_id in alliance_ids:
        read = alliance_draft(db, plugin, match, alliance_id)
        realtime.broadcast_active_session(
            app,
            "score_draft_changed",
            {"match_id": match.id, **read.model_dump(mode="json")},
            roles=DRAFT_EVENT_ROLES,
        )


def delete_match_drafts(db: Session, match_ids: list[int]) -> None:
    """Deletes these matches' drafts. Doesn't commit."""
    if match_ids:
        db.execute(delete(ScoreDraft).where(ScoreDraft.match_id.in_(list(match_ids))))


def submit_match(
    db: Session,
    plugin: "LoadedPlugin",
    match: Match,
    *,
    force: bool,
    submitted_by: str | None,
    is_admin: bool,
) -> list[int]:
    """Turns the match's drafts into official score records, all or nothing:
    every check runs before the first write. The caller holds
    DRAFT_WRITE_LOCK. Returns the match's alliance ids. Raises ScoreRefused."""
    if match.status == qualification.NOT_PLAYED:
        raise ScoreRefused(status_code=409, detail=qualification.NOT_PLAYED_SCORE_DETAIL)
    if is_submitted(db, match):
        raise ScoreRefused(status_code=409, detail=SCORE_ALREADY_SUBMITTED_DETAIL)

    alliance_ids = match_alliance_ids(db, match.id)
    alliances = {alliance_id: db.get(Alliance, alliance_id) for alliance_id in alliance_ids}
    team_ids = {alliance_id: team_flags.alliance_team_ids(db, alliance_id) for alliance_id in alliance_ids}
    records = {
        record.alliance_id: record
        for record in db.execute(select(ScoreRecord).where(ScoreRecord.alliance_id.in_(alliance_ids))).scalars()
    }
    finals = _finals(match)

    # (alliance id, data, its own flags), in alliance order.
    writes: list[tuple[int, dict, list[TeamFlags]]] = []
    if _cooperative(plugin):
        shared_id = alliance_ids[0]
        draft = _draft_row(db, shared_id)
        if draft is None:
            raise ScoreRefused(status_code=409, detail=f"Alliance {shared_id} has no draft score.")
        data = json.loads(draft.data_json)
        flags = _stored_flags(draft)
        shared_out = team_flags.alliance_out(flags, team_ids[shared_id], finals=False)
        for alliance_id in alliance_ids:
            own = [flag for flag in flags if flag.team_id in team_ids[alliance_id]]
            # The shared alliance mirrors its data to partners; a partner is
            # written too when it has its own flags or nothing was mirrored.
            if alliance_id == shared_id or own or shared_out:
                writes.append((alliance_id, data, own))
        checked = [(shared_id, data, flags)]
        # write_alliance_score commits per alliance, so every refusal it could
        # raise for a partner is decided here, before the first write.
        for alliance_id, _data, own in writes:
            record = records.get(alliance_id)
            if record is not None and not record.mirrored and not is_admin:
                raise ScoreRefused(status_code=409, detail=SCORE_ALREADY_SUBMITTED_DETAIL)
            if alliance_id != shared_id and not team_flags.alliance_out(own, team_ids[alliance_id], finals=finals):
                try:
                    plugin.module.calculate_score(data)
                except Exception as exc:
                    raise ScoreRefused(status_code=422, detail=f"Plugin could not score this scoresheet: {exc}")
    else:
        for alliance_id in alliance_ids:
            draft = _draft_row(db, alliance_id)
            record = records.get(alliance_id)
            if draft is None:
                if record is not None:
                    continue
                raise ScoreRefused(status_code=409, detail=f"Alliance {alliance_id} has no draft score.")
            if record is not None and not record.mirrored and not is_admin:
                raise ScoreRefused(status_code=409, detail=SCORE_ALREADY_SUBMITTED_DETAIL)
            own = [flag for flag in _stored_flags(draft) if flag.team_id in team_ids[alliance_id]]
            writes.append((alliance_id, json.loads(draft.data_json), own))
        checked = list(writes)

    violations = []
    for alliance_id, data, flags in checked:
        try:
            messages = plugin.module.validate(data)
        except Exception as exc:
            raise ScoreRefused(status_code=422, detail=f"Plugin could not validate this scoresheet: {exc}")
        if messages:
            violations.append({"alliance_id": alliance_id, "messages": list(messages)})
        if not team_flags.alliance_out(flags, team_ids[alliance_id], finals=finals):
            try:
                plugin.module.calculate_score(data)
            except Exception as exc:
                raise ScoreRefused(status_code=422, detail=f"Plugin could not score this scoresheet: {exc}")
    if violations and not force:
        raise ScoreRefused(status_code=422, detail={"violations": violations})

    for alliance_id, data, flags in writes:
        write_alliance_score(
            db,
            plugin,
            match,
            alliances[alliance_id],
            data=data,
            teams=flags,
            sitting=False,
            force=True,
            submitted_by=submitted_by,
            is_admin=is_admin,
        )
    delete_match_drafts(db, [match.id])
    db.commit()
    return alliance_ids


def broadcast_drafts_cleared(app: "FastAPI", db: Session, match: Match) -> None:
    """Tells scoring devices every alliance's draft is now empty (version 0)."""
    for alliance_id in match_alliance_ids(db, match.id):
        realtime.broadcast_active_session(
            app,
            "score_draft_changed",
            {"match_id": match.id, **empty_alliance_draft(alliance_id).model_dump(mode="json")},
            roles=DRAFT_EVENT_ROLES,
        )
