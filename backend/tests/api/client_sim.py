"""A scripted API client that plays the role of the browser runner.

It builds spec-valid trial bodies on a synthetic session clock and answers each
presentation with a synthetic listener, so whole sessions run through HTTP.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from fastapi.testclient import TestClient

API = "/api/v1"

Listener = Callable[[dict[str, Any]], bool]
"""Given a presentation dict, did the listener hear it?"""


def session_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "participant_id": str(uuid.uuid4()),
        "consent_version": "2026-03-01",
        "mode": "threshold",
        "supervision": "unsupervised",
        "client_time_origin_ms": 1_760_000_000_000.0,
        "device": {
            "user_agent": "pytest",
            "headphone_profile_id": "synthetic-test-profile",
            "transducer_type": "circumaural",
            "connection": "wired",
            "sample_rate": 48000,
        },
        "calibration": {
            "tier": "B",
            "method": "model_profile",
            "profile_version": "test-0",
            "calibrated_at": "2026-10-11T09:00:00Z",
        },
    }
    body.update(overrides)
    return body


def threshold_listener(audiogram: dict[str, dict[int, float]]) -> Listener:
    return lambda p: p["level_db_hl"] >= audiogram[p["ear"]][p["frequency_hz"]]


@dataclass
class SimClient:
    client: TestClient
    session_id: str
    next_presentation: dict[str, Any] | None
    seq: int = 0
    clock_ms: float = 10_000.0
    posted: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def start(cls, client: TestClient, **session_overrides: Any) -> SimClient:
        r = client.post(f"{API}/sessions", json=session_body(**session_overrides))
        assert r.status_code == 201, r.text
        data = r.json()
        return cls(client, data["session"]["id"], data["next_presentation"])

    def trial_body(
        self,
        presentation: dict[str, Any],
        *,
        responded: bool,
        catch: bool = False,
        discard_reason: str | None = None,
        latency_ms: float = 420.0,
    ) -> dict[str, Any]:
        scheduled = self.clock_ms
        onset = scheduled + 2000.0
        duration = 1200.0
        offset = onset + duration
        response_at = onset + latency_ms if responded else None
        self.clock_ms = offset + 2000.0
        return {
            "trial_id": str(uuid.uuid4()),
            "seq": self.seq,
            "ear": presentation["ear"],
            "frequency_hz": presentation["frequency_hz"],
            "level_db_hl": None if catch else presentation["level_db_hl"],
            "presented_level_db_hl": None if catch else float(presentation["level_db_hl"]),
            "level_clamped": False,
            "phase": "catch" if catch else presentation["phase"],
            "test_role": presentation["test_role"],
            "is_catch_trial": catch,
            "scheduled_at_ms": scheduled,
            "presented_at_ms": onset,
            "offset_at_ms": offset,
            "audio_context_onset_s": onset / 1000.0 + 0.25,
            "duration_ms": duration,
            "isi_ms": 2000.0,
            "responded": responded,
            "response_at_ms": response_at,
            "response_latency_ms": latency_ms if responded else None,
            "extra_responses": 0,
            "discarded": discard_reason is not None,
            "discard_reason": discard_reason,
        }

    def post(self, body: dict[str, Any]) -> Any:
        r = self.client.post(f"{API}/sessions/{self.session_id}/trials", json=body)
        if r.status_code == 200:
            data = r.json()
            self.seq += 1
            self.posted.append(body)
            self.next_presentation = data["next_presentation"]
        return r

    def run(
        self,
        listener: Listener,
        *,
        insert_catch: Callable[[int], bool] = lambda _i: False,
        catch_response: Callable[[int], bool] = lambda _i: False,
        insert_discard: Callable[[int], bool] = lambda _i: False,
        max_trials: int = 5000,
    ) -> int:
        """Answer presentations until the protocol completes. Returns trials posted."""
        i = 0
        while self.next_presentation is not None:
            assert i < max_trials, "protocol did not complete"
            p = self.next_presentation
            if p["phase"] != "familiarisation" and insert_catch(i):
                r = self.post(self.trial_body(p, responded=catch_response(i), catch=True))
                assert r.status_code == 200, r.text
                assert r.json()["advanced_protocol"] is False
                i += 1
            if insert_discard(i):
                r = self.post(self.trial_body(p, responded=False, discard_reason="visibility_hidden"))
                assert r.status_code == 200, r.text
                assert r.json()["next_presentation"] == p  # same tone re-presented
                i += 1
            r = self.post(self.trial_body(p, responded=listener(p)))
            assert r.status_code == 200, r.text
            assert r.json()["advanced_protocol"] is True
            i += 1
        return i

    def finalize(self) -> dict[str, Any]:
        r = self.client.post(f"{API}/sessions/{self.session_id}/finalize")
        assert r.status_code == 200, r.text
        return r.json()


def audiogram_of(results: dict[str, Any]) -> dict[str, dict[int, int | None]]:
    out: dict[str, dict[int, int | None]] = {"right": {}, "left": {}}
    for t in results["audiogram"]:
        out[t["ear"]][t["frequency_hz"]] = t["threshold_db_hl"]
    return out
