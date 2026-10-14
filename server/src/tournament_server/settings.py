from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Settings:
    db_path: str | None = None
    plugins_root: str = "./plugins"
    host: str = "0.0.0.0"
    port: int = 8000
    static_dir: str | None = None

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            db_path=os.environ.get("TOURNAMENT_DB_PATH"),
            plugins_root=os.environ.get("TOURNAMENT_PLUGINS_ROOT", "./plugins"),
            host=os.environ.get("TOURNAMENT_HOST", "0.0.0.0"),
            port=int(os.environ.get("TOURNAMENT_PORT", "8000")),
            static_dir=os.environ.get("TOURNAMENT_STATIC_DIR"),
        )
