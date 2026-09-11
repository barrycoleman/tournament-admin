from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Settings:
    db_path: str = "./tournament.db"
    plugins_root: str = "./plugins"
    device_idle_timeout_minutes: int = 60
    host: str = "0.0.0.0"
    port: int = 8000

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            db_path=os.environ.get("TOURNAMENT_DB_PATH", "./tournament.db"),
            plugins_root=os.environ.get("TOURNAMENT_PLUGINS_ROOT", "./plugins"),
            device_idle_timeout_minutes=int(
                os.environ.get("TOURNAMENT_DEVICE_IDLE_TIMEOUT_MINUTES", "60")
            ),
            host=os.environ.get("TOURNAMENT_HOST", "0.0.0.0"),
            port=int(os.environ.get("TOURNAMENT_PORT", "8000")),
        )
