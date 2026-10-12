"""End-to-end API tests: whole sessions run over HTTP against a migrated database."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from aurohear.audiometry import PROTOCOL_VERSION
from aurohear.db import TrialRow
from client_sim import API, SimClient, audiogram_of, session_body, threshold_listener
from conftest import ADMIN

FREQS = (250, 500, 1000, 2000, 3000, 4000, 6000, 8000)
AUDIOGRAM = {
    "right": {250: 10, 500: 15, 1000: 20, 2000: 30, 3000: 45, 4000: 60, 6000: 75, 8000: 85},
    "left": {250: 0, 500: 5, 1000: 5, 2000: 10, 3000: 20, 4000: 35, 6000: 50, 8000: 70},
}


def flat(level: float) -> dict[str, dict[int, float]]:
    return {ear: {f: level for f in FREQS} for ear in ("right", "left")}


# ------------------------------------------------------------------ session init


def test_health(client: TestClient) -> None:
    r = client.get("/health")
    assert r.json()["protocol_version"] == PROTOCOL_VERSION


def test_create_session_pins_protocol_and_returns_first_presentation(client: TestClient) -> None:
    r = client.post(f"{API}/sessions", json=session_body())
    assert r.status_code == 201
    data = r.json()
    assert data["session"]["status"] == "in_progress"
    assert data["session"]["protocol_version"] == PROTOCOL_VERSION
    assert data["trial_count"] == 0
    assert data["next_presentation"] == {
        "ear": "right", "frequency_hz": 1000, "level_db_hl": 40, "phase": "familiarisation", "test_role": "initial",
    }


def test_better_ear_is_tested_first(client: TestClient) -> None:
    sim = SimClient.start(client, better_ear="left")
    assert sim.next_presentation is not None and sim.next_presentation["ear"] == "left"


def test_client_cannot_choose_protocol_version(client: TestClient) -> None:
    r = client.post(f"{API}/sessions", json=session_body(protocol_version="evil-v9"))
    assert r.status_code == 422


# ------------------------------------------------------------------ full sessions


def test_full_session_over_http_recovers_true_audiogram(client: TestClient) -> None:
    sim = SimClient.start(client)
    n = sim.run(threshold_listener(AUDIOGRAM))
    res = sim.finalize()
    assert res["session"]["status"] == "complete"
    assert res["session"]["completed_at"] is not None
    assert res["protocol_complete"] is True
    assert audiogram_of(res) == AUDIOGRAM
    assert all(t["status"] == "measured" for t in res["audiogram"])
    q = res["quality_metrics"]
    assert q["tone_trials"] == n
    assert q["catch_trials"] == 0 and q["false_positive_rate"] is None
    assert q["mean_latency_ms"] == pytest.approx(420.0)
    assert q["retest_1k_delta_db"] == 0 and q["unstable_1k"] is False
    assert q["possible_shadow_count"] == 0
    # Every search is stored, in test order; one accepted per ear × frequency.
    assert [t["search_index"] for t in res["thresholds"]] == list(range(len(res["thresholds"])))
    assert len(res["audiogram"]) == 16
    trials = client.get(f"{API}/sessions/{sim.session_id}/trials").json()
    assert [t["seq"] for t in trials] == list(range(n))


def test_catch_trials_are_logged_but_never_move_the_staircase(client: TestClient) -> None:
    sim = SimClient.start(client)
    sim.run(
        threshold_listener(AUDIOGRAM),
        insert_catch=lambda i: i % 4 == 0,
        catch_response=lambda i: i % 8 == 0,  # every other catch trial is a false alarm
    )
    res = sim.finalize()
    assert audiogram_of(res) == AUDIOGRAM  # identical to the catch-free run
    q = res["quality_metrics"]
    catches = [b for b in sim.posted if b["is_catch_trial"]]
    fas = [b for b in catches if b["responded"]]
    assert q["catch_trials"] == len(catches) > 0
    assert q["catch_false_alarms"] == len(fas) > 0
    assert q["false_positive_rate"] == pytest.approx(len(fas) / len(catches))


def test_discarded_trials_are_re_presented_and_counted(client: TestClient) -> None:
    sim = SimClient.start(client)
    sim.run(threshold_listener(AUDIOGRAM), insert_discard=lambda i: i % 7 == 3)
    res = sim.finalize()
    assert audiogram_of(res) == AUDIOGRAM
    assert res["quality_metrics"]["discarded_trials"] == sum(b["discarded"] for b in sim.posted) > 0


def test_unstable_1k_retest_is_flagged_and_verified(client: TestClient) -> None:
    sim = SimClient.start(client)
    base = threshold_listener(flat(30))

    def shifted(p: dict[str, Any]) -> bool:  # 1 kHz is 15 dB worse on retest/verification
        if p["frequency_hz"] == 1000 and p["test_role"] != "initial":
            return p["level_db_hl"] >= 45
        return base(p)

    sim.run(shifted)
    res = sim.finalize()
    q = res["quality_metrics"]
    assert q["unstable_1k"] is True and q["retest_1k_delta_db"] == 15
    roles = [(t["frequency_hz"], t["test_role"]) for t in res["thresholds"] if t["ear"] == "right"]
    assert (1000, "verification") in roles and (2000, "verification") in roles
    right_1k = next(t for t in res["audiogram"] if t["ear"] == "right" and t["frequency_hz"] == 1000)
    assert right_1k["threshold_db_hl"] == 30 and right_1k["test_role"] == "initial"  # lower is accepted


def test_possible_shadow_is_flagged_on_the_poorer_ear(client: TestClient) -> None:
    audiogram = {"right": {f: 0 for f in FREQS}, "left": {f: 0 for f in FREQS}}
    audiogram["left"][4000] = 50  # interaural Δ = 50 dB ≥ 40
    sim = SimClient.start(client)
    sim.run(threshold_listener(audiogram))
    res = sim.finalize()
    flagged = [(t["ear"], t["frequency_hz"]) for t in res["audiogram"] if t["possible_shadow"]]
    assert flagged == [("left", 4000)]
    assert res["quality_metrics"]["possible_shadow_count"] == 1


def test_profile_cap_yields_no_response_at_the_cap(client: TestClient) -> None:
    sim = SimClient.start(client, profile_cap_db_hl=70)
    sim.run(threshold_listener(flat(80)))
    res = sim.finalize()
    assert all(t["status"] == "no_response" and t["threshold_db_hl"] == 70 for t in res["audiogram"])
    assert res["quality_metrics"]["no_response_thresholds"] == 16


# ------------------------------------------------------------------ integrity of the trial log


def test_trial_that_does_not_match_the_protocol_is_rejected(client: TestClient) -> None:
    sim = SimClient.start(client)
    assert sim.next_presentation is not None
    wrong = {**sim.next_presentation, "level_db_hl": 60}
    r = sim.post(sim.trial_body(wrong, responded=True))
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "conflict"
    assert err["expected"]["level_db_hl"] == 40
    assert any("level_db_hl" in m for m in err["mismatches"])


def test_seq_must_be_gapless(client: TestClient) -> None:
    sim = SimClient.start(client)
    body = sim.trial_body(sim.next_presentation, responded=True)  # type: ignore[arg-type]
    body["seq"] = 3
    r = sim.post(body)
    assert r.status_code == 409 and r.json()["error"]["expected_seq"] == 0


def test_retry_with_same_trial_id_is_idempotent(client: TestClient, engine: Engine) -> None:
    sim = SimClient.start(client)
    body = sim.trial_body(sim.next_presentation, responded=True)  # type: ignore[arg-type]
    first = client.post(f"{API}/sessions/{sim.session_id}/trials", json=body)
    retry = client.post(f"{API}/sessions/{sim.session_id}/trials", json=body)
    assert first.status_code == retry.status_code == 200
    assert retry.json()["idempotent_replay"] is True
    assert retry.json()["next_presentation"] == first.json()["next_presentation"]
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(TrialRow)) == 1
    tampered = {**body, "responded": False, "response_at_ms": None, "response_latency_ms": None}
    r = client.post(f"{API}/sessions/{sim.session_id}/trials", json=tampered)
    assert r.status_code == 409


def test_no_trials_after_protocol_complete_or_finalize(client: TestClient) -> None:
    sim = SimClient.start(client)
    sim.run(threshold_listener(flat(20)))
    last = sim.posted[-1]
    extra = sim.trial_body({k: last[k] for k in ("ear", "frequency_hz", "level_db_hl", "phase", "test_role")}, responded=True)
    assert sim.post(extra).status_code == 409  # protocol complete
    sim.finalize()
    assert sim.post(extra).status_code == 409  # session closed


def test_database_enforces_clinical_invariants_independently(engine: Engine, client: TestClient) -> None:
    """A row that bypasses the API is still rejected by CHECK constraints."""
    sim = SimClient.start(client)
    body = sim.trial_body(sim.next_presentation, responded=True)  # type: ignore[arg-type]
    body.pop("trial_id")
    bad_rows = [
        {**body, "is_catch_trial": True, "phase": "catch"},  # catch trial with a level
        {**body, "response_latency_ms": None},  # responded without latency
        {**body, "level_db_hl": 42},  # off the 5 dB lattice
        {**body, "discarded": True},  # discarded without a reason
    ]
    for i, data in enumerate(bad_rows):
        with Session(engine) as db:
            db.add(TrialRow(id=uuid.uuid4(), session_id=uuid.UUID(sim.session_id), **{**data, "seq": i}))
            with pytest.raises(IntegrityError):
                db.commit()


# ------------------------------------------------------------------ abort / finalize


def test_abort_keeps_partial_data_and_finalize_reports_it(client: TestClient) -> None:
    sim = SimClient.start(client)
    listener = threshold_listener(flat(25))
    while len(sim.posted) < 12:
        sim.post(sim.trial_body(sim.next_presentation, responded=listener(sim.next_presentation)))  # type: ignore[arg-type]
    r = client.post(f"{API}/sessions/{sim.session_id}/abort", json={"reason": "device_change"})
    assert r.status_code == 200
    assert r.json()["session"]["status"] == "aborted"
    assert r.json()["next_presentation"] is None
    assert sim.post(sim.trial_body(sim.next_presentation or {}, responded=True) if sim.next_presentation else {}).status_code in (409, 422)
    res = sim.finalize()
    assert res["session"]["status"] == "aborted"
    assert res["session"]["abort_reason"] == "device_change"
    assert res["protocol_complete"] is False
    assert len(res["audiogram"]) >= 1  # completed searches are reported
    assert all(t["threshold_db_hl"] == 25 for t in res["audiogram"])


def test_finalize_mid_session_marks_incomplete(client: TestClient) -> None:
    sim = SimClient.start(client)
    for _ in range(3):
        sim.post(sim.trial_body(sim.next_presentation, responded=True))  # type: ignore[arg-type]
    res = sim.finalize()
    assert res["session"]["status"] == "incomplete"
    assert res["protocol_complete"] is False


def test_finalize_is_idempotent_and_results_are_readable(client: TestClient) -> None:
    sim = SimClient.start(client)
    assert client.get(f"{API}/sessions/{sim.session_id}/results").status_code == 409
    sim.run(threshold_listener(AUDIOGRAM))
    first = sim.finalize()
    second = sim.finalize()
    strip = lambda r: [{k: v for k, v in t.items() if k != "computed_at"} for t in r["thresholds"]]  # noqa: E731
    assert strip(first) == strip(second)
    got = client.get(f"{API}/sessions/{sim.session_id}/results").json()
    assert strip(got) == strip(second)
    assert got["quality_metrics"]["tone_trials"] == first["quality_metrics"]["tone_trials"]


def test_unknown_session_is_404(client: TestClient) -> None:
    sid = uuid.uuid4()
    for method, path in [("get", f"/sessions/{sid}"), ("post", f"/sessions/{sid}/finalize"), ("get", f"/sessions/{sid}/trials")]:
        r = getattr(client, method)(f"{API}{path}")
        assert r.status_code == 404
        assert r.json()["error"]["code"] == "not_found"


# ------------------------------------------------------------------ validation


@pytest.mark.parametrize(
    "patch",
    [
        {"profile_cap_db_hl": 95},
        {"profile_cap_db_hl": 87},
        {"profile_cap_db_hl": "90"},
        {"mode": "screening"},
        {"participant_id": "not-a-uuid"},
        {"unexpected": 1},
        {"device": {"connection": "bluetooth"}},
        {"calibration": {"tier": "B", "method": "model_profile", "profile_version": "v", "calibrated_at": "2026-10-11T09:00:00"}},
    ],
)
def test_session_validation(client: TestClient, patch: dict[str, Any]) -> None:
    assert client.post(f"{API}/sessions", json=session_body(**patch)).status_code == 422


@pytest.mark.parametrize(
    ("label", "patch"),
    [
        ("string number", {"frequency_hz": "1000"}),
        ("float level", {"level_db_hl": 40.0}),
        ("int bool", {"responded": 1}),
        ("off lattice", {"level_db_hl": 42}),
        ("above 90", {"level_db_hl": 95}),
        ("non audiometric frequency", {"frequency_hz": 1234}),
        ("catch with level", {"is_catch_trial": True, "phase": "catch"}),
        ("catch flag without phase", {"is_catch_trial": True, "level_db_hl": None, "presented_level_db_hl": None}),
        ("latency without response", {"responded": False}),
        ("response without latency", {"response_latency_ms": None}),
        ("latency inconsistent", {"response_latency_ms": 999.0}),
        ("response after window", {"response_at_ms": 99_999.0, "response_latency_ms": 99_999.0 - 12_000.0}),
        ("duration inconsistent", {"duration_ms": 500.0}),
        ("discard without reason", {"discarded": True}),
        ("unknown field", {"latency_ms": 420.0}),
    ],
)
def test_trial_validation(client: TestClient, label: str, patch: dict[str, Any]) -> None:
    sim = SimClient.start(client)
    body = {**sim.trial_body(sim.next_presentation, responded=True), **patch}  # type: ignore[arg-type]
    r = client.post(f"{API}/sessions/{sim.session_id}/trials", json=body)
    assert r.status_code == 422, label


# ------------------------------------------------------------------ feedback / NLP


INSIGHT = {
    "model_name": "distilbert-sst2+rules",
    "model_version": "1.4.0",
    "sentiment": "mixed",
    "emotions": {"frustration": 0.62, "confidence": 0.21},
    "uncertainty": 0.35,
    "issues": [{"type": "audio_quality", "severity": "medium", "evidence": "tones were very faint at the end"}],
    "intent": "complaint",
}


def finished(client: TestClient) -> SimClient:
    """Feedback is post-test only: a session that has been finalised."""
    sim = SimClient.start(client)
    sim.finalize()
    return sim


def test_feedback_and_versioned_insights(client: TestClient) -> None:
    sim = finished(client)
    r = client.post(
        f"{API}/sessions/{sim.session_id}/feedback",
        json={"text": "The tones were very faint at the end, not sure I heard them.", "ratings": {"clarity": 3}, "language": "en"},
    )
    assert r.status_code == 201
    fb = r.json()
    assert set(fb) == {"id", "session_id", "submitted_at"}  # receipt only — no NLP output to the participant
    for version in ("1.4.0", "2.0.0"):  # re-analysis adds a row, never overwrites
        r = client.post(f"{API}/feedback/{fb['id']}/insights", json={**INSIGHT, "model_version": version}, headers=ADMIN)
        assert r.status_code == 201
    listed = client.get(f"{API}/sessions/{sim.session_id}/feedback", headers=ADMIN).json()
    assert len(listed) == 1
    # built-in analysis first, then the two external model versions
    assert [i["model_version"] for i in listed[0]["insights"]][1:] == ["1.4.0", "2.0.0"]
    builtin, external = listed[0]["insights"][0], listed[0]["insights"][1]
    assert builtin["model_name"] == "aurohear-lexicon-analyzer"
    assert builtin["issues"] == []  # faint tones are the test working, not a fault
    assert builtin["uncertainty"] > 0  # "not sure I heard them"
    assert external["issues"][0]["severity"] == "medium"


@pytest.mark.parametrize(
    "patch",
    [
        {"sentiment": "angry"},
        {"uncertainty": 1.5},
        {"emotions": {"joy": 2.0}},
        {"intent": "rant"},
        {"issues": [{"type": "audio", "severity": "critical"}]},
        {"uncertainty": "0.3"},
    ],
)
def test_insight_validation(client: TestClient, patch: dict[str, Any]) -> None:
    sim = finished(client)
    fb = client.post(f"{API}/sessions/{sim.session_id}/feedback", json={"text": "Fine overall."}).json()
    assert client.post(f"{API}/feedback/{fb['id']}/insights", json={**INSIGHT, **patch}, headers=ADMIN).status_code == 422


def test_feedback_validation_and_404s(client: TestClient) -> None:
    sim = finished(client)
    url = f"{API}/sessions/{sim.session_id}/feedback"
    assert client.post(url, json={"text": "ok"}).status_code == 422  # < 5 chars
    assert client.post(url, json={"text": "     \n   "}).status_code == 422
    assert client.post(url, json={"text": "Good test.", "ratings": {"clarity": 7}}).status_code == 422
    assert client.post(f"{API}/sessions/{uuid.uuid4()}/feedback", json={"text": "Good test."}).status_code == 404
    assert client.post(f"{API}/feedback/{uuid.uuid4()}/insights", json=INSIGHT, headers=ADMIN).status_code == 404


# ------------------------------------------------------------------ Prompt 2: probes, inter-octaves, caps


FREQS_ALL = (250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000)


def flat_all(level: int) -> dict[str, dict[int, int]]:
    return {ear: {f: level for f in FREQS_ALL} for ear in ("right", "left")}


def test_qc_probes_run_over_http_and_feed_qualind_7(client: TestClient) -> None:
    sim = SimClient.start(client)
    sim.run(threshold_listener(flat_all(30)))
    probes = [b for b in sim.posted if b["phase"] == "qc_probe"]
    res = sim.finalize()
    assert len(probes) == 2 * len(res["thresholds"])  # threshold and +5 dB after every search
    assert {b["level_db_hl"] for b in probes} == {30, 35}
    assert all(t["qc_probe_pass"] is True for t in res["thresholds"])
    q = res["quality_metrics"]
    assert q["qc_probes"] == len(res["thresholds"]) and q["qc_probe_failures"] == 0
    assert q["qc_probe_fail_rate"] == 0.0
    assert audiogram_of(res)["right"][1000] == 30  # probes never move a threshold


def test_missed_plus5_probes_are_qc_failures(client: TestClient) -> None:
    base = threshold_listener(flat_all(30))
    sim = SimClient.start(client)
    sim.run(lambda p: False if p["phase"] == "qc_probe" and p["level_db_hl"] == 35 else base(p))
    res = sim.finalize()
    q = res["quality_metrics"]
    assert q["qc_probe_fail_rate"] == 1.0 and q["qc_probe_failures"] == q["qc_probes"] > 0
    assert all(t["qc_probe_pass"] is False for t in res["thresholds"])
    assert res["classification"]["qc_composite"] == "fair"
    assert any("threshold + 5 dB" in a for a in res["classification"]["annotations"])


def test_probe_when_a_tone_is_expected_is_a_conflict(client: TestClient) -> None:
    sim = SimClient.start(client)
    wrong = {**sim.next_presentation, "phase": "qc_probe"}  # type: ignore[dict-item]
    r = sim.post(sim.trial_body(wrong, responded=True))
    assert r.status_code == 409
    assert any("phase" in m for m in r.json()["error"]["mismatches"])


def test_inter_octave_is_inserted_and_flagged_over_http(client: TestClient) -> None:
    aud = flat_all(10)
    for ear in ("right", "left"):
        aud[ear][2000] = 40  # |1000 − 2000| = 30 → 1500 Hz
        aud[ear][1500] = 25
    sim = SimClient.start(client)
    sim.run(threshold_listener(aud))
    res = sim.finalize()
    by = {(t["ear"], t["frequency_hz"]): t for t in res["audiogram"]}
    for ear in ("right", "left"):
        assert by[(ear, 1500)]["is_interoctave"] is True
        assert by[(ear, 1500)]["threshold_db_hl"] == 25
        assert (ear, 750) not in by
        assert by[(ear, 2000)]["is_interoctave"] is False


def test_per_frequency_caps_are_enforced_server_side(client: TestClient) -> None:
    aud = flat_all(20)
    for ear in ("right", "left"):
        aud[ear][8000] = 85
    sim = SimClient.start(client, frequency_caps_db_hl={"8000": 84, "250": 70.0})
    sim.run(threshold_listener(aud))
    assert max(b["level_db_hl"] for b in sim.posted if b["frequency_hz"] == 8000) == 80
    res = sim.finalize()
    assert res["session"]["frequency_caps_db_hl"] == {"250": 70.0, "8000": 84.0}
    nr = [t for t in res["audiogram"] if t["frequency_hz"] == 8000]
    assert all(t["status"] == "no_response" and t["threshold_db_hl"] == 80 for t in nr)


@pytest.mark.parametrize(
    "caps",
    [{"1234": 80}, {"8000": -12}, {"8000": "84"}, {"8000": None}, {"loud": 80}],
)
def test_frequency_caps_validation(client: TestClient, caps: dict[str, Any]) -> None:
    assert client.post(f"{API}/sessions", json=session_body(frequency_caps_db_hl=caps)).status_code == 422


# ------------------------------------------------------------------ Prompt 6: environment and interruptions


RELATIVE_ENV = {
    "level_reference": "relative",
    "pretest_third_octave": {"250": -92.1, "1000": -97.4},
    "uncertainty_db": 8.0,
    "pretest_fluctuation_db": 3.2,
    "microphone_processing_off": True,
}


def test_environment_is_stored_and_relative_mode_cannot_claim_dba(client: TestClient) -> None:
    sim = SimClient.start(client, environment=RELATIVE_ENV)
    stored = client.get(f"{API}/sessions/{sim.session_id}").json()["session"]["environment"]
    assert stored["level_reference"] == "relative" and stored["uncertainty_db"] == 8.0
    bad = session_body(environment={**RELATIVE_ENV, "pretest_dba": 31.0})
    assert client.post(f"{API}/sessions", json=bad).status_code == 422
    ok = session_body(environment={**RELATIVE_ENV, "level_reference": "db_spl", "pretest_dba": 31.0})
    assert client.post(f"{API}/sessions", json=ok).status_code == 201


def test_noise_and_visibility_interruptions_are_counted(client: TestClient) -> None:
    sim = SimClient.start(client)
    listener = threshold_listener(flat_all(20))
    noise_at, hidden_at = {3, 9, 15}, {6}
    i = 0
    while sim.next_presentation is not None:
        p = sim.next_presentation
        if i in noise_at or i in hidden_at:
            reason = "ambient_noise" if i in noise_at else "visibility_hidden"
            assert sim.post(sim.trial_body(p, responded=False, discard_reason=reason)).status_code == 200
            i += 1
        assert sim.post(sim.trial_body(p, responded=listener(p))).status_code == 200
        i += 1
    q = sim.finalize()["quality_metrics"]
    assert (q["ambient_noise_discards"], q["visibility_discards"]) == (3, 1)
    assert q["ambient_exceedance_rate"] == pytest.approx(3 / len(sim.posted))
    assert q["ambient_exceedance_rate"] < 0.15


def test_noise_on_more_than_15_percent_of_trials_is_indeterminate(client: TestClient) -> None:
    """Spec §9.2 Step 4: ambient noise limit exceeded on > 15 % of trials → Indeterminate."""
    sim = SimClient.start(client)
    listener = threshold_listener(flat_all(20))
    i = 0
    while sim.next_presentation is not None:
        p = sim.next_presentation
        if i % 4 == 0:  # every 4th presentation is interrupted by noise (~20 %)
            assert sim.post(sim.trial_body(p, responded=False, discard_reason="ambient_noise")).status_code == 200
            i += 1
        assert sim.post(sim.trial_body(p, responded=listener(p))).status_code == 200
        i += 1
    res = sim.finalize()
    assert res["quality_metrics"]["ambient_exceedance_rate"] > 0.15
    c = res["classification"]
    assert c["band"] == "indeterminate" and c["p_hearing_loss"] is None
    assert "ambient noise over limit" in " ".join(o["reason"] for o in c["overrides_applied"])
    assert audiogram_of(res)["right"][1000] == 20  # thresholds themselves are unaffected
