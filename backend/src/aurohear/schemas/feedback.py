"""Qualitative self-report and NLP insight schemas.

Kept separate from the audiometric record (docs/NLP_RELIABILITY_MODULE.md): the free
text is the participant's data; an insight is a versioned model output about it, so
re-running a newer model adds a row instead of overwriting the old analysis.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Literal, Self
from uuid import UUID

from pydantic import Field, StrictFloat, StrictInt, StrictStr, model_validator

from .common import InputModel, OutputModel

Sentiment = Literal["positive", "negative", "neutral", "mixed"]
SymptomName = Literal["unilateral_hearing_loss", "tinnitus", "dizziness_vertigo", "ear_fullness"]
IssueType = Literal["audio_quality", "volume_level", "ui_instructions", "technical_failure"]
Intent = Literal["complaint", "suggestion", "praise", "question"]
Severity = Literal["low", "medium", "high"]


class FeedbackCreate(InputModel):
    text: StrictStr = Field(min_length=5, max_length=2000)
    ratings: dict[StrictStr, StrictInt] | None = Field(
        default=None, description="Likert items, each 1–5, e.g. {'clarity': 4}"
    )
    language: StrictStr | None = Field(default=None, max_length=16, description="BCP-47 tag")

    @model_validator(mode="after")
    def _ratings_range(self) -> Self:
        if self.ratings and not all(1 <= v <= 5 for v in self.ratings.values()):
            raise ValueError("ratings must be integers 1–5")
        if not self.text.strip():
            raise ValueError("text must not be blank")
        return self


class Issue(InputModel):
    type: IssueType
    severity: Severity
    evidence: StrictStr | None = Field(default=None, max_length=500)


class SymptomIn(InputModel):
    symptom: SymptomName
    evidence: StrictStr | None = Field(default=None, max_length=500)


class NlpInsightCreate(InputModel):
    """An analysis from an external NLP model (admin API). The built-in analyser runs
    automatically on every feedback submission."""

    model_name: StrictStr = Field(min_length=1, max_length=128)
    model_version: StrictStr = Field(min_length=1, max_length=64)
    sentiment: Sentiment
    emotions: dict[StrictStr, StrictFloat] = Field(default_factory=dict)
    uncertainty: StrictFloat = Field(ge=0, le=1)
    issues: list[Issue] = Field(default_factory=list)
    intent: Intent | None = None
    polarity: StrictFloat | None = Field(default=None, ge=-1, le=1)
    subjectivity: StrictFloat | None = Field(default=None, ge=0, le=1)
    symptoms: list[SymptomIn] = Field(default_factory=list)

    @model_validator(mode="after")
    def _emotion_scores(self) -> Self:
        if not all(math.isfinite(v) and 0 <= v <= 1 for v in self.emotions.values()):
            raise ValueError("emotion scores must be in [0, 1]")
        return self


class NlpInsightOut(OutputModel):
    id: UUID
    feedback_id: UUID
    model_name: str
    model_version: str
    sentiment: Sentiment
    emotions: dict[str, float]
    uncertainty: float
    issues: list[dict[str, object]]
    intent: Intent | None
    polarity: float | None
    subjectivity: float | None
    symptoms: list[dict[str, object]]
    correlations: list[dict[str, object]] = Field(
        description="Self-report vs audiometry — research annotation only; never affects results"
    )
    requires_clinical_review: bool = Field(description="Red-flag topic mentioned: needs human review")
    review_reasons: list[str]
    created_at: datetime


class FeedbackReceipt(OutputModel):
    """What the participant gets back: NLP output is never shown to them (NLP doc §Access Control)."""

    id: UUID
    session_id: UUID
    submitted_at: datetime


class SessionInsightsOut(OutputModel):
    session_id: UUID
    count: int
    insights: list[NlpInsightOut]


class FeedbackOut(OutputModel):
    id: UUID
    session_id: UUID
    text: str
    ratings: dict[str, int] | None
    language: str | None
    submitted_at: datetime
    insights: list[NlpInsightOut]
