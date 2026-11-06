"""Trip planning: routes -> timed checkpoints -> weather -> risk -> recommendation."""

from __future__ import annotations

import bisect
import math
from dataclasses import dataclass

from django.conf import settings
from django.core.cache import cache

from ..domain import eta, geo, ranking
from ..domain.geo import METERS_PER_MILE, LatLon
from ..domain.risk import RiskLevel, assess
from . import weather
from .routing import ProviderRoute, route_options

ROUTE_IDS = "ABC"
TRACK_STEP_M = 3 * METERS_PER_MILE
CORRIDOR_STEP_M = 10_000
SIMPLIFY_TOLERANCE_M = 25


@dataclass(frozen=True)
class TripRequest:
    origin: LatLon
    destination: LatLon
    departure_ts: float
    load_lbs: float
    interval_mi: int
    hos: bool = True


# ----------------------------------------------------------------- geometry
def simplify(coords: list[LatLon], tolerance_m: float) -> list[int]:
    """Douglas-Peucker; returns indices of kept vertices (iterative, no recursion)."""
    n = len(coords)
    if n < 3:
        return list(range(n))
    lat0 = math.radians(sum(c[0] for c in coords) / n)
    kx, ky = 111_320 * math.cos(lat0), 110_540
    xy = [(c[1] * kx, c[0] * ky) for c in coords]
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = xy[a], xy[b]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy) or 1e-9
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            x0, y0 = xy[i]
            d = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / norm
            if d > best:
                best, idx = d, i
        if best > tolerance_m:
            keep[idx] = True
            stack.extend(((a, idx), (idx, b)))
    return [i for i, k in enumerate(keep) if k]


def _interp(xs: list[float], ys: list[float], x: float) -> float:
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    j = bisect.bisect_right(xs, x)
    i = j - 1
    span = xs[j] - xs[i]
    return ys[i] if span == 0 else ys[i] + (ys[j] - ys[i]) * (x - xs[i]) / span


# ----------------------------------------------------------------- timing
@dataclass
class TimedRoute:
    route: ProviderRoute
    cum_m: list[float]
    cum_drive_s: list[float]
    stops: list[eta.Stop]
    departure_ts: float

    @property
    def total_m(self) -> float:
        return self.cum_m[-1]

    @property
    def drive_s(self) -> float:
        return self.cum_drive_s[-1]

    @property
    def travel_s(self) -> float:
        return eta.elapsed_clock_s(self.drive_s, self.stops) if self.stops else self.drive_s

    def eta_at(self, distance_m: float) -> tuple[float, float]:
        drive = _interp(self.cum_m, self.cum_drive_s, distance_m)
        return drive, self.departure_ts + eta.elapsed_clock_s(drive, self.stops)

    def distance_at_drive(self, drive_s: float) -> float:
        return _interp(self.cum_drive_s, self.cum_m, drive_s)


def time_route(route: ProviderRoute, req: TripRequest) -> TimedRoute:
    durs = eta.truck_segment_durations(
        route.seg_distances_m, route.seg_durations_s, settings.TRUCK_ROUTING["TRUCK_MAX_MPH"]
    )
    cum_m, cum_s = [0.0], [0.0]
    for d, t in zip(route.seg_distances_m, durs):
        cum_m.append(cum_m[-1] + d)
        cum_s.append(cum_s[-1] + t)
    stops = eta.hos_stops(cum_s[-1]) if req.hos else []
    return TimedRoute(route, cum_m, cum_s, stops, req.departure_ts)


def checkpoint_distances(total_m: float, interval_mi: int) -> list[float]:
    step = interval_mi * METERS_PER_MILE
    dists = [k * step for k in range(int(total_m // step) + 1)]
    if total_m - dists[-1] > 0.05 * step or len(dists) == 1:
        dists.append(total_m)
    else:
        dists[-1] = total_m  # merge a tiny final stub into the destination
    return dists


def _raw_checkpoints(timed: list[TimedRoute], interval_mi: int) -> list[list[dict]]:
    """Checkpoints with the truck's arrival time at each one."""
    out = []
    for tr in timed:
        cps = []
        for d in checkpoint_distances(tr.total_m, interval_mi):
            lat, lon = geo.point_at(tr.route.coords, tr.cum_m, d)
            drive, ts = tr.eta_at(d)
            cps.append({"distance_m": d, "lat": lat, "lon": lon, "drive_s": drive, "eta_ts": ts})
        out.append(cps)
    return out


ROUTES_TTL_S = 600


def cached_route_options(origin: LatLon, dest: LatLon, load_lbs: float):
    """Routes change slowly, so the quick /routes preview and the full plan share one routing call."""
    key = f"routes:{origin[0]:.4f},{origin[1]:.4f}:{dest[0]:.4f},{dest[1]:.4f}:{int(load_lbs // 5000)}"
    hit = cache.get(key)
    if hit is None:
        hit = route_options(origin, dest, load_lbs)
        cache.set(key, hit, ROUTES_TTL_S)
    return hit


def preview_routes(req: TripRequest) -> dict:
    """Just the lines on the map, fast: shown while the weather is still being fetched."""
    routes, warnings = cached_route_options(req.origin, req.destination, req.load_lbs)
    out = []
    for rid, r in zip(ROUTE_IDS, routes):
        keep = simplify(r.coords, SIMPLIFY_TOLERANCE_M * 4)
        out.append({"id": rid, "via": r.name, "distance_mi": round(sum(r.seg_distances_m) / METERS_PER_MILE, 1),
                    "geometry": [[round(r.coords[i][1], 4), round(r.coords[i][0], 4)] for i in keep]})
    return {"routes": out, "warnings": warnings}


# ----------------------------------------------------------------- planning
def plan_trip(req: TripRequest) -> dict:
    routes, warnings = cached_route_options(req.origin, req.destination, req.load_lbs)
    timed = [time_route(r, req) for r in routes]

    # 1) checkpoints with arrival times
    raw_checkpoints = _raw_checkpoints(timed, req.interval_mi)

    # 2) one batched forecast request for every checkpoint of every route
    all_points = [(c["lat"], c["lon"]) for cps in raw_checkpoints for c in cps]
    forecasts = weather.fetch_hourly(all_points)

    # 3) risk per checkpoint, summaries, ranking
    built, candidates = [], []
    for rid, tr, cps in zip(ROUTE_IDS, timed, raw_checkpoints):
        route_json, summary = _build_route(rid, tr, cps, forecasts, req)
        built.append(route_json)
        candidates.append(ranking.Candidate(rid, summary, tr.travel_s))

    rec = ranking.recommend(candidates)
    for r in built:
        r["rank"] = rec.order.index(r["id"]) + 1
        r["recommended"] = r["id"] == rec.route_id

    corridor = [
        [round(p[0], 4), round(p[1], 4)]
        for tr in timed for p in geo.resample(tr.route.coords, CORRIDOR_STEP_M)
    ]
    return {
        "departure_ts": req.departure_ts,
        "load_lbs": req.load_lbs,
        "interval_mi": req.interval_mi,
        "hos": req.hos,
        "routes": built,
        "weather_source": "met.no" if any(s.source == "met.no" for s in forecasts.values()) else "open-meteo",
        "departures": scan_departures(req, timed, raw_checkpoints, forecasts),
        "recommendation": {
            "route_id": rec.route_id,
            "order": rec.order,
            "decided_by": rec.decided_by,
            "reason": rec.reason,
            "safe_to_travel": rec.safe_to_travel,
        },
        "corridor": corridor,
        "warnings": warnings + (
            ["Open-Meteo was busy, so this forecast comes from MET Norway. Snow is estimated from temperature."]
            if any(f.source == "met.no" for f in forecasts.values()) else []),
        "routing_source": routes[0].source,
    }


def _build_route(rid, tr: TimedRoute, cps, forecasts, req) -> tuple[dict, ranking.RiskSummary]:
    route = tr.route
    keep = simplify(route.coords, SIMPLIFY_TOLERANCE_M)
    kept_cum = [tr.cum_m[i] for i in keep]
    # distance along the simplified line, so the map's line-progress matches exactly
    simple_cum = geo.cumulative_distances([route.coords[i] for i in keep])
    simple_total = simple_cum[-1] or 1.0

    checkpoints, miles, levels = [], [], []
    for i, c in enumerate(cps):
        sample = forecasts[weather.grid_key((c["lat"], c["lon"]))].sample(c["eta_ts"])
        risk = assess(sample, req.load_lbs)
        mile = c["distance_m"] / METERS_PER_MILE
        miles.append(mile)
        levels.append(risk.level)
        checkpoints.append({
            "index": i,
            "mile": round(mile, 1),
            "lat": round(c["lat"], 5),
            "lon": round(c["lon"], 5),
            "progress": round(_interp(kept_cum, simple_cum, c["distance_m"]) / simple_total, 5),
            "eta_ts": round(c["eta_ts"]),
            "drive_s": round(c["drive_s"]),
            "weather": {
                "wind_mph": round(sample.wind_mph, 1),
                "gust_mph": round(sample.gust_mph, 1),
                "rain_in_hr": round(sample.rain_in_hr, 3),
                "snow_in_hr": round(sample.snow_in_hr, 2),
                "temp_f": None if sample.temperature_f is None else round(sample.temperature_f),
            },
            "risk": {
                "level": int(risk.level),
                "key": risk.level.key,
                "label": risk.level.label,
                "factors": {"wind": int(risk.wind), "rain": int(risk.rain),
                            "snow": int(risk.snow), "load": int(risk.load)},
                "reasons": list(risk.reasons),
            },
        })

    summary = ranking.summarize(miles, levels, tr.total_m / METERS_PER_MILE)

    stops = []
    elapsed_before = 0.0
    for s in tr.stops:
        d = tr.distance_at_drive(s.drive_s)
        lat, lon = geo.point_at(route.coords, tr.cum_m, d)
        start = req.departure_ts + s.drive_s + elapsed_before
        elapsed_before += s.duration_s
        stops.append({"kind": s.kind, "mile": round(d / METERS_PER_MILE, 1),
                      "lat": round(lat, 5), "lon": round(lon, 5),
                      "start_ts": round(start), "end_ts": round(start + s.duration_s)})

    return {
        "id": rid,
        "name": f"Route {rid}",
        "via": route.name,
        "source": route.source,
        "distance_mi": round(tr.total_m / METERS_PER_MILE, 1),
        "drive_time_s": round(tr.drive_s),
        "travel_time_s": round(tr.travel_s),
        "arrival_ts": round(req.departure_ts + tr.travel_s),
        "geometry": [[round(route.coords[i][1], 5), round(route.coords[i][0], 5)] for i in keep],
        "checkpoints": checkpoints,
        "stops": stops,
        "track": _track(tr),
        "summary": {
            "miles_by_level": {lvl.key: round(summary.miles(lvl), 1) for lvl in RiskLevel},
            "avg_risk": round(summary.avg_risk, 3),
            "max_level": int(summary.max_level),
            "max_level_key": summary.max_level.key,
        },
    }, summary


def _track(tr: TimedRoute) -> list[list[float]]:
    """[lat, lon, seconds-after-departure] samples; stops appear twice (arrive/leave)."""
    out: list[list[float]] = []
    marks = [k * TRACK_STEP_M for k in range(int(tr.total_m // TRACK_STEP_M) + 1)] + [tr.total_m]
    stop_marks = {tr.distance_at_drive(s.drive_s): s for s in tr.stops}
    for d in sorted(set(marks) | set(stop_marks)):
        lat, lon = geo.point_at(tr.route.coords, tr.cum_m, d)
        drive = _interp(tr.cum_m, tr.cum_drive_s, d)
        t = eta.elapsed_clock_s(drive, tr.stops)
        out.append([round(lat, 4), round(lon, 4), round(t)])
        if d in stop_marks:
            out.append([round(lat, 4), round(lon, 4), round(t + stop_marks[d].duration_s)])
    return out


# ----------------------------------------------------------------- departures
SCAN_STEP_H = 3
SCAN_SPAN_H = 36


def scan_departures(req: TripRequest, timed: list[TimedRoute], base: list[list[dict]], forecasts) -> dict:
    """How the best route's weather changes if the truck leaves later.

    No extra forecast calls: each candidate departure only shifts every checkpoint's
    arrival time and re-reads the forecasts the plan already fetched.
    """
    offsets = list(range(0, SCAN_SPAN_H + 1, SCAN_STEP_H))

    options = []
    for h in offsets:
        shift = h * 3600
        candidates = []
        for rid, tr, cps in zip(ROUTE_IDS, timed, base):
            miles = [c["distance_m"] / METERS_PER_MILE for c in cps]
            levels = [
                assess(forecasts[weather.grid_key((c["lat"], c["lon"]))].sample(c["eta_ts"] + shift), req.load_lbs).level
                for c in cps
            ]
            summary = ranking.summarize(miles, levels, tr.total_m / METERS_PER_MILE)
            candidates.append(ranking.Candidate(rid, summary, tr.travel_s))
        rec = ranking.recommend(candidates)
        best = next(c for c in candidates if c.route_id == rec.route_id)
        s = best.summary
        options.append({
            "offset_h": h,
            "depart_ts": round(req.departure_ts + shift),
            "route_id": rec.route_id,
            "no_travel_mi": round(s.miles(RiskLevel.NO_TRAVEL), 1),
            "severe_mi": round(s.miles(RiskLevel.SEVERE), 1),
            "high_mi": round(s.miles(RiskLevel.HIGH), 1),
            "avg_risk": round(s.avg_risk, 3),
            "max_level": int(s.max_level),
            "arrival_ts": round(req.departure_ts + shift + best.travel_time_s),
        })

    def badness(o):  # same order as the recommendation rule, earliest departure wins ties
        return (round(o["no_travel_mi"], 1), round(o["severe_mi"], 1), round(o["high_mi"], 1), round(o["avg_risk"], 2), o["offset_h"])

    best_option = min(options, key=badness)
    return {"options": options, "best_offset_h": best_option["offset_h"], "step_h": SCAN_STEP_H}
