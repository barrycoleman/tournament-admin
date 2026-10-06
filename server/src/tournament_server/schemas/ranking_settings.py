from __future__ import annotations

from pydantic import BaseModel


class RankingSettingsBody(BaseModel):
    session_drop_mode: str = "tiered"
    session_drop_count: int = 1
    session_drop_no_show: bool = False
    session_drop_dq: bool = False
    season_keep_best: int | None = None
    season_only_session_counted: bool = False
    season_minimum: int = 0
    season_drop_no_show: bool = False
    season_drop_dq: bool = False


class RankingSettingsRead(RankingSettingsBody):
    # head_to_head / cooperative_score, or None before a game plugin is chosen.
    game_model: str | None
