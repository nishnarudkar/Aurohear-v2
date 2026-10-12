"""NLP feedback module (docs/NLP_RELIABILITY_MODULE.md): analyser, correlation, API, guarantees."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient
from hypothesis import given, settings
from hypothesis import strategies as st

from aurohear.services.nlp import LexiconFeedbackAnalyzer, correlate
from client_sim import API, SimClient, threshold_listener
from conftest import ADMIN

A = LexiconFeedbackAnalyzer()


def issues(text: str) -> dict[str, str]:
    return {i.type: i.severity for i in A.analyze(text).issues}


def symptoms(text: str) -> set[str]:
    return {s.symptom for s in A.analyze(text).symptoms}


# ================================================================ synthetic feedback samples


@pytest.mark.parametrize(
    ("text", "sentiment"),
    [
        ("The test was really easy and the instructions were clear. Thank you!", "positive"),
        ("The instructions were confusing and the app crashed twice.", "negative"),
        ("Easy to use, but the tones were painfully loud.", "mixed"),  # a pro and a con
        ("The tones were painfully loud.", "negative"),
        ("Okay at first, but then it was confusing, frustrating and it crashed.", "negative"),  # "but" weights the second clause
        ("Great app, but the slider was confusing and the screen froze once.", "mixed"),
        ("I took the test on Tuesday.", "neutral"),
        ("The instructions were not confusing at all.", "positive"),  # negation
    ],
)
def test_sentiment(text: str, sentiment: str) -> None:
    assert A.analyze(text).sentiment == sentiment


def test_polarity_and_subjectivity_ranges_and_ordering() -> None:
    good = A.analyze("Excellent, very clear and easy.")
    bad = A.analyze("Terrible, very confusing and it crashed.")
    flat = A.analyze("The test has three parts.")
    assert -1 < bad.polarity < 0 < good.polarity < 1
    assert flat.polarity == 0
    assert A.analyze("I felt it was really easy and I liked it.").subjectivity > flat.subjectivity
    for r in (good, bad, flat):
        assert 0 <= r.subjectivity <= 1


def test_intensifiers_and_dampeners() -> None:
    assert A.analyze("It was very confusing.").polarity < A.analyze("It was confusing.").polarity < A.analyze("It was slightly confusing.").polarity < 0


def test_uncertainty_from_hedging() -> None:
    assert A.analyze("I'm not sure I heard the quiet ones, maybe I pressed too late?").uncertainty > 0.5
    assert A.analyze("I heard every tone clearly.").uncertainty == 0


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("There was a crackling noise in the headphones.", {"audio_quality": "medium"}),
        ("The tones were too loud and hurt my ears.", {"volume_level": "high"}),
        ("The tones were a bit too loud.", {"volume_level": "low"}),
        ("I couldn't hear any of the tones.", {"volume_level": "high"}),
        ("The instructions were hard to follow.", {"ui_instructions": "medium"}),
        ("The page crashed and I lost my progress.", {"technical_failure": "high"}),
        ("The app froze on the calibration screen.", {"technical_failure": "high"}),
    ],
)
def test_issue_categories_and_severity(text: str, expected: dict[str, str]) -> None:
    assert issues(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "The instructions were clear and the buttons were easy to find.",  # topic words in praise
        "Some tones were very faint, which I guess is the point.",  # faint tones are the test working
        "No problems with the volume.",
        "It didn't crash at all.",
    ],
)
def test_no_false_issues(text: str) -> None:
    assert issues(text) == {}


@pytest.mark.parametrize(
    ("text", "intent"),
    [
        ("How long does the test take?", "question"),
        ("You should add a progress bar.", "suggestion"),
        ("It would be better with bigger buttons.", "suggestion"),
        ("The app crashed.", "complaint"),
        ("Lovely, clear and quick. Thanks!", "praise"),
    ],
)
def test_intent(text: str, intent: str) -> None:
    assert A.analyze(text).intent == intent


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("My ears have been ringing for weeks.", {"tinnitus"}),
        ("I have tinnitus in my left ear.", {"tinnitus"}),
        ("My left ear is worse than my right.", {"unilateral_hearing_loss"}),
        ("I can't hear in my right ear.", {"unilateral_hearing_loss"}),
        ("I felt dizzy afterwards and the room was spinning.", {"dizziness_vertigo"}),
        ("My ears feel blocked, like pressure.", {"ear_fullness"}),
        ("There was a buzzing noise in the headphones.", set()),  # device noise, not tinnitus
        ("No ringing in my ears and no dizziness.", set()),  # negated
        ("The ringing tone at the start was clear.", set()),  # the test's own tone
    ],
)
def test_symptom_extraction(text: str, expected: set[str]) -> None:
    assert symptoms(text) == expected


def test_red_flag_topics_need_human_review_but_ordinary_feedback_does_not() -> None:
    for text in ("I suddenly lost hearing in my left ear.", "I felt dizzy during the test.", "My ear pain got worse."):
        r = A.analyze(text)
        assert r.requires_clinical_review and r.review_reasons
    for text in ("The test was easy.", "No dizziness at all.", "The tones were too loud."):
        assert not A.analyze(text).requires_clinical_review


# ================================================================ correlation (research annotation)


def aud(right: int, left: int, **overrides: int) -> dict[str, dict[int, float | None]]:
    out: dict[str, dict[int, float | None]] = {
        "right": {f: float(right) for f in (250, 500, 1000, 2000, 3000, 4000, 6000, 8000)},
        "left": {f: float(left) for f in (250, 500, 1000, 2000, 3000, 4000, 6000, 8000)},
    }
    for k, v in overrides.items():
        ear, f = k.split("_")
        out[ear][int(f)] = float(v)
    return out


def test_correlation_rules() -> None:
    [c] = correlate(["unilateral_hearing_loss"], aud(5, 30))
    assert c.concordance == "consistent" and c.measured["difference_db"] == 25
    [c] = correlate(["unilateral_hearing_loss"], aud(10, 15))
    assert c.concordance == "symptom_without_finding"
    [c] = correlate(["tinnitus"], aud(10, 10, left_4000=45))
    assert c.concordance == "consistent" and c.measured["left_4000"] == 45
    [c] = correlate(["tinnitus"], aud(10, 10))
    assert c.concordance == "symptom_without_finding"
    assert [x.concordance for x in correlate(["dizziness_vertigo", "ear_fullness"], aud(0, 0))] == ["no_audiometric_correlate"] * 2
    assert correlate(["tinnitus"], None)[0].concordance == "not_assessable"


# ================================================================ API


def finished_session(client: TestClient, audiogram: dict[str, dict[int, int]] | None = None) -> tuple[SimClient, dict[str, Any]]:
    sim = SimClient.start(client)
    freqs = (250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000)
    sim.run(threshold_listener(audiogram or {e: {f: 10 for f in freqs} for e in ("right", "left")}))
    return sim, sim.finalize()


def test_feedback_is_post_test_only(client: TestClient) -> None:
    sim = SimClient.start(client)
    r = client.post(f"{API}/sessions/{sim.session_id}/feedback", json={"text": "So far so good."})
    assert r.status_code == 409
    assert "after the test" in r.json()["error"]["message"]


def test_feedback_is_analysed_automatically_and_correlated_with_the_audiogram(client: TestClient) -> None:
    freqs = (250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000)
    audiogram = {"right": {f: 10 for f in freqs}, "left": {f: 10 for f in freqs}}
    audiogram["right"][4000] = audiogram["right"][6000] = 45  # high-frequency loss, right ear
    sim, _ = finished_session(client, audiogram)
    text = "Easy test. My ears have been ringing for months, especially the right one."
    r = client.post(f"{API}/sessions/{sim.session_id}/feedback", json={"text": text})
    assert r.status_code == 201
    assert "insights" not in r.json() and "sentiment" not in str(r.json())  # nothing shown to the participant

    data = client.get(f"{API}/sessions/{sim.session_id}/insights", headers=ADMIN).json()
    assert data["count"] == 1
    ins = data["insights"][0]
    assert ins["model_name"] == "aurohear-lexicon-analyzer"
    assert [s["symptom"] for s in ins["symptoms"]] == ["tinnitus"]
    (corr,) = ins["correlations"]
    assert corr["symptom"] == "tinnitus" and corr["concordance"] == "consistent"
    assert corr["measured"]["right_4000"] == 45
    assert -1 <= ins["polarity"] <= 1 and 0 <= ins["subjectivity"] <= 1


def test_feedback_never_changes_the_clinical_result(client: TestClient) -> None:
    """Clinical independence: thresholds, QC and classification are identical after NLP."""
    sim, _ = finished_session(client)
    before = client.get(f"{API}/sessions/{sim.session_id}/results").json()
    client.post(f"{API}/sessions/{sim.session_id}/feedback", json={"text": "I felt dizzy and my left ear is much worse. Terrible test!"})
    after = client.get(f"{API}/sessions/{sim.session_id}/results").json()
    assert after == before


def test_insights_are_admin_only(client: TestClient, engine: Any) -> None:
    sim, _ = finished_session(client)
    url = f"{API}/sessions/{sim.session_id}/insights"
    assert client.get(url).status_code == 401
    assert client.get(url, headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get(url, headers=ADMIN).status_code == 200
    assert client.get(f"{API}/sessions/{sim.session_id}/feedback").status_code == 401

    from aurohear.api.app import create_app
    from aurohear.config import Settings

    with TestClient(create_app(engine, Settings(database_url="sqlite://", admin_token=None))) as no_admin:
        r = no_admin.get(url, headers=ADMIN)
        assert r.status_code == 403 and r.json()["error"]["code"] == "admin_disabled"


def test_a_failing_analyser_never_loses_the_feedback(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    from aurohear.services import feedback as svc

    class Broken:
        def analyze(self, text: str) -> Any:
            raise RuntimeError("model unavailable")

    monkeypatch.setattr(svc, "_default_analyzer", Broken())
    sim, _ = finished_session(client)
    r = client.post(f"{API}/sessions/{sim.session_id}/feedback", json={"text": "The test was fine."})
    assert r.status_code == 201
    listed = client.get(f"{API}/sessions/{sim.session_id}/feedback", headers=ADMIN).json()
    assert listed[0]["text"] == "The test was fine." and listed[0]["insights"] == []


def test_aborted_session_feedback_is_analysed_without_correlation(client: TestClient) -> None:
    sim = SimClient.start(client)
    client.post(f"{API}/sessions/{sim.session_id}/abort", json={"reason": "user"})
    client.post(f"{API}/sessions/{sim.session_id}/feedback", json={"text": "My ears are ringing, I had to stop."})
    ins = client.get(f"{API}/sessions/{sim.session_id}/insights", headers=ADMIN).json()["insights"][0]
    assert ins["correlations"][0]["concordance"] == "not_assessable"  # never finalised: no audiogram


# ================================================================ properties


@settings(max_examples=300, deadline=None)
@given(st.text(min_size=0, max_size=400))
def test_property_analyser_is_total_bounded_and_deterministic(text: str) -> None:
    a, b = A.analyze(text), A.analyze(text)
    assert a == b
    assert -1 <= a.polarity <= 1 and 0 <= a.subjectivity <= 1 and 0 <= a.uncertainty <= 1
    assert all(0 <= v <= 1 for v in a.emotions.values())
    assert a.sentiment in {"positive", "negative", "neutral", "mixed"}
    assert a.intent in {None, "complaint", "suggestion", "praise", "question"}
    assert {i.type for i in a.issues} <= {"audio_quality", "volume_level", "ui_instructions", "technical_failure"}


words = st.sampled_from("the test was easy clear confusing loud quiet tones instructions great bad crashed ears ringing dizzy i felt very not but".split())


@settings(max_examples=300, deadline=None)
@given(st.lists(words, min_size=1, max_size=25).map(" ".join))
def test_property_domain_sentences_never_break(text: str) -> None:
    r = A.analyze(text)
    assert r.requires_clinical_review == bool(r.review_reasons)
