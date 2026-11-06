"""Place search (autocomplete) via Photon - OpenStreetMap data, no API key."""

from __future__ import annotations

from django.conf import settings

from .http import request_json

PLACE_KEYS = ("name", "city", "county", "state", "country")


def _label(props: dict) -> str:
    parts: list[str] = []
    if props.get("housenumber") and props.get("street"):
        parts.append(f"{props['housenumber']} {props['street']}")
    for key in PLACE_KEYS:
        value = props.get(key)
        if value and value not in parts:
            parts.append(value)
    return ", ".join(parts)


def search(query: str, limit: int = 6, bias: tuple[float, float] | None = None) -> list[dict]:
    params: dict = {"q": query, "limit": limit, "lang": "en"}
    if bias:
        params["lat"], params["lon"] = bias
    data = request_json("Photon", "GET", settings.TRUCK_ROUTING["PHOTON_URL"],
                        params=params, cache_seconds=24 * 3600, retries=1)
    results, seen = [], set()
    for feature in data.get("features", []):
        lon, lat = feature["geometry"]["coordinates"][:2]
        props = feature.get("properties", {})
        label = _label(props)
        if not label or label in seen:
            continue
        seen.add(label)
        results.append({
            "label": label,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "kind": props.get("osm_value") or props.get("type") or "place",
        })
    return results
