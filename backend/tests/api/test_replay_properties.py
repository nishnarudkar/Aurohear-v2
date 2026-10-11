"""Property: thresholds computed by the API from the stored trial log are identical to
running the engine directly — for any audiogram, ear order, and any interleaving of
catch and discarded trials. This is the guarantee that event-sourced replay is exact."""

from __future__ import annotations

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from aurohear.api.app import create_app
from aurohear.audiometry import AudiometryProtocol, Ear
from aurohear.audiometry.simulation import DeterministicListener, drive
from client_sim import SimClient, audiogram_of, threshold_listener
from conftest import migrated_engine
from fastapi.testclient import TestClient

FREQS = (250, 500, 1000, 2000, 3000, 4000, 6000, 8000)
grid = st.sampled_from(range(-10, 101, 5))
audiograms = st.fixed_dictionaries(
    {ear: st.fixed_dictionaries({f: grid for f in FREQS}) for ear in ("right", "left")}
)


@settings(max_examples=15, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(
    audiogram=audiograms,
    better=st.sampled_from([None, "right", "left"]),
    catch_mask=st.lists(st.booleans(), min_size=1, max_size=40),
    discard_mask=st.lists(st.booleans(), min_size=1, max_size=40),
    catch_fa=st.lists(st.booleans(), min_size=1, max_size=40),
)
def test_api_thresholds_equal_direct_engine(
    audiogram: dict[str, dict[int, int]],
    better: str | None,
    catch_mask: list[bool],
    discard_mask: list[bool],
    catch_fa: list[bool],
) -> None:
    engine = migrated_engine()
    try:
        with TestClient(create_app(engine)) as client:
            overrides = {"better_ear": better} if better else {}
            sim = SimClient.start(client, **overrides)
            sim.run(
                threshold_listener(audiogram),
                insert_catch=lambda i: catch_mask[i % len(catch_mask)],
                catch_response=lambda i: catch_fa[i % len(catch_fa)],
                insert_discard=lambda i: discard_mask[i % len(discard_mask)] and i % 3 == 0,
            )
            api_audiogram = audiogram_of(sim.finalize())
    finally:
        engine.dispose()

    direct = AudiometryProtocol(better_ear=Ear(better) if better else None)
    drive(direct, DeterministicListener({Ear(e): {f: float(v) for f, v in fs.items()} for e, fs in audiogram.items()}))
    expected = {
        ear_res.ear.value: {f: r.threshold_db_hl for f, r in ear_res.audiogram.items()}
        for ear_res in direct.result().ears
    }
    assert api_audiogram == expected
