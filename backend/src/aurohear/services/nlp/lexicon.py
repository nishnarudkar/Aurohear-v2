"""Domain lexicons for the feedback analyser (hearing-test feedback, English).

Kept as plain data so they can be reviewed, versioned and extended without touching the
analyser. Valences are on a −3…+3 scale (VADER-style). Words that are normal features
of a hearing test ("faint", "quiet", "beep") are deliberately NOT negative.
"""

from __future__ import annotations

LEXICON_VERSION = "aurohear-lexicon-1.0"

VALENCE: dict[str, float] = {
    # positive
    "clear": 2.0, "clearly": 1.5, "easy": 2.0, "easily": 1.5, "simple": 1.5, "straightforward": 1.8,
    "helpful": 2.0, "great": 3.0, "good": 1.9, "fine": 1.0, "nice": 1.8, "smooth": 1.8, "quick": 1.2,
    "fast": 1.0, "comfortable": 2.0, "excellent": 3.0, "perfect": 2.8, "love": 2.8, "loved": 2.8,
    "like": 1.2, "liked": 1.5, "useful": 1.8, "intuitive": 2.0, "thanks": 1.5, "thank": 1.5,
    "pleasant": 2.0, "reassuring": 1.8, "worked": 1.2, "works": 1.2, "enjoyed": 2.0, "happy": 2.2,
    "well": 1.0, "professional": 1.5, "relaxing": 1.5, "calm": 1.2,
    # negative
    "confusing": -2.2, "confused": -2.0, "unclear": -1.8, "difficult": -1.8, "hard": -1.3,
    "annoying": -2.2, "annoyed": -2.0, "frustrating": -2.5, "frustrated": -2.5, "painful": -2.8,
    "hurt": -2.4, "hurts": -2.4, "uncomfortable": -2.0, "broken": -2.5, "crashed": -2.6, "crash": -2.4,
    "froze": -2.3, "frozen": -2.3, "stuck": -2.0, "error": -1.8, "bug": -1.8, "buggy": -2.0,
    "terrible": -3.0, "awful": -3.0, "bad": -2.0, "poor": -1.8, "slow": -1.3, "long": -0.8,
    "tedious": -1.8, "boring": -1.5, "useless": -2.6, "worse": -1.8, "worst": -3.0, "hate": -2.8,
    "stressful": -2.0, "stressed": -1.8, "anxious": -1.8, "worried": -1.6, "scary": -2.0,
    "distorted": -2.0, "crackling": -1.8, "glitch": -1.8, "glitchy": -2.0, "failed": -2.2,
    "impossible": -2.6, "painfully": -2.6, "deafening": -2.6, "irritating": -2.2, "disappointing": -2.2, "disappointed": -2.2,
}

NEGATORS = frozenset({"not", "no", "never", "without", "hardly", "barely", "nothing", "none", "neither", "nor", "cannot"})
INTENSIFIERS: dict[str, float] = {
    "very": 1.3, "really": 1.3, "extremely": 1.5, "so": 1.2, "too": 1.25, "incredibly": 1.5,
    "totally": 1.3, "completely": 1.4, "quite": 1.1, "super": 1.3,
}
DAMPENERS: dict[str, float] = {"slightly": 0.6, "somewhat": 0.7, "bit": 0.6, "little": 0.7, "kinda": 0.7, "kind": 0.8, "fairly": 0.8}
CONTRAST = frozenset({"but", "however", "although", "though", "yet"})

HEDGES = (
    "not sure", "unsure", "maybe", "perhaps", "i think", "i guess", "might", "possibly", "probably",
    "don't know", "dont know", "not certain", "uncertain", "i wonder", "seemed", "i suppose", "kind of", "sort of",
)
SUBJECTIVE_MARKERS = frozenset({"i", "me", "my", "felt", "feel", "feeling", "think", "thought", "seemed", "seems", "found", "personally"})

EMOTIONS: dict[str, frozenset[str]] = {
    "frustration": frozenset({"frustrating", "frustrated", "annoying", "annoyed", "irritating", "stuck", "tedious", "hate"}),
    "confusion": frozenset({"confusing", "confused", "unclear", "lost", "understand", "puzzled", "unsure"}),
    "satisfaction": frozenset({"great", "good", "easy", "clear", "helpful", "excellent", "perfect", "love", "liked", "happy", "smooth"}),
    "anxiety": frozenset({"anxious", "worried", "stressful", "stressed", "scary", "nervous", "afraid", "concerned"}),
}

# Issue categories (prompt 7). PROBLEM patterns always indicate an issue; TOPIC patterns
# (neutral nouns like "instructions" or "volume") count only in a negatively-toned
# sentence — "the instructions were clear" is praise, not an instructions issue.
ISSUE_PATTERNS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "audio_quality": (
        (
            r"crackl\w*", r"distort\w*", r"static", r"hiss\w* (?:sound|noise)", r"buzz\w* (?:sound|noise)",
            r"click\w* (?:sound|noise)", r"glitch\w*", r"(?:tone|sound|audio)s? (?:was|were|sounded) (?:weird|strange|off|rough|crackly)",
            r"echo\w*", r"popping", r"noisy (?:tone|audio|sound)",
        ),
        (r"sound quality",),
    ),
    "volume_level": (
        (
            r"too loud", r"too quiet", r"too soft", r"(?:very|really|extremely) loud", r"hurt my ears?", r"painfully loud",
            r"(?:couldn'?t|could not|can'?t|cannot) hear (?:anything|any of|the tones?|it)", r"barely (?:hear|audible)",
        ),
        (r"volume", r"loudness", r"loud", r"quiet"),
    ),
    "ui_instructions": (
        (
            r"confus\w*", r"unclear", r"(?:didn'?t|did not|don'?t) understand", r"what to do",
            r"(?:hard|difficult) to (?:follow|understand|know|read|find)", r"(?:too )?small text",
        ),
        (r"instructions?", r"button", r"screen", r"slider", r"layout", r"steps?"),
    ),
    "technical_failure": (
        (
            r"crash\w*", r"froze", r"freez\w*", r"error", r"bug\w*", r"stuck",
            r"(?:didn'?t|did not|wouldn'?t|would not) (?:load|work|start|play)", r"(?:not|stopped) working",
            r"disconnect\w*", r"lost (?:connection|my progress)", r"blank (?:screen|page)",
        ),
        (r"reload\w*", r"connection", r"loading"),
    ),
}
SEVERE_MARKERS = (
    r"crash\w*", r"froze", r"couldn'?t", r"could not", r"cannot", r"can'?t", r"impossible", r"never", r"hurt\w*",
    r"pain\w*", r"lost (?:connection|my progress)", r"(?:didn'?t|did not|wouldn'?t) (?:load|work|start)", r"blank (?:screen|page)",
)
MILD_MARKERS = (r"a bit", r"slightly", r"a little", r"somewhat", r"minor", r"sometimes", r"once")

# Auditory symptoms (prompt 7). Patterns are scoped to ears/hearing to avoid confusing a
# device "buzz" or the test's own "ringing tone" with tinnitus.
SYMPTOM_PATTERNS: dict[str, tuple[str, ...]] = {
    "tinnitus": (
        r"tinnitus", r"ringing in (?:my|both|the|one) ears?", r"ringing ears", r"my ears? (?:ring|rings|ringing|buzz|buzzes|hiss|hum)",
        r"my ears? (?:have been|has been|are|were|keep|kept|started|start) (?:ringing|buzzing|humming|hissing)",
        r"(?:buzzing|humming|hissing|whooshing) in (?:my|both|the|one) ears?", r"ears? (?:are|were|keep) ringing",
    ),
    "unilateral_hearing_loss": (
        r"(?:deaf|hearing loss|can'?t hear|cannot hear|worse hearing|hear less) in (?:my |the )?(?:left|right|one) ear",
        r"(?:left|right|one) ear (?:is|was|seems|feels) (?:worse|weaker|deaf|muffled|bad)",
        r"only hear (?:with|in|out of) (?:my |the )?(?:left|right|one) ear", r"one-sided hearing",
    ),
    "dizziness_vertigo": (r"dizz\w*", r"vertigo", r"(?:room|world|head) (?:is |was )?spinning", r"light-?headed", r"off balance", r"unsteady"),
    "ear_fullness": (
        r"ears? (?:feel|feels|felt) (?:full|blocked|plugged|clogged|stuffy|pressure)", r"(?:blocked|plugged|clogged) ears?",
        r"pressure in (?:my|the|both|one) ears?", r"fullness",
    ),
}
# Spec red-flag topics (§7.3/§9.4): mention → human review flag, never a result change.
REVIEW_TRIGGERS = (
    r"sudden\w*", r"dizz\w*", r"vertigo", r"(?:ear|ears) (?:pain|ache|hurt\w*)", r"earache", r"discharge", r"fluid (?:from|in) (?:my|the) ear",
    r"(?:left|right|one) ear (?:is|was) (?:deaf|worse)", r"deaf in (?:my |the )?(?:left|right|one) ear", r"pulsing|pulsat\w*|heartbeat in my ear",
)

QUESTION_STARTS = ("how", "what", "why", "when", "where", "who", "which", "is", "are", "can", "could", "should", "will", "does", "do", "did")
SUGGESTION_PATTERNS = (
    r"\bshould\b", r"\bcould you\b", r"\bwould be (?:better|nice|good|great)\b", r"\bplease (?:add|make|allow|let|include)\b",
    r"\bsuggest\w*\b", r"\bit would help\b", r"\bmaybe add\b", r"\bi wish\b", r"\bwould like\b", r"\bconsider\b",
)
