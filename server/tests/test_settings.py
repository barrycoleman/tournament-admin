from __future__ import annotations

from tournament_server.settings import Settings


def test_from_env_defaults_host_and_port(monkeypatch):
    monkeypatch.delenv("TOURNAMENT_HOST", raising=False)
    monkeypatch.delenv("TOURNAMENT_PORT", raising=False)

    settings = Settings.from_env()

    assert settings.host == "0.0.0.0"
    assert settings.port == 8000


def test_from_env_reads_host_and_port_overrides(monkeypatch):
    monkeypatch.setenv("TOURNAMENT_HOST", "192.168.1.5")
    monkeypatch.setenv("TOURNAMENT_PORT", "9000")

    settings = Settings.from_env()

    assert settings.host == "192.168.1.5"
    assert settings.port == 9000
