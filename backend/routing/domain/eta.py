"""Truck timing: turns a provider route into "when will the truck be where".

Two adjustments are made on top of the routing engine's travel times:

1. Truck speed cap - car routing graphs assume car speeds. Class-8 trucks are
   usually governed around 62-68 mph, so every segment is slowed to at most
   TRUCK_MAX_MPH (default 65). With a real HGV profile (OpenRouteService) this
   is a no-op safety net.
2. Hours-of-Service (optional, simplified FMCSA property-carrying rules):
   a 30-minute break after 8 hours of driving and a 10-hour rest after 11
   hours of driving. A truck parked for 10 hours meets the weather 10 hours
   later, so this materially changes which forecast hour each checkpoint gets.
"""

from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Sequence

MPH_TO_MPS = 0.44704

BREAK_AFTER_DRIVE_S = 8 * 3600
BREAK_DURATION_S = 30 * 60
SHIFT_DRIVE_LIMIT_S = 11 * 3600
REST_DURATION_S = 10 * 3600


def truck_segment_durations(
    seg_distances_m: Sequence[float], seg_durations_s: Sequence[float], max_mph: float
) -> list[float]:
    cap_mps = max_mph * MPH_TO_MPS
    return [max(dur, dist / cap_mps) for dist, dur in zip(seg_distances_m, seg_durations_s)]


@dataclass(frozen=True)
class Stop:
    drive_s: float  # cumulative driving time at which the stop starts
    duration_s: float
    kind: str  # "break" | "rest"


def hos_stops(total_drive_s: float) -> list[Stop]:
    """Mandatory stops for a trip of `total_drive_s` seconds of driving."""
    stops: list[Stop] = []
    shift_start = 0.0
    while True:
        brk = shift_start + BREAK_AFTER_DRIVE_S
        rest = shift_start + SHIFT_DRIVE_LIMIT_S
        if brk < total_drive_s:
            stops.append(Stop(brk, BREAK_DURATION_S, "break"))
        if rest < total_drive_s:
            stops.append(Stop(rest, REST_DURATION_S, "rest"))
            shift_start = rest
            continue
        return stops


def elapsed_clock_s(drive_s: float, stops: Sequence[Stop]) -> float:
    """Wall-clock seconds since departure when `drive_s` of driving is done."""
    return drive_s + sum(s.duration_s for s in stops if s.drive_s < drive_s)
