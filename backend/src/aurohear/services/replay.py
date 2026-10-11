"""Rebuild protocol state from the append-only trial log (event sourcing).

The server never stores staircase state. The tested `AudiometryProtocol` is
deterministic, so feeding it the stored tone-trial responses in `seq` order recreates
exactly the state the session is in. Consequences:

* thresholds are always *computed by the server* from the evidence — a client cannot
  submit or alter a threshold;
* the next expected presentation is known, so a client trial that does not match it is
  rejected instead of silently corrupting the log;
* no serialised engine state can drift out of sync with the trials.

Catch trials and discarded trials never reach the staircase.

Cost is O(n) per request with n ≲ 400 trials per session (sub-millisecond engine
work); cache per (session, trial count) if that ever matters.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol

from aurohear.audiometry import AudiometryProtocol, Ear, LevelLattice, Presentation


class ReplayableTrial(Protocol):
    """The fields replay needs; satisfied by both TrialRow and TrialCreate."""

    @property
    def seq(self) -> int: ...
    @property
    def ear(self) -> object: ...
    @property
    def frequency_hz(self) -> int: ...
    @property
    def level_db_hl(self) -> int | None: ...
    @property
    def phase(self) -> object: ...
    @property
    def test_role(self) -> object: ...
    @property
    def is_catch_trial(self) -> bool: ...
    @property
    def discarded(self) -> bool: ...
    @property
    def responded(self) -> bool: ...


class SessionParams(Protocol):
    @property
    def better_ear(self) -> str | None: ...
    @property
    def profile_cap_db_hl(self) -> int: ...


class ReplayError(RuntimeError):
    """The stored log is inconsistent with the protocol — data corruption, never user error."""


def advances_protocol(trial: ReplayableTrial) -> bool:
    return not trial.is_catch_trial and not trial.discarded


def mismatch(expected: Presentation, trial: ReplayableTrial) -> list[str]:
    """Fields where `trial` differs from the presentation the protocol asked for."""
    pairs = {
        "ear": (expected.ear.value, str(trial.ear)),
        "frequency_hz": (expected.frequency_hz, trial.frequency_hz),
        "level_db_hl": (expected.level_db_hl, trial.level_db_hl),
        "phase": (expected.phase.value, str(trial.phase)),
        "test_role": (expected.test_role.value, str(trial.test_role)),
    }
    return [f"{k}: expected {e!r}, got {g!r}" for k, (e, g) in pairs.items() if e != g]


def new_protocol(session: SessionParams) -> AudiometryProtocol:
    better = Ear(session.better_ear) if session.better_ear else None
    return AudiometryProtocol(
        better_ear=better, lattice=LevelLattice(ceiling=session.profile_cap_db_hl)
    )


def replay(session: SessionParams, trials: Iterable[ReplayableTrial]) -> AudiometryProtocol:
    proto = new_protocol(session)
    for t in sorted(trials, key=lambda t: t.seq):
        if not advances_protocol(t):
            continue
        expected = proto.next_presentation()
        if expected is None:
            raise ReplayError(f"trial seq={t.seq} recorded after the protocol completed")
        diff = mismatch(expected, t)
        if diff:
            raise ReplayError(f"trial seq={t.seq} does not match the protocol: {'; '.join(diff)}")
        proto.record_response(t.responded)
    return proto
