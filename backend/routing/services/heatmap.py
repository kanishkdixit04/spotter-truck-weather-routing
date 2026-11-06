"""Weather heatmap along the trip corridor, hourly for 0-48 h after departure.

The grid is regular in longitude and in Web-Mercator Y. That lets the browser
paint one pixel per grid cell into a tiny canvas and drop it on the map as an
image overlay: the GPU's bilinear filtering produces a smooth field, and the
overlay lines up exactly with the basemap. Only cells within the corridor
buffer are requested from the forecast API; the rest are transparent.
"""

from __future__ import annotations

import math

from ..domain import geo
from ..domain.geo import LatLon
from ..domain.risk import WeatherSample, assess
from . import weather

MAX_POINTS = 90
MIN_CELL_KM = 9.0
HOURS = 48


def build_grid(corridor: list[LatLon]) -> dict:
    s, w, n, e = geo.bbox(corridor)
    diag = geo.haversine_m((s, w), (n, e))
    buffer_m = min(max(diag * 0.12, 40_000), 110_000)

    # Pad the bbox by the buffer.
    mid_lat = (s + n) / 2
    pad_lat = buffer_m / 111_000
    pad_lon = buffer_m / (111_000 * max(math.cos(math.radians(mid_lat)), 0.1))
    s, n, w, e = s - pad_lat, n + pad_lat, w - pad_lon, e + pad_lon
    y_top, y_bot = geo.lat_to_merc_y(n), geo.lat_to_merc_y(s)

    index = geo.SpatialIndex(corridor, cell_deg=0.5)
    width_km = geo.haversine_m((mid_lat, w), (mid_lat, e)) / 1000
    height_km = geo.haversine_m((s, w), (n, w)) / 1000
    cell_km = max(MIN_CELL_KM, math.sqrt(width_km * height_km / (MAX_POINTS * 3)))

    while True:
        cols = max(2, round(width_km / cell_km))
        rows = max(2, round(height_km / cell_km))
        dlon, dy = (e - w) / cols, (y_top - y_bot) / rows
        cells, points = [], []
        for r in range(rows):
            lat = geo.merc_y_to_lat(y_top - (r + 0.5) * dy)
            for c in range(cols):
                p = (lat, w + (c + 0.5) * dlon)
                if index.nearest_m(p, buffer_m) < math.inf:
                    cells.append(r * cols + c)
                    points.append(p)
        if len(points) <= MAX_POINTS:
            break
        cell_km *= math.sqrt(len(points) / MAX_POINTS) * 1.05

    return {
        "cols": cols, "rows": rows,
        "west": w, "east": e, "north": n, "south": s,
        "cells": cells, "points": points,
        "cell_km": round(cell_km, 1),
    }


def build_heatmap(corridor: list[LatLon], start_ts: float, load_lbs: float) -> dict:
    grid = build_grid(corridor)
    start = math.floor(start_ts / 3600) * 3600
    hours = [start + h * 3600 for h in range(HOURS + 1)]
    forecasts = weather.fetch_hourly(grid["points"])

    risk, wind, rain, snow, wdir = [], [], [], [], []
    for ts in hours:
        r_row, w_row, ra_row, s_row, d_row = [], [], [], [], []
        for p in grid["points"]:
            sample: WeatherSample = forecasts[weather.grid_key(p)].sample(ts)
            r_row.append(int(assess(sample, load_lbs).level))
            w_row.append(round(sample.wind_mph))
            ra_row.append(round(sample.rain_in_hr, 2))
            s_row.append(round(sample.snow_in_hr, 1))
            d_row.append(round(sample.wind_dir_deg or 0))
        risk.append(r_row)
        wind.append(w_row)
        rain.append(ra_row)
        snow.append(s_row)
        wdir.append(d_row)

    return {
        "grid": {k: grid[k] for k in ("cols", "rows", "west", "east", "north", "south",
                                      "cells", "cell_km")},
        "hours": hours,
        "layers": {"risk": risk, "wind": wind, "rain": rain, "snow": snow},
        "wind_dir": wdir,
    }
