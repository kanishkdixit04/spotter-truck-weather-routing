"""Route summaries and the recommendation rule.

Miles per risk level: each checkpoint "owns" the stretch of road halfway back
to the previous checkpoint and halfway on to the next one, so the per-level
miles always add up to the route length.

Recommendation order (from the brief), applied lexicographically:
    0. Fewest No-Travel miles  (implicit: worse than Severe, so ranked first)
    1. Fewest Severe miles
    2. Fewest High miles
    3. Lowest average risk     (distance-weighted, Low=0 ... No Travel=4)
    4. Shortest travel time    (wall-clock, including mandatory stops)
Miles are compared at 0.1 mi resolution and average risk at 0.01 so that
floating-point noise never decides a recommendation.
"""

from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Sequence

from .risk import RiskLevel


@dataclass(frozen=True)
class RiskSummary:
    miles_by_level: dict[RiskLevel, float]
    avg_risk: float
    max_level: RiskLevel
    total_miles: float

    def miles(self, level: RiskLevel) -> float:
        return self.miles_by_level.get(level, 0.0)


def summarize(
    checkpoint_miles: Sequence[float], levels: Sequence[RiskLevel], total_miles: float
) -> RiskSummary:
    if not checkpoint_miles:
        raise ValueError("a route needs at least one checkpoint")
    by_level = {level: 0.0 for level in RiskLevel}
    n = len(checkpoint_miles)
    weighted = 0.0
    for i, (mile, level) in enumerate(zip(checkpoint_miles, levels)):
        start = 0.0 if i == 0 else (checkpoint_miles[i - 1] + mile) / 2
        end = total_miles if i == n - 1 else (mile + checkpoint_miles[i + 1]) / 2
        span = max(0.0, end - start)
        by_level[level] += span
        weighted += span * int(level)
    avg = weighted / total_miles if total_miles > 0 else float(max(levels))
    return RiskSummary(by_level, avg, max(levels), total_miles)


@dataclass(frozen=True)
class Candidate:
    route_id: str
    summary: RiskSummary
    travel_time_s: float


CRITERIA = (
    ("no_travel_miles", "No-Travel miles"),
    ("severe_miles", "Severe miles"),
    ("high_miles", "High-risk miles"),
    ("avg_risk", "average risk"),
    ("travel_time_s", "travel time"),
)


def sort_key(c: Candidate) -> tuple:
    s = c.summary
    return (
        round(s.miles(RiskLevel.NO_TRAVEL), 1),
        round(s.miles(RiskLevel.SEVERE), 1),
        round(s.miles(RiskLevel.HIGH), 1),
        round(s.avg_risk, 2),
        round(c.travel_time_s),
    )


@dataclass(frozen=True)
class Recommendation:
    order: list[str]
    route_id: str
    decided_by: str | None  # criterion key that separated #1 from #2
    reason: str
    safe_to_travel: bool


def _fmt(key: str, value: float) -> str:
    if key == "travel_time_s":
        h, m = divmod(round(value / 60), 60)
        return f"{h}h {m:02d}m"
    if key == "avg_risk":
        return f"{value:.2f}"
    return f"{value:,.0f} mi" if value >= 10 else f"{value:.1f} mi"


def recommend(candidates: Sequence[Candidate]) -> Recommendation:
    if not candidates:
        raise ValueError("no routes to rank")
    ranked = sorted(candidates, key=sort_key)
    best = ranked[0]
    safe = best.summary.miles(RiskLevel.NO_TRAVEL) == 0

    decided_by, reason = None, "Only one route was available."
    if len(ranked) > 1:
        runner = ranked[1]
        a, b = sort_key(best), sort_key(runner)
        for idx, (key, label) in enumerate(CRITERIA):
            if a[idx] != b[idx]:
                decided_by = key
                if idx == 0 and a[0] == 0:
                    reason = "It is the only route without No-Travel conditions."
                elif idx < 4 and a[:idx] == b[:idx] and all(v == 0 for v in a[:idx]):
                    reason = (
                        f"Fewest {label}: {_fmt(key, a[idx])} vs {_fmt(key, b[idx])} "
                        f"on the next-best route."
                    )
                elif idx < 4:
                    reason = (
                        f"Tied on the higher-priority checks, then fewest {label}: "
                        f"{_fmt(key, a[idx])} vs {_fmt(key, b[idx])}."
                    )
                else:
                    reason = (
                        "Weather risk is equal, so the fastest route wins: "
                        f"{_fmt(key, a[idx])} vs {_fmt(key, b[idx])}."
                    )
                break
        else:
            reason = "Routes are equivalent on every criterion."
    if not safe:
        reason = (
            "Every route crosses No-Travel conditions at this departure time. "
            "This is the least-bad option - consider delaying departure. " + reason
        )
    return Recommendation([c.route_id for c in ranked], best.route_id, decided_by, reason, safe)
