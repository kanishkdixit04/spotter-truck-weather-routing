"""Active National Weather Service alerts along a route (US only, no API key).

The route is checked at a handful of points; each point asks api.weather.gov for the
alerts in force there. The same alert seen from several points is merged into one entry
that remembers the first and last mile it touches.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from .http import ProviderError, request_json

URL = "https://api.weather.gov/alerts/active"
SEVERITY_RANK = {"Extreme": 0, "Severe": 1, "Moderate": 2, "Minor": 3}
# Alerts that matter to a truck on the road; skips things like heat advisories and air quality.
RELEVANT = ("wind", "winter", "ice", "snow", "blizzard", "freez", "flood", "fog", "tornado",
            "thunderstorm", "squall", "dust", "avalanche", "hurricane", "tropical", "storm", "hazardous")


def _is_relevant(event: str) -> bool:
    e = event.lower()
    return any(word in e for word in RELEVANT)


def _at(point: dict) -> list[dict]:
    data = request_json(
        "NWS", "GET", URL,
        params={"point": f"{point['lat']:.4f},{point['lon']:.4f}"},
        headers={"Accept": "application/geo+json"}, cache_seconds=600, retries=1,
    )
    out = []
    for feature in data.get("features", []):
        p = feature.get("properties", {})
        if p.get("event") and _is_relevant(p["event"]):
            out.append({"id": p.get("id") or feature.get("id"), "event": p["event"], "severity": p.get("severity") or "Minor",
                        "headline": p.get("headline") or p["event"], "ends": p.get("ends") or p.get("expires"),
                        "onset": p.get("onset") or p.get("effective")})
    return out


def alerts_along(points: list[dict]) -> dict:
    """`points` are {lat, lon, mile}. Returns merged alerts and how many points answered."""
    def safe(point):
        try:
            return _at(point)
        except ProviderError:
            return None

    with ThreadPoolExecutor(max_workers=min(6, max(1, len(points)))) as pool:
        results = list(pool.map(safe, points))

    merged: dict[str, dict] = {}
    for point, found in zip(points, results):
        for a in found or []:
            m = merged.setdefault(a["id"], {**a, "first_mile": point["mile"], "last_mile": point["mile"],
                                            "lat": point["lat"], "lon": point["lon"]})
            m["first_mile"] = min(m["first_mile"], point["mile"])
            m["last_mile"] = max(m["last_mile"], point["mile"])
    alerts = sorted(merged.values(), key=lambda a: (SEVERITY_RANK.get(a["severity"], 4), a["first_mile"]))
    answered = sum(r is not None for r in results)
    return {"alerts": alerts, "checked": len(points), "answered": answered}
