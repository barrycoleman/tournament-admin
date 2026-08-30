import io
import json
import zipfile

from tournament_server.plugin_registry.discovery import discover_scheduler_plugins
from tournament_server.plugin_registry.loader import SCHEDULER_PLUGIN_KIND
from tournament_server.plugin_registry.zip_install import install_plugin_zip


def _build_scheduler_zip(name: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr(
            "manifest.json",
            json.dumps(
                {
                    "name": name,
                    "version": "1.0.0",
                    "kind": "scheduler",
                    "display_name": "Test Scheduler",
                }
            ),
        )
        zf.writestr("plugin.py", "def generate_schedule(**kwargs):\n    return []\n")
    return buffer.getvalue()


def test_install_plugin_zip_installs_scheduler_kind_under_schedulers_folder(tmp_path):
    zip_bytes = _build_scheduler_zip("stub-scheduler")
    plugins_root = tmp_path / "plugins"

    plugin = install_plugin_zip(zip_bytes, plugins_root, SCHEDULER_PLUGIN_KIND)

    assert plugin.name == "stub-scheduler"
    assert (plugins_root / "schedulers" / "stub-scheduler" / "manifest.json").exists()

    registry = discover_scheduler_plugins(plugins_root)
    assert set(registry) == {"stub-scheduler"}
