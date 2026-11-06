"""Route options from a routing API (OpenRouteService HGV or OSRM).

Routing engines often return fewer than three genuinely different routes
(OSRM's alternatives depend on the road graph; ORS only offers alternatives on
short trips). To always offer the driver three options we top the list up by
routing through "via" points placed to either side of the fastest route, then
reject candidates that are near-duplicates, unreasonable detours or contain an
out-and-back spur created by a via point that snapped onto a side road.
"""

from __future__ import annotations

import logging
import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from django.conf import settings

from ..domain import geo
from ..domain.geo import LatLon
from .http import ProviderError, request_json

log = logging.getLogger(__name__)

MAX_DETOUR_RATIO = 1.6   # alternatives may take at most 60% longer than the fastest
DUPLICATE_OVERLAP = 0.85  # share of a candidate lying on an existing route
MAX_ROUTES = 3


@dataclass
class ProviderRoute:
    coords: list[LatLon]
    seg_distances_m: list[float]
    seg_durations_s: list[float]
    distance_m: float
    duration_s: float
    name: str = ""
    source: str = ""
    samples: list[LatLon] = field(default_factory=list, repr=False)

    def __post_init__(self):
        if not self.samples:
            self.samples = geo.resample(self.coords, 1500)


def _segment_durations(coords, durations, total_duration) -> tuple[list[float], list[float]]:
    """Per-segment distance/duration; fall back to distance-proportional timing."""
    dists = [geo.haversine_m(a, b) for a, b in zip(coords, coords[1:])]
    if durations is not None and len(durations) == len(dists):
        return dists, list(durations)
    total = sum(dists) or 1.0
    return dists, [total_duration * d / total for d in dists]


# --------------------------------------------------------------------- OSRM
def _osrm(points: list[LatLon], alternatives: bool) -> list[ProviderRoute]:
    cfg = settings.TRUCK_ROUTING
    path = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in points)
    params = {
        "overview": "full",
        "geometries": "geojson",
        "annotations": "duration",
        "steps": "false",
        "alternatives": "3" if alternatives else "false",
    }
    data, last_exc = None, None
    for base in (cfg["OSRM_BASE_URL"], cfg["OSRM_FALLBACK_URL"]):
        try:
            data = request_json("OSRM", "GET", f"{base}/route/v1/driving/{path}",
                                params=params, cache_seconds=3600)
            break
        except ProviderError as exc:
            last_exc = exc
    if data is None:
        raise last_exc  # type: ignore[misc]
    if data.get("code") != "Ok":
        if data.get("code") in ("NoRoute", "NoSegment"):
            return []
        raise ProviderError("OSRM", data.get("message", data.get("code", "error")))

    routes = []
    for r in data.get("routes", []):
        coords = [(lat, lon) for lon, lat in r["geometry"]["coordinates"]]
        if len(coords) < 2:
            continue
        legs = r.get("legs", [])
        durations: list[float] = []
        for leg in legs:
            durations.extend(leg.get("annotation", {}).get("duration", []))
        dists, durs = _segment_durations(coords, durations or None, r["duration"])
        name = ", ".join(s for s in (leg.get("summary", "") for leg in legs) if s)
        routes.append(ProviderRoute(coords, dists, durs, r["distance"], r["duration"],
                                    name, "osrm"))
    return routes


# ---------------------------------------------------------- OpenRouteService
def _ors(points: list[LatLon], alternatives: bool, gross_lbs: float) -> list[ProviderRoute]:
    cfg = settings.TRUCK_ROUTING
    body: dict = {
        "coordinates": [[lon, lat] for lat, lon in points],
        "instructions": True,
        "units": "m",
        "options": {
            "vehicle_type": "hgv",
            "profile_params": {"restrictions": {"weight": round(gross_lbs * 0.000453592, 1)}},
        },
    }
    if alternatives:
        body["alternative_routes"] = {"target_count": 3, "weight_factor": 1.6, "share_factor": 0.6}
    url = "https://api.openrouteservice.org/v2/directions/driving-hgv/geojson"
    headers = {"Authorization": cfg["ORS_API_KEY"]}
    try:
        data = request_json("OpenRouteService", "POST", url, json_body=body,
                            headers=headers, cache_seconds=3600, retries=1)
    except ProviderError:
        if not alternatives:
            raise
        # ORS rejects alternatives on long trips - retry as a single route.
        return _ors(points, False, gross_lbs)

    routes = []
    for f in data.get("features", []):
        coords = [(c[1], c[0]) for c in f["geometry"]["coordinates"]]
        props = f["properties"]
        seg_durs = [0.0] * (len(coords) - 1)
        dists = [geo.haversine_m(a, b) for a, b in zip(coords, coords[1:])]
        for seg in props.get("segments", []):
            for step in seg.get("steps", []):
                i0, i1 = step["way_points"]
                span = sum(dists[i0:i1]) or 1.0
                for i in range(i0, i1):
                    seg_durs[i] = step.get("duration", 0.0) * dists[i] / span
        summary = props.get("summary", {})
        routes.append(ProviderRoute(coords, dists, seg_durs, summary.get("distance", sum(dists)),
                                    summary.get("duration", sum(seg_durs)), "", "ors-hgv"))
    return routes


def _fetch(points: list[LatLon], alternatives: bool, gross_lbs: float) -> list[ProviderRoute]:
    if settings.TRUCK_ROUTING["ORS_API_KEY"]:
        try:
            return _ors(points, alternatives, gross_lbs)
        except ProviderError as exc:
            log.warning("ORS failed, falling back to OSRM: %s", exc)
    return _osrm(points, alternatives)


# ------------------------------------------------------- quality filters
def _overlap(candidate: ProviderRoute, existing: geo.SpatialIndex) -> float:
    hits = sum(1 for p in candidate.samples if existing.nearest_m(p, 1500) < math.inf)
    return hits / len(candidate.samples)


def _has_spur(route: ProviderRoute) -> bool:
    """True when the route doubles back over itself (out-and-back to a via point)."""
    pts = route.samples
    cell = 0.01
    grid: dict[tuple[int, int], list[int]] = {}
    for i, p in enumerate(pts):
        grid.setdefault((int(p[0] / cell), int(p[1] / cell)), []).append(i)
    revisits = 0
    for i, p in enumerate(pts):
        ki, kj = int(p[0] / cell), int(p[1] / cell)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                if any(abs(j - i) > 6 and geo.haversine_m(p, pts[j]) < 800
                       for j in grid.get((ki + di, kj + dj), ())):
                    revisits += 1
                    break
            else:
                continue
            break
    return revisits / len(pts) > 0.03


def _via_points(primary: ProviderRoute, origin: LatLon, dest: LatLon) -> list[LatLon]:
    straight = geo.haversine_m(origin, dest)
    brg = geo.bearing_deg(origin, dest)
    cum = geo.cumulative_distances(primary.coords)
    base = min(max(straight * 0.12, 8_000), 90_000)
    vias = []
    for frac, mult in ((0.5, 1), (0.5, -1), (0.5, 2), (0.5, -2), (0.33, 1.5), (0.67, -1.5),
                       (0.67, 1.5), (0.33, -1.5)):
        anchor = geo.point_at(primary.coords, cum, cum[-1] * frac)
        side = 90 if mult > 0 else -90
        vias.append(geo.destination_point(anchor, brg + side, base * abs(mult)))
    return vias


def route_options(origin: LatLon, dest: LatLon, load_lbs: float) -> tuple[list[ProviderRoute], list[str]]:
    """Up to three distinct routes, fastest first, plus any warnings."""
    gross = load_lbs + settings.TRUCK_ROUTING["TRUCK_TARE_LBS"]
    warnings: list[str] = []
    found = _fetch([origin, dest], True, gross)
    if not found:
        raise ProviderError("Routing", "no drivable route between these places", status=422)

    fastest = min(r.duration_s for r in found)
    accepted: list[ProviderRoute] = []

    def consider(route: ProviderRoute) -> None:
        if len(accepted) >= MAX_ROUTES:
            return
        if route.duration_s > fastest * MAX_DETOUR_RATIO:
            return
        if accepted:
            index = geo.SpatialIndex((p for r in accepted for p in r.samples), cell_deg=0.05)
            if _overlap(route, index) > DUPLICATE_OVERLAP:
                return
        if accepted and _has_spur(route):
            return
        accepted.append(route)

    for r in sorted(found, key=lambda r: r.duration_s):
        consider(r)

    if len(accepted) < MAX_ROUTES:
        vias = _via_points(accepted[0], origin, dest)
        with ThreadPoolExecutor(max_workers=4) as pool:
            batches = [vias[:4], vias[4:]]
            for batch in batches:
                if len(accepted) >= MAX_ROUTES:
                    break
                results = pool.map(lambda v: _safe_fetch([origin, v, dest], gross), batch)
                for routes in results:
                    for r in routes[:1]:
                        consider(r)

    if len(accepted) < MAX_ROUTES:
        warnings.append(
            f"Only {len(accepted)} distinct route(s) exist between these points "
            "without an unreasonable detour."
        )
    accepted.sort(key=lambda r: r.duration_s)
    return accepted, warnings


def _safe_fetch(points, gross) -> list[ProviderRoute]:
    try:
        return _fetch(points, False, gross)
    except ProviderError as exc:
        log.info("via-route failed: %s", exc)
        return []
