"""Small, dependency-free geometry helpers. Coordinates are (lat, lon) tuples."""

from __future__ import annotations

import bisect
import math
from collections.abc import Iterable, Sequence

EARTH_RADIUS_M = 6_371_008.8
METERS_PER_MILE = 1609.344

LatLon = tuple[float, float]


def haversine_m(a: LatLon, b: LatLon) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def cumulative_distances(coords: Sequence[LatLon]) -> list[float]:
    """Distance (m) from the start of the line to every vertex."""
    out = [0.0]
    for prev, cur in zip(coords, coords[1:]):
        out.append(out[-1] + haversine_m(prev, cur))
    return out


def interpolate(a: LatLon, b: LatLon, t: float) -> LatLon:
    # Linear interpolation is accurate enough between dense route vertices.
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def locate(cum: Sequence[float], distance: float) -> tuple[int, float]:
    """Index of the segment containing `distance` and the fraction along it."""
    distance = min(max(distance, 0.0), cum[-1])
    i = bisect.bisect_right(cum, distance) - 1
    i = min(max(i, 0), len(cum) - 2)
    seg = cum[i + 1] - cum[i]
    return i, (distance - cum[i]) / seg if seg > 0 else 0.0


def point_at(coords: Sequence[LatLon], cum: Sequence[float], distance: float) -> LatLon:
    i, t = locate(cum, distance)
    return interpolate(coords[i], coords[i + 1], t)


def destination_point(origin: LatLon, bearing_deg: float, distance_m: float) -> LatLon:
    lat1, lon1 = map(math.radians, origin)
    brg = math.radians(bearing_deg)
    d = distance_m / EARTH_RADIUS_M
    lat2 = math.asin(math.sin(lat1) * math.cos(d) + math.cos(lat1) * math.sin(d) * math.cos(brg))
    lon2 = lon1 + math.atan2(
        math.sin(brg) * math.sin(d) * math.cos(lat1), math.cos(d) - math.sin(lat1) * math.sin(lat2)
    )
    return math.degrees(lat2), (math.degrees(lon2) + 540) % 360 - 180


def bearing_deg(a: LatLon, b: LatLon) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    y = math.sin(lon2 - lon1) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def resample(coords: Sequence[LatLon], step_m: float) -> list[LatLon]:
    """Points every `step_m` along the line (always including both ends)."""
    cum = cumulative_distances(coords)
    total = cum[-1]
    if total == 0:
        return [coords[0]]
    n = max(1, math.ceil(total / step_m))
    return [point_at(coords, cum, total * k / n) for k in range(n + 1)]


def bbox(points: Iterable[LatLon]) -> tuple[float, float, float, float]:
    lats, lons = zip(*points)
    return min(lats), min(lons), max(lats), max(lons)


# --- Web-Mercator helpers (the heatmap grid is regular in Mercator space so the
# --- raster lines up exactly with the map when drawn as an image overlay).
def lat_to_merc_y(lat: float) -> float:
    lat = max(min(lat, 85.0), -85.0)
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def merc_y_to_lat(y: float) -> float:
    return math.degrees(2 * math.atan(math.exp(y)) - math.pi / 2)


class SpatialIndex:
    """Uniform-grid index answering "is any indexed point within r metres?"."""

    def __init__(self, points: Iterable[LatLon], cell_deg: float = 0.25):
        self.cell = cell_deg
        self.cells: dict[tuple[int, int], list[LatLon]] = {}
        for p in points:
            self.cells.setdefault(self._key(p), []).append(p)

    def _key(self, p: LatLon) -> tuple[int, int]:
        return int(math.floor(p[0] / self.cell)), int(math.floor(p[1] / self.cell))

    def nearest_m(self, p: LatLon, max_m: float) -> float:
        """Distance to the nearest indexed point, or inf if none within max_m."""
        lat_cells = math.ceil(max_m / 111_000 / self.cell) + 1
        cos_lat = max(math.cos(math.radians(p[0])), 0.05)
        lon_cells = math.ceil(max_m / (111_000 * cos_lat) / self.cell) + 1
        ki, kj = self._key(p)
        best = math.inf
        for di in range(-lat_cells, lat_cells + 1):
            for dj in range(-lon_cells, lon_cells + 1):
                for q in self.cells.get((ki + di, kj + dj), ()):
                    d = haversine_m(p, q)
                    if d < best:
                        best = d
        return best if best <= max_m else math.inf
