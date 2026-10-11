"""Shared schema building blocks.

Strictness policy (validated against FastAPI's request path):
- numbers, booleans and strings are STRICT — no "1" → 1, no 1.5 → 1, no 1 → True;
  a coerced clinical value is a silent data error;
- UUID, datetime and enum fields accept their standard JSON string forms (FastAPI
  validates parsed JSON in Python mode, where model-wide strict=True would reject
  every UUID and datetime);
- datetimes must be timezone-aware;
- unknown fields are rejected everywhere (`extra="forbid"`).
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from aurohear.audiometry.models import Ear, Phase, SearchRole, ThresholdStatus

__all__ = [
    "SUPPORTED_FREQUENCIES_HZ",
    "Ear",
    "InputModel",
    "OutputModel",
    "Phase",
    "SearchRole",
    "ThresholdStatus",
]

# Must match frontend/src/audio/types.ts SUPPORTED_FREQUENCIES_HZ.
SUPPORTED_FREQUENCIES_HZ: frozenset[int] = frozenset(
    {250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000}
)

# Spec §6.3: response window = tone onset → tone offset + 2.0 s.
RESPONSE_WINDOW_AFTER_OFFSET_MS = 2000.0


class InputModel(BaseModel):
    """Base for request bodies."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class OutputModel(BaseModel):
    """Base for response bodies (built from ORM rows)."""

    model_config = ConfigDict(from_attributes=True, frozen=True)
