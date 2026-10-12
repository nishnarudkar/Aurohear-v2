"""Quality-check probe after each measured threshold (spec §6.3 design table, §10 #7).

    "After each threshold is fixed, re-present at threshold and at threshold + 5 dB;
     a non-response at +5 dB is a quality-check failure."

The probe never changes the threshold: it is evidence about the listener's reliability,
reported as QUALIND indicator 7 (quality-check fail rate). If threshold + 5 dB is above
the frequency's output ceiling, only the at-threshold probe is presented and the pass
status is unknown (None).
"""

from __future__ import annotations

from .levels import STEP_UP_DB, LevelLattice
from .models import Phase, Presentation, ThresholdResult, ThresholdStatus


class QcProbe:
    """Event-driven, same contract as the staircase."""

    def __init__(self, result: ThresholdResult, lattice: LevelLattice) -> None:
        if result.status is not ThresholdStatus.MEASURED or result.threshold_db_hl is None:
            raise ValueError("QC probes follow measured thresholds only")
        self._result = result
        t = result.threshold_db_hl
        self._levels = [t] + ([t + STEP_UP_DB] if t + STEP_UP_DB <= lattice.ceiling else [])
        self._responses: list[bool] = []

    @property
    def is_complete(self) -> bool:
        return len(self._responses) == len(self._levels)

    def next_presentation(self) -> Presentation | None:
        if self.is_complete:
            return None
        r = self._result
        return Presentation(
            ear=r.ear,
            frequency_hz=r.frequency_hz,
            level_db_hl=self._levels[len(self._responses)],
            phase=Phase.QC_PROBE,
            test_role=r.test_role,
        )

    def record_response(self, responded: bool) -> None:
        if self.is_complete:
            raise RuntimeError("QC probe has already terminated")
        self._responses.append(responded)

    def apply(self) -> ThresholdResult:
        """The threshold result annotated with the probe outcome."""
        if not self.is_complete:
            raise RuntimeError("QC probe has not terminated yet")
        at_t = self._responses[0]
        plus5 = self._responses[1] if len(self._responses) > 1 else None
        return self._result.model_copy(
            update={"qc_probe_at_threshold_heard": at_t, "qc_probe_plus5_heard": plus5}
        )
