"""Qualitative feedback analysis (migrated from v1 nlp_engine; docs/NLP_RELIABILITY_MODULE.md).

Never influences audiometric outcomes. See analyzer.py and correlation.py.
"""

from .analyzer import ANALYZER_NAME, ANALYZER_VERSION, Analysis, FeedbackAnalyzer, Issue, LexiconFeedbackAnalyzer, Symptom
from .correlation import Correlation, correlate

__all__ = [
    "ANALYZER_NAME",
    "ANALYZER_VERSION",
    "Analysis",
    "Correlation",
    "FeedbackAnalyzer",
    "Issue",
    "LexiconFeedbackAnalyzer",
    "Symptom",
    "correlate",
]
