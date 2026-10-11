"""The frontend's API contract snapshot must match the live schema."""

from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "export_openapi.py"


def test_openapi_snapshot_is_current() -> None:
    spec = importlib.util.spec_from_file_location("export_openapi", SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.SNAPSHOT.exists(), "run: python backend/scripts/export_openapi.py"
    assert mod.SNAPSHOT.read_text(encoding="utf-8") == mod.render(), (
        "frontend/src/api/openapi.json is stale — run: python backend/scripts/export_openapi.py"
    )
