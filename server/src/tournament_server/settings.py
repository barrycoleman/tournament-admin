from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Settings:
    db_path: str = "./tournament.db"
    plugins_root: str = "./plugins"

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            db_path=os.environ.get("TOURNAMENT_DB_PATH", "./tournament.db"),
            plugins_root=os.environ.get("TOURNAMENT_PLUGINS_ROOT", "./plugins"),
        )
