"""Seeded Monte Carlo accuracy study of the staircase against psychometric listeners.

Fixed seeds → fully deterministic, so these are regression bounds, not flaky statistics.

Expected behaviour (and the clinical trade-off it documents): with a 5 dB lattice the
estimate is the first grid level at/above roughly the 50 % point, so for thresholds
uniformly distributed on a continuum the mean bias is ≈ +2.5 dB (quantisation alone
contributes +2.5 dB). Clinical audiometers have the same property; it is the reason
audiometric test–retest is quoted as ±5 dB.
"""

from __future__ import annotations

import random
import statistics
from dataclasses import dataclass

import pytest

from aurohear.audiometry import Ear, HughsonWestlakeStaircase, LevelLattice, ThresholdStatus
from aurohear.audiometry.simulation import PsychometricListener, drive

N_RUNS = 2000


@dataclass(frozen=True)
class Summary:
    bias: float
    mae: float
    within_5: float
    within_10: float
    unresolved_rate: float
    max_presentations: int


def simulate(spread: float, fa: float, lapse: float, *, seed: int = 2026) -> Summary:
    rng = random.Random(seed)
    lattice = LevelLattice()
    errors: list[float] = []
    unresolved = 0
    max_pres = 0
    for i in range(N_RUNS):
        truth = rng.uniform(0.0, 80.0)
        start = lattice.snap(truth + rng.uniform(5.0, 30.0))  # realistic "clearly audible" start
        listener = PsychometricListener(
            {Ear.RIGHT: {1000: truth}}, spread_db=spread, false_alarm_rate=fa, lapse_rate=lapse, seed=seed + i
        )
        sc = HughsonWestlakeStaircase(Ear.RIGHT, 1000, start)
        drive(sc, listener)
        res = sc.result()
        max_pres = max(max_pres, res.presentations)
        if res.status is ThresholdStatus.MEASURED:
            assert res.threshold_db_hl is not None
            errors.append(res.threshold_db_hl - truth)
        else:
            unresolved += 1
    return Summary(
        bias=statistics.fmean(errors),
        mae=statistics.fmean(abs(e) for e in errors),
        within_5=sum(abs(e) <= 5 for e in errors) / len(errors),
        within_10=sum(abs(e) <= 10 for e in errors) / len(errors),
        unresolved_rate=unresolved / N_RUNS,
        max_presentations=max_pres,
    )


@pytest.mark.montecarlo
def test_typical_listener_accuracy() -> None:
    """Spread 2 dB, no false alarms or lapses — a cooperative adult."""
    s = simulate(spread=2.0, fa=0.0, lapse=0.0)
    assert 1.5 <= s.bias <= 3.5
    assert s.mae <= 4.0
    assert s.within_5 >= 0.75
    assert s.within_10 >= 0.99
    assert s.unresolved_rate <= 0.01
    assert s.max_presentations <= 25


@pytest.mark.montecarlo
def test_steep_listener_is_near_quantisation_limit() -> None:
    s = simulate(spread=1.0, fa=0.0, lapse=0.0)
    assert 2.0 <= s.bias <= 3.5  # ≈ +2.5 dB = pure grid quantisation
    assert s.within_5 >= 0.85
    assert s.within_10 >= 0.999
    assert s.unresolved_rate == 0.0


@pytest.mark.montecarlo
def test_unreliable_listener_degrades_gracefully() -> None:
    """15 % false alarms, 5 % lapses, shallow slope: still bounded, rarely wrong by >10 dB.

    Unresolved outcomes rise — that is the intended behaviour: the engine reports
    "unresolved" (feeds QC) rather than inventing a threshold.
    """
    s = simulate(spread=3.0, fa=0.15, lapse=0.05)
    assert abs(s.bias) <= 4.0
    assert s.within_10 >= 0.93
    assert s.unresolved_rate <= 0.06
    assert s.max_presentations <= 25
