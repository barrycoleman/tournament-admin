from __future__ import annotations

import io
import zipfile
from pathlib import Path


def zip_fixture_plugin(fixture_dir: Path) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        for path in fixture_dir.rglob("*"):
            if path.is_file() and "__pycache__" not in path.parts:
                zf.write(path, arcname=path.relative_to(fixture_dir))
    return buffer.getvalue()
