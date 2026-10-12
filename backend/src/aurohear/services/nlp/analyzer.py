"""Feedback analyser: sentiment, subjectivity, uncertainty, emotions, issues, intent, symptoms.

A deterministic, lexicon-based analyser (VADER-style valence with negation, intensifiers
and contrast), chosen because it is auditable, reproducible and dependency-free. It sits
behind the `FeedbackAnalyzer` protocol so a transformer model (v1 used DistilBERT/RoBERTa)
can replace it without touching the API or storage.

CLINICAL INDEPENDENCE (docs/NLP_RELIABILITY_MODULE.md): nothing here is ever read by the
audiometry engine, the threshold computation or the classification.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Literal, Protocol

from . import lexicon as lx

Sentiment = Literal["positive", "negative", "neutral", "mixed"]
Intent = Literal["complaint", "suggestion", "praise", "question"]
Severity = Literal["low", "medium", "high"]

ANALYZER_NAME = "aurohear-lexicon-analyzer"
ANALYZER_VERSION = lx.LEXICON_VERSION


@dataclass(frozen=True, slots=True)
class Issue:
    type: str
    severity: Severity
    evidence: str


@dataclass(frozen=True, slots=True)
class Symptom:
    symptom: str
    evidence: str


@dataclass(frozen=True, slots=True)
class Analysis:
    model_name: str
    model_version: str
    sentiment: Sentiment
    polarity: float  # −1 … +1
    subjectivity: float  # 0 … 1
    uncertainty: float  # 0 … 1 (higher = more hedged)
    emotions: dict[str, float]
    issues: tuple[Issue, ...]
    intent: Intent | None
    symptoms: tuple[Symptom, ...]
    requires_clinical_review: bool
    review_reasons: tuple[str, ...] = field(default=())


class FeedbackAnalyzer(Protocol):
    def analyze(self, text: str) -> Analysis: ...


_WORD = re.compile(r"[a-z]+(?:'[a-z]+)?")
_SENTENCE = re.compile(r"(?<=[.!?;])\s+|\n+")


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE.split(text) if s.strip()]


def _clause_negated(clause: str, start: int) -> bool:
    """Is the match at `start` preceded by a negator within 3 words in its clause?"""
    before = _WORD.findall(clause[:start].lower())[-3:]
    return any(w in lx.NEGATORS or w.endswith("n't") for w in before)


def _matches(patterns: tuple[str, ...], sentence: str) -> list[re.Match[str]]:
    low = sentence.lower()
    out: list[re.Match[str]] = []
    for p in patterns:
        out.extend(re.finditer(rf"\b(?:{p})\b", low))
    return out


def _any(patterns: tuple[str, ...], text: str) -> bool:
    return bool(_matches(patterns, text))


def _snippet(sentence: str, limit: int = 160) -> str:
    return sentence if len(sentence) <= limit else sentence[: limit - 1] + "…"


class LexiconFeedbackAnalyzer:
    """The default analyser. Pure function of the text; same input → same output."""

    def analyze(self, text: str) -> Analysis:
        sentences = _sentences(text) or [text]
        words_all = _WORD.findall(text.lower())

        pos = neg = 0.0  # contrast-weighted (polarity)
        raw_pos = raw_neg = 0.0  # unweighted (mixed detection: pros AND cons present)
        subjective = 0
        for sentence in sentences:
            words = _WORD.findall(sentence.lower())
            # VADER contrast rule: after "but", the clause counts more; before it, less.
            cut = next((i for i, w in enumerate(words) if w in lx.CONTRAST), None)
            for i, w in enumerate(words):
                v = lx.VALENCE.get(w)
                if w in lx.SUBJECTIVE_MARKERS:
                    subjective += 1
                if v is None:
                    continue
                subjective += 1
                window = words[max(0, i - 3) : i]
                for m in window:
                    v *= lx.INTENSIFIERS.get(m, 1.0) * lx.DAMPENERS.get(m, 1.0)
                if any(m in lx.NEGATORS or m.endswith("n't") for m in window):
                    v *= -0.74  # VADER negation scalar
                if v > 0:
                    raw_pos += v
                else:
                    raw_neg += -v
                if cut is not None:
                    v *= 0.5 if i < cut else 1.5
                if v > 0:
                    pos += v
                else:
                    neg += -v
        raw = pos - neg
        polarity = raw / math.sqrt(raw * raw + 15.0)  # VADER normalisation → (−1, 1)
        total = pos + neg
        if total == 0:
            sentiment: Sentiment = "neutral"
        elif raw_pos > 0 and raw_neg > 0 and min(raw_pos, raw_neg) / (raw_pos + raw_neg) >= 0.3:
            sentiment = "mixed"
        elif polarity >= 0.05:
            sentiment = "positive"
        elif polarity <= -0.05:
            sentiment = "negative"
        else:
            sentiment = "neutral"

        content = max(1, len(words_all))
        subjectivity = min(1.0, subjective / content * 2.5)
        hedges = sum(len(_matches((h,), text)) for h in lx.HEDGES) + text.count("?") * 0.5
        uncertainty = min(1.0, hedges / (1.0 + len(sentences) * 0.75))

        emotions = {
            name: round(min(1.0, sum(w in words for w in words_all) / max(3.0, len(sentences) * 2.0)), 3)
            for name, words in lx.EMOTIONS.items()
        }

        issues = tuple(self._issues(sentences))
        symptoms = tuple(self._symptoms(sentences))
        reasons = tuple(
            _snippet(s) for s in sentences if any(not _clause_negated(s, m.start()) for m in _matches(lx.REVIEW_TRIGGERS, s))
        )
        return Analysis(
            model_name=ANALYZER_NAME,
            model_version=ANALYZER_VERSION,
            sentiment=sentiment,
            polarity=round(polarity, 4),
            subjectivity=round(subjectivity, 4),
            uncertainty=round(uncertainty, 4),
            emotions=emotions,
            issues=issues,
            intent=self._intent(text, sentences, polarity, issues),
            symptoms=symptoms,
            requires_clinical_review=bool(reasons),
            review_reasons=reasons,
        )

    @staticmethod
    def _sentence_valence(sentence: str) -> float:
        words = _WORD.findall(sentence.lower())
        total = 0.0
        for i, w in enumerate(words):
            v = lx.VALENCE.get(w)
            if v is None:
                continue
            if any(m in lx.NEGATORS or m.endswith("n't") for m in words[max(0, i - 3) : i]):
                v *= -0.74
            total += v
        return total

    def _issues(self, sentences: list[str]) -> list[Issue]:
        found: dict[str, Issue] = {}
        rank = {"low": 0, "medium": 1, "high": 2}
        for s in sentences:
            negative = self._sentence_valence(s) < 0
            problem_hits = {
                category: [m for m in _matches(problems, s) if not _clause_negated(s, m.start())]
                for category, (problems, _topics) in lx.ISSUE_PATTERNS.items()
            }
            specific = any(problem_hits.values())
            for category, (_problems, topics) in lx.ISSUE_PATTERNS.items():
                hits = problem_hits[category]
                # Topic words ("screen", "volume") only count when the sentence is negative
                # and names no specific problem — "froze on the calibration screen" is a
                # technical failure, not a UI issue.
                if not hits and negative and not specific:
                    hits = _matches(topics, s)
                if not hits:
                    continue
                severity: Severity = "high" if _any(lx.SEVERE_MARKERS, s) else "low" if _any(lx.MILD_MARKERS, s) else "medium"
                prev = found.get(category)
                if prev is None or rank[severity] > rank[prev.severity]:
                    found[category] = Issue(category, severity, _snippet(s))
        return list(found.values())

    @staticmethod
    def _symptoms(sentences: list[str]) -> list[Symptom]:
        found: dict[str, Symptom] = {}
        for s in sentences:
            for symptom, patterns in lx.SYMPTOM_PATTERNS.items():
                if symptom in found:
                    continue
                if any(not _clause_negated(s, m.start()) for m in _matches(patterns, s)):
                    found[symptom] = Symptom(symptom, _snippet(s))
        return list(found.values())

    @staticmethod
    def _intent(text: str, sentences: list[str], polarity: float, issues: tuple[Issue, ...]) -> Intent | None:
        low = text.lower()
        if "?" in text or any(_WORD.findall(s.lower())[:1] in ([q] for q in lx.QUESTION_STARTS) and s.endswith("?") for s in sentences):
            return "question"
        if any(re.search(p, low) for p in lx.SUGGESTION_PATTERNS):
            return "suggestion"
        if issues or polarity <= -0.05:
            return "complaint"
        if polarity >= 0.05:
            return "praise"
        return None
