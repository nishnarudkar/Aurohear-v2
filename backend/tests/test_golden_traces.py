"""The TypeScript engine's golden traces must come from the current Python engine."""

from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "export_golden_traces.py"


def test_golden_traces_are_current() -> None:
    spec = importlib.util.spec_from_file_location("export_golden_traces", SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.SNAPSHOT.exists(), "run: python backend/scripts/export_golden_traces.py"
    assert mod.SNAPSHOT.read_text(encoding="utf-8") == mod.render(), (
        "frontend/tests/engine/golden-traces.json is stale — the Python engine changed. "
        "Run: python backend/scripts/export_golden_traces.py, then make the TypeScript "
        "engine pass tests/engine/conformance.test.ts."
    )
