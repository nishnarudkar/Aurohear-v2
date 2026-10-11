"""Hypothesis profiles.

* ``dev`` (default)  — 200 examples, random seed each run (finds new edge cases).
* ``ci``             — derandomised and larger, so CI is reproducible and never flaky.

Select with ``HYPOTHESIS_PROFILE=ci pytest``.
"""

import os

from hypothesis import HealthCheck, settings

settings.register_profile("dev", max_examples=200, deadline=None)
settings.register_profile(
    "ci",
    max_examples=1000,
    deadline=None,
    derandomize=True,
    suppress_health_check=[HealthCheck.too_slow],
)
settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "dev"))
