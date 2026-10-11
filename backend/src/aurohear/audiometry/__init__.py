"""Pure-tone threshold engine: Hughson–Westlake staircase + ASHA 2005 sequence.

The engine is pure and event-driven (no clock, no audio, no I/O). The browser runner
asks for the next :class:`Presentation`, plays it, and reports whether the listener
responded.
"""

from .familiarisation import Familiarisation, FamiliarisationConfig
from .levels import FLOOR_DB_HL, MAX_CEILING_DB_HL, LevelLattice
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
    PROTOCOL_VERSION,
    SECOND_EAR_SEQUENCE,
    AudiometryProtocol,
    accept_threshold,
)
from .staircase import HughsonWestlakeStaircase, StaircaseConfig

__all__ = [
    "FIRST_EAR_SEQUENCE",
    "FLOOR_DB_HL",
    "MAX_CEILING_DB_HL",
    "PROTOCOL_VERSION",
    "SECOND_EAR_SEQUENCE",
    "AudiometryProtocol",
    "Ear",
    "EarResult",
    "Familiarisation",
    "FamiliarisationConfig",
    "FamiliarisationResult",
    "FamiliarisationStatus",
    "HughsonWestlakeStaircase",
    "LevelLattice",
    "Phase",
    "Presentation",
    "ProtocolResult",
    "SearchRole",
    "StaircaseConfig",
    "StaircaseTrial",
    "ThresholdResult",
    "ThresholdStatus",
    "accept_threshold",
]
