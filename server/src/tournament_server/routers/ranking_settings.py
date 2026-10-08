from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.deps import get_db, get_event_or_404, get_optional_game_plugin
from tournament_server.models.ranking_settings import RankingSettings
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.schemas.ranking_settings import RankingSettingsBody, RankingSettingsRead
from tournament_server.services.ranking import recompute_all_rankings
from tournament_server.services.ranking_rules import RankingRules
from tournament_server.services.ranking_settings import (
    RULE_FIELDS,
    load_ranking_settings,
    settings_error,
)

router = APIRouter(prefix="/api/ranking-settings", tags=["ranking-settings"])


def _to_read(settings: RankingSettings, plugin: LoadedPlugin | None) -> RankingSettingsRead:
    game_model = plugin.module.match_format()["game_model"] if plugin is not None else None
    return RankingSettingsRead(
        **{name: getattr(settings, name) for name in RULE_FIELDS}, game_model=game_model
    )


@router.get("", response_model=RankingSettingsRead)
def get_ranking_settings(
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> RankingSettingsRead:
    event = get_event_or_404(db)
    settings = load_ranking_settings(db, event.id)
    db.commit()
    return _to_read(settings, get_optional_game_plugin(request, event))


@router.put("", response_model=RankingSettingsRead)
def put_ranking_settings(
    payload: RankingSettingsBody,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> RankingSettingsRead:
    event = get_event_or_404(db)
    error = settings_error(RankingRules(**payload.model_dump()))
    if error is not None:
        raise HTTPException(status_code=422, detail=error)
    settings = load_ranking_settings(db, event.id)
    for name, value in payload.model_dump().items():
        setattr(settings, name, value)
    db.commit()
    plugin = get_optional_game_plugin(request, event)
    if plugin is not None:
        recompute_all_rankings(request.app, db, plugin, event.id)
    db.refresh(settings)
    return _to_read(settings, plugin)
