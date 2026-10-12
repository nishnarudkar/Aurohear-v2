"""Pure-tone threshold engine: Hughson–Westlake staircase + ASHA 2005 sequence.

The engine is pure and event-driven (no clock, no audio, no I/O). The browser runner
asks for the next :class:`Presentation`, plays it, and reports whether the listener
responded.
"""

from .familiarisation import Familiarisation, FamiliarisationConfig
from .levels import FLOOR_DB_HL, MAX_CEILING_DB_HL, FrequencyLattices, LevelLattice
from .models import (
    Ear,
    EarResult,
    FamiliarisationResult,
    FamiliarisationStatus,
    Phase,
    Presentation,
    ProtocolResult,
    SearchRole,
    StaircaseTrial,
    ThresholdResult,
    ThresholdStatus,
)
from .protocol import (
    FIRST_EAR_SEQUENCE,
    INTER_OCTAVE_RULES,
    PROTOCOL_VERSION,
    SECOND_EAR_SEQUENCE,
    AudiometryProtocol,
    accept_threshold,
    inter_octaves_needed,
)
from .qc_probe import QcProbe
from .staircase import HughsonWestlakeStaircase, StaircaseConfig

__all__ = [
    "FIRST_EAR_SEQUENCE",
    "INTER_OCTAVE_RULES",
    "FLOOR_DB_HL",
    "MAX_CEILING_DB_HL",
    "PROTOCOL_VERSION",
    "SECOND_EAR_SEQUENCE",
    "AudiometryProtocol",
    "Ear",
    "EarResult",
    "Familiarisation",
    "FrequencyLattices",
    "FamiliarisationConfig",
    "FamiliarisationResult",
    "FamiliarisationStatus",
    "HughsonWestlakeStaircase",
    "LevelLattice",
    "Phase",
    "Presentation",
    "QcProbe",
    "ProtocolResult",
    "SearchRole",
    "StaircaseConfig",
    "StaircaseTrial",
    "ThresholdResult",
    "ThresholdStatus",
    "accept_threshold",
    "inter_octaves_needed",
]
