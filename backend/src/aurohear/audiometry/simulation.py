"""Synthetic listeners for verifying and characterising the threshold engine.

Used by the test suite and reusable for the paper's simulation study (bias / variance
of the Hughson–Westlake estimate vs. psychometric slope, lapse and false-alarm rates).
"""

from __future__ import annotations

import math
import random
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Protocol

from .familiarisation import Familiarisation
from .models import Ear, Presentation, SearchRole
from .protocol import AudiometryProtocol
from .staircase import HughsonWestlakeStaircase


class Listener(Protocol):
    def __call__(self, presentation: Presentation) -> bool: ...


Audiogram = Mapping[Ear, Mapping[int, float]]
"""True thresholds: ear → frequency (Hz) → dB HL."""


@dataclass
class DeterministicListener:
    """Ideal observer: hears a tone iff level ≥ true threshold. No noise, no lapses."""

    audiogram: Audiogram

    def __call__(self, p: Presentation) -> bool:
        return p.level_db_hl >= self.audiogram[p.ear][p.frequency_hz]


@dataclass
class PsychometricListener:
    """Logistic psychometric listener.

        P(yes | L) = γ + (1 − γ − λ) / (1 + exp(−(L − T) / s))

    T = true threshold (50 % point of the sigmoid), s = spread in dB (smaller = steeper),
    γ = false-alarm / guess rate, λ = lapse rate. Seeded for reproducibility.
    """

    audiogram: Audiogram
    spread_db: float = 2.0
    false_alarm_rate: float = 0.0
    lapse_rate: float = 0.0
    seed: int = 0
    _rng: random.Random = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._rng = random.Random(self.seed)

    def p_yes(self, ear: Ear, frequency_hz: int, level_db_hl: float) -> float:
        t = self.audiogram[ear][frequency_hz]
        z = (level_db_hl - t) / self.spread_db
        sig = 1.0 / (1.0 + math.exp(-z)) if z > -700 else 0.0
        g, lam = self.false_alarm_rate, self.lapse_rate
        return g + (1.0 - g - lam) * sig

    def __call__(self, p: Presentation) -> bool:
        return self._rng.random() < self.p_yes(p.ear, p.frequency_hz, p.level_db_hl)


@dataclass
class RetestShiftListener:
    """Wraps a listener and shifts its 1 kHz threshold on retest/verification searches
    (models learning, fatigue or a slipped headphone between initial and retest)."""

    base: DeterministicListener
    shift_db: float
    frequency_hz: int = 1000

    def __call__(self, p: Presentation) -> bool:
        threshold = self.base.audiogram[p.ear][p.frequency_hz]
        if p.frequency_hz == self.frequency_hz and p.test_role is not SearchRole.INITIAL:
            threshold += self.shift_db
        return p.level_db_hl >= threshold


Driveable = HughsonWestlakeStaircase | Familiarisation | AudiometryProtocol


def drive(
    engine: Driveable,
    listener: Callable[[Presentation], bool],
    *,
    max_steps: int = 10_000,
) -> list[tuple[Presentation, bool]]:
    """Run ``engine`` to completion against ``listener``; return the presentation log.

    ``max_steps`` is a test-harness guard only: exceeding it means the engine failed to
    terminate, which is a bug, so it raises rather than returning a partial result.
    """
    log: list[tuple[Presentation, bool]] = []
    while (p := engine.next_presentation()) is not None:
        if len(log) >= max_steps:
            raise RuntimeError(f"engine did not terminate within {max_steps} presentations")
        heard = listener(p)
        engine.record_response(heard)
        log.append((p, heard))
    return log
