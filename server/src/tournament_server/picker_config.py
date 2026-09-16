from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_CONFIG_PATH = Path.home() / ".tournament-admin" / "server-config.json"


@dataclass
class PickerConfig:
    allowed_directories: list[str] = field(default_factory=list)
    last_opened_path: str | None = None


def resolve_config_path() -> Path:
    override = os.environ.get("TOURNAMENT_CONFIG_PATH")
    return Path(override) if override else DEFAULT_CONFIG_PATH


def load_config(config_path: Path) -> PickerConfig:
    if not config_path.exists():
        config = PickerConfig()
        default_dir = os.environ.get("TOURNAMENT_DEFAULT_DIR")
        if default_dir:
            config.allowed_directories.append(str(Path(default_dir).resolve()))
        save_config(config_path, config)
        return config

    raw = json.loads(config_path.read_text())
    return PickerConfig(
        allowed_directories=list(raw.get("allowed_directories", [])),
        last_opened_path=raw.get("last_opened_path"),
    )


def save_config(config_path: Path, config: PickerConfig) -> None:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(asdict(config), indent=2))


def is_path_allowed(path: Path, allowed_directories: list[str]) -> bool:
    """True if `path`, once resolved (symlinks followed, ".." normalized),
    IS one of `allowed_directories` or is nested inside one of them. This
    is the actual path-traversal guard for every picker endpoint that
    takes a client-supplied path -- never trust the raw string."""
    resolved = path.resolve()
    for allowed in allowed_directories:
        allowed_resolved = Path(allowed).resolve()
        if resolved == allowed_resolved or allowed_resolved in resolved.parents:
            return True
    return False


def add_allowed_directory(config_path: Path, directory: str) -> PickerConfig:
    """Adds a brand-new top-level directory (the USB-drive case) to the
    allowlist. Unlike `is_path_allowed`, this deliberately does NOT check
    containment against existing entries -- it's establishing a new root,
    not validating a path against established ones."""
    resolved = str(Path(directory).resolve())
    config = load_config(config_path)
    if resolved not in config.allowed_directories:
        config.allowed_directories.append(resolved)
        save_config(config_path, config)
    return config


def list_tournament_files(directory: str) -> list[dict[str, object]]:
    """Non-recursive `*.db` glob. This alone already excludes automatic
    pre-migration backups (named `<path>.pre-migration-<timestamp>.bak`,
    see migrations.py::_backup_path) since they never match `*.db`."""
    entries: list[dict[str, object]] = []
    for db_file in sorted(Path(directory).glob("*.db")):
        stat = db_file.stat()
        entries.append(
            {
                "filename": db_file.name,
                "path": str(db_file.resolve()),
                "size_bytes": stat.st_size,
                "modified_at": datetime.fromtimestamp(
                    stat.st_mtime, tz=timezone.utc
                ).isoformat(),
            }
        )
    return entries


def resolve_active_db_path(explicit: str | None = None) -> str | None:
    """Resolution order: an explicit argument (e.g. a CLI flag) wins,
    then the legacy TOURNAMENT_DB_PATH env var, then the picker config's
    last_opened_path. Returns None if nothing resolves -- the caller
    (main.py's _startup, or the `tm migrate` CLI) decides what that
    means for it."""
    if explicit is not None:
        return explicit
    env_path = os.environ.get("TOURNAMENT_DB_PATH")
    if env_path is not None:
        return env_path
    return load_config(resolve_config_path()).last_opened_path
