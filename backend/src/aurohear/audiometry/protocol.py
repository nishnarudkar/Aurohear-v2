"""ASHA 2005 air-conduction test sequence across both ears (spec §6.4, Option 1).

    Ear 1 (better):  fam@1k → 1000 → 2000 → 3000 → 4000 → 6000 → 8000 → 1000 (retest) → 500 → 250
    Ear 2:           fam@1k → 1000 → 2000 → 3000 → 4000 → 6000 → 8000 →                 500 → 250

One ear is completed before the other is started (GAP_ANALYSIS #3). The first ear is
the self-reported better ear, or the right ear when unknown/equal.

Start levels (spec §6.3 step 1):
  * first frequency of an ear  → the familiarisation level;
  * every later frequency      → previous threshold in that ear + 30 dB, clamped.
    "Previous threshold" is the most recent *measured* threshold in the ear; if none
    exists yet (e.g. 1 kHz was no-response) the familiarisation level is used.

1 kHz retest (spec §6.4 [DESIGN]): if |T_retest − T_initial| ≤ 5 dB the better value is
accepted. If it is > 5 dB (or one of the two is not a measured threshold) the ear is
flagged ``unstable_1k`` and two verification searches are inserted immediately —
1 kHz a third time, and 2 kHz as the "one other frequency" ASHA requires.

Not yet implemented (later phases): inter-octave insertion (750/1500 Hz), 125 Hz,
catch trials and QC probes (runner, Phase 3), mandatory inter-ear break (UI).
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from .familiarisation import Familiarisation, FamiliarisationConfig
from .levels import LevelLattice
from .models import (
    Ear,
    EarResult,
    FamiliarisationResult,
    Presentation,
    ProtocolResult,
    SearchRole,
    ThresholdResult,
    ThresholdStatus,
)
from .staircase import HughsonWestlakeStaircase, StaircaseConfig

PROTOCOL_VERSION = "aurohear-asha2005-ac-0.1.0"

FAMILIARISATION_FREQUENCY_HZ = 1000
RETEST_FREQUENCY_HZ = 1000
VERIFICATION_EXTRA_FREQUENCY_HZ = 2000
RETEST_TOLERANCE_DB = 5
SUBSEQUENT_START_OFFSET_DB = 30

FIRST_EAR_SEQUENCE: tuple[tuple[int, SearchRole], ...] = (
    (1000, SearchRole.INITIAL),
    (2000, SearchRole.INITIAL),
    (3000, SearchRole.INITIAL),
    (4000, SearchRole.INITIAL),
    (6000, SearchRole.INITIAL),
    (8000, SearchRole.INITIAL),
    (1000, SearchRole.RETEST),
    (500, SearchRole.INITIAL),
    (250, SearchRole.INITIAL),
)
SECOND_EAR_SEQUENCE: tuple[tuple[int, SearchRole], ...] = tuple(
    step for step in FIRST_EAR_SEQUENCE if step[1] is not SearchRole.RETEST
)


def accept_threshold(results: list[ThresholdResult]) -> ThresholdResult:
    """Choose the reported result for one frequency from its 1..n searches.

    Lowest measured threshold wins (ASHA: "accept the lower (better) of the two"); else
    a no-response; else the most recent unresolved search.

    Trade-off: best-of-n is slightly optimistic (biased toward better hearing) when n > 1.
    This follows the guideline; the individual searches stay in ``EarResult.thresholds``.
    """
    if not results:
        raise ValueError("no results for this frequency")
    measured = [r for r in results if r.status is ThresholdStatus.MEASURED]
    if measured:
        return min(measured, key=lambda r: r.threshold_db_hl)  # type: ignore[arg-type, return-value]
    no_response = [r for r in results if r.status is ThresholdStatus.NO_RESPONSE]
    if no_response:
        return no_response[-1]
    return results[-1]


def retest_is_stable(initial: ThresholdResult, retest: ThresholdResult) -> tuple[bool, int | None]:
    """Return ``(stable, delta_db)`` for the 1 kHz initial/retest pair."""
    if initial.status is ThresholdStatus.MEASURED and retest.status is ThresholdStatus.MEASURED:
        assert initial.threshold_db_hl is not None and retest.threshold_db_hl is not None
        delta = abs(retest.threshold_db_hl - initial.threshold_db_hl)
        return delta <= RETEST_TOLERANCE_DB, delta
    both_nr = (
        initial.status is ThresholdStatus.NO_RESPONSE
        and retest.status is ThresholdStatus.NO_RESPONSE
    )
    return both_nr, None


@dataclass
class _EarState:
    ear: Ear
    plan: deque[tuple[int, SearchRole]]
    familiarisation: FamiliarisationResult | None = None
    thresholds: list[ThresholdResult] = field(default_factory=list)
    retest_delta_db: int | None = None
    unstable_1k: bool = False

    def last_measured_threshold(self) -> int | None:
        for r in reversed(self.thresholds):
            if r.status is ThresholdStatus.MEASURED:
                return r.threshold_db_hl
        return None

    def to_result(self) -> EarResult:
        assert self.familiarisation is not None
        by_freq: dict[int, list[ThresholdResult]] = {}
        for r in self.thresholds:
            by_freq.setdefault(r.frequency_hz, []).append(r)
        return EarResult(
            ear=self.ear,
            familiarisation=self.familiarisation,
            thresholds=tuple(self.thresholds),
            audiogram={f: accept_threshold(rs) for f, rs in sorted(by_freq.items())},
            retest_1k_delta_db=self.retest_delta_db,
            unstable_1k=self.unstable_1k,
        )


class AudiometryProtocol:
    """Drives familiarisation and staircases through the full two-ear ASHA sequence.

    Same event-driven contract as its parts: :meth:`next_presentation` → present →
    :meth:`record_response`, until :attr:`is_complete`; then :meth:`result`.
    """

    def __init__(
        self,
        *,
        better_ear: Ear | None = None,
        lattice: LevelLattice | None = None,
        staircase_config: StaircaseConfig | None = None,
        familiarisation_config: FamiliarisationConfig | None = None,
    ) -> None:
        self.lattice = lattice or LevelLattice()
        self.staircase_config = staircase_config or StaircaseConfig()
        self.familiarisation_config = familiarisation_config or FamiliarisationConfig()
        first = better_ear or Ear.RIGHT
        self.ear_order: tuple[Ear, Ear] = (first, first.opposite)
        self._ears = [
            _EarState(first, deque(FIRST_EAR_SEQUENCE)),
            _EarState(first.opposite, deque(SECOND_EAR_SEQUENCE)),
        ]
        self._ear_index = 0
        self._unit: Familiarisation | HughsonWestlakeStaircase | None = self._new_familiarisation()

    # ------------------------------------------------------------------ public API

    @property
    def is_complete(self) -> bool:
        return self._unit is None

    @property
    def current_ear(self) -> Ear | None:
        return None if self.is_complete else self._ears[self._ear_index].ear

    def next_presentation(self) -> Presentation | None:
        return None if self._unit is None else self._unit.next_presentation()

    def record_response(self, responded: bool) -> None:
        if self._unit is None:
            raise RuntimeError("protocol is complete")
        self._unit.record_response(responded)
        if self._unit.is_complete:
            self._advance()

    def ear_results_so_far(self) -> tuple[EarResult, ...]:
        """Results for every ear whose familiarisation has finished, complete or not.

        Lets an aborted session still report the threshold searches it did finish
        (spec §7.3: partial sessions are research data — keep them, mark them).
        """
        return tuple(e.to_result() for e in self._ears if e.familiarisation is not None)

    def result(self) -> ProtocolResult:
        if not self.is_complete:
            raise RuntimeError("protocol has not completed")
        return ProtocolResult(
            protocol_version=PROTOCOL_VERSION,
            ear_order=self.ear_order,
            ears=tuple(e.to_result() for e in self._ears),
        )

    # ------------------------------------------------------------------ sequencing

    @property
    def _ear(self) -> _EarState:
        return self._ears[self._ear_index]

    def _new_familiarisation(self) -> Familiarisation:
        return Familiarisation(
            self._ear.ear,
            FAMILIARISATION_FREQUENCY_HZ,
            lattice=self.lattice,
            config=self.familiarisation_config,
        )

    def _advance(self) -> None:
        unit, ear = self._unit, self._ear
        if isinstance(unit, Familiarisation):
            ear.familiarisation = unit.result()
        elif isinstance(unit, HughsonWestlakeStaircase):
            res = unit.result()
            ear.thresholds.append(res)
            if res.test_role is SearchRole.RETEST:
                self._evaluate_retest(ear, res)

        if ear.plan:
            self._unit = self._next_staircase(ear)
        elif self._ear_index + 1 < len(self._ears):
            self._ear_index += 1
            self._unit = self._new_familiarisation()
        else:
            self._unit = None

    def _next_staircase(self, ear: _EarState) -> HughsonWestlakeStaircase:
        frequency, role = ear.plan.popleft()
        return HughsonWestlakeStaircase(
            ear.ear,
            frequency,
            self._start_level(ear),
            lattice=self.lattice,
            config=self.staircase_config,
            role=role,
        )

    def _start_level(self, ear: _EarState) -> int:
        assert ear.familiarisation is not None
        if not ear.thresholds:
            return ear.familiarisation.level_db_hl
        previous = ear.last_measured_threshold()
        if previous is None:
            return ear.familiarisation.level_db_hl
        return self.lattice.clamp(previous + SUBSEQUENT_START_OFFSET_DB)[0]

    def _evaluate_retest(self, ear: _EarState, retest: ThresholdResult) -> None:
        initial = next(
            r
            for r in ear.thresholds
            if r.frequency_hz == RETEST_FREQUENCY_HZ and r.test_role is SearchRole.INITIAL
        )
        stable, delta = retest_is_stable(initial, retest)
        ear.retest_delta_db = delta
        if not stable:
            ear.unstable_1k = True
            ear.plan.appendleft((VERIFICATION_EXTRA_FREQUENCY_HZ, SearchRole.VERIFICATION))
            ear.plan.appendleft((RETEST_FREQUENCY_HZ, SearchRole.VERIFICATION))
