from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Settings:
    db_path: str = "./tournament.db"

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(db_path=os.environ.get("TOURNAMENT_DB_PATH", "./tournament.db"))
