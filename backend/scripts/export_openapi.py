"""Write the API's OpenAPI schema to frontend/src/api/openapi.json.

The frontend contract tests check the adapter against this snapshot, and the backend
test `test_openapi_snapshot_is_current` fails if it is stale. Regenerate after any
schema change:

    python backend/scripts/export_openapi.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
SNAPSHOT = BACKEND.parent / "frontend" / "src" / "api" / "openapi.json"


def render() -> str:
    sys.path.insert(0, str(BACKEND / "src"))
    from aurohear.api.app import create_app
    from aurohear.db import make_engine

    app = create_app(make_engine("sqlite://", in_memory_shared=True))
    return json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    SNAPSHOT.write_text(render(), encoding="utf-8")
    print(f"wrote {SNAPSHOT}")
