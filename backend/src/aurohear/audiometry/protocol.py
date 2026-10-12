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

Inter-octave rule (spec §6.4): after an ear's octave sequence (and any verification
searches), 750 Hz is added if |T(500) − T(1000)| ≥ 20 dB and 1500 Hz if
|T(1000) − T(2000)| ≥ 20 dB, using the *accepted* thresholds (a no-response counts at
its ceiling; an unresolved result cannot trigger). 3000 and 6000 Hz — the spec's other
two inter-octaves — are always tested in the ASHA order, so they are never conditional.
Inter-octaves are tested before the ear switch.

QC probes (spec §6.3): every measured threshold is followed by re-presentations at the
threshold and at threshold + 5 dB (see qc_probe.py). On by default; `qc_probes=False`
disables them.

Output ceilings (spec §3.4) are per frequency: `frequency_caps_db_hl` (from the
transducer profile) is floored to the 5 dB grid and capped at 90 dB HL, and every
familiarisation, start level, staircase step, no-response and probe respects it.

Not implemented: 125 Hz, catch trials (client runner), mandatory inter-ear break (UI).
"""

from __future__ import annotations

from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field

from .familiarisation import Familiarisation, FamiliarisationConfig
from .levels import FrequencyLattices, LevelLattice
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
from .qc_probe import QcProbe
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

INTER_OCTAVE_DIFFERENCE_DB = 20
INTER_OCTAVE_RULES: tuple[tuple[int, int, int], ...] = (
    # (inter-octave, lower octave, upper octave) — the conditional ones (spec §6.4)
    (750, 500, 1000),
    (1500, 1000, 2000),
)


def inter_octaves_needed(audiogram: Mapping[int, ThresholdResult]) -> list[int]:
    """Inter-octave frequencies triggered by the accepted thresholds of one ear."""
    out: list[int] = []
    for f, lo, hi in INTER_OCTAVE_RULES:
        a, b = audiogram.get(lo), audiogram.get(hi)
        if a is None or b is None or a.threshold_db_hl is None or b.threshold_db_hl is None:
            continue  # unresolved / untested: the rule cannot fire
        if abs(a.threshold_db_hl - b.threshold_db_hl) >= INTER_OCTAVE_DIFFERENCE_DB and f not in audiogram:
            out.append(f)
    return out


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
    inter_octaves_evaluated: bool = False
    inter_octave_frequencies: set[int] = field(default_factory=set)

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
        frequency_caps_db_hl: Mapping[int, float] | None = None,
        staircase_config: StaircaseConfig | None = None,
        familiarisation_config: FamiliarisationConfig | None = None,
        qc_probes: bool = True,
        inter_octaves: bool = True,
    ) -> None:
        self.lattice = lattice or LevelLattice()
        self.lattices = FrequencyLattices(default=self.lattice, caps_db_hl=dict(frequency_caps_db_hl or {}))
        self.qc_probes = qc_probes
        self.inter_octaves = inter_octaves
        self._pending: ThresholdResult | None = None
        self.staircase_config = staircase_config or StaircaseConfig()
        self.familiarisation_config = familiarisation_config or FamiliarisationConfig()
        first = better_ear or Ear.RIGHT
        self.ear_order: tuple[Ear, Ear] = (first, first.opposite)
        self._ears = [
            _EarState(first, deque(FIRST_EAR_SEQUENCE)),
            _EarState(first.opposite, deque(SECOND_EAR_SEQUENCE)),
        ]
        self._ear_index = 0
        self._unit: Familiarisation | HughsonWestlakeStaircase | QcProbe | None = self._new_familiarisation()

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
            lattice=self.lattices.for_frequency(FAMILIARISATION_FREQUENCY_HZ),
            config=self.familiarisation_config,
        )

    def _advance(self) -> None:
        unit, ear = self._unit, self._ear
        if isinstance(unit, Familiarisation):
            ear.familiarisation = unit.result()
        elif isinstance(unit, HughsonWestlakeStaircase):
            res = unit.result()
            if res.frequency_hz in ear.inter_octave_frequencies:
                res = res.model_copy(update={"is_interoctave": True})
            if self.qc_probes and res.status is ThresholdStatus.MEASURED:
                self._pending = res
                self._unit = QcProbe(res, self.lattices.for_frequency(res.frequency_hz))
                return
            self._commit(ear, res)
        elif isinstance(unit, QcProbe):
            assert self._pending is not None
            self._pending = None
            self._commit(ear, unit.apply())

        if not ear.plan and self.inter_octaves and not ear.inter_octaves_evaluated:
            ear.inter_octaves_evaluated = True
            added = inter_octaves_needed(ear.to_result().audiogram)
            ear.inter_octave_frequencies.update(added)
            ear.plan.extend((f, SearchRole.INITIAL) for f in added)

        if ear.plan:
            self._unit = self._next_staircase(ear)
        elif self._ear_index + 1 < len(self._ears):
            self._ear_index += 1
            self._unit = self._new_familiarisation()
        else:
            self._unit = None

    def _commit(self, ear: _EarState, res: ThresholdResult) -> None:
        ear.thresholds.append(res)
        if res.test_role is SearchRole.RETEST:
            self._evaluate_retest(ear, res)

    def _next_staircase(self, ear: _EarState) -> HughsonWestlakeStaircase:
        frequency, role = ear.plan.popleft()
        lattice = self.lattices.for_frequency(frequency)
        return HughsonWestlakeStaircase(
            ear.ear,
            frequency,
            self._start_level(ear, lattice),
            lattice=lattice,
            config=self.staircase_config,
            role=role,
        )

    def _start_level(self, ear: _EarState, lattice: LevelLattice) -> int:
        """Spec §6.3 step 1, clamped to *this frequency's* ceiling."""
        assert ear.familiarisation is not None
        previous = ear.last_measured_threshold() if ear.thresholds else None
        base = ear.familiarisation.level_db_hl if previous is None else previous + SUBSEQUENT_START_OFFSET_DB
        return lattice.clamp(base)[0]

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
