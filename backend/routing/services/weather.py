"""Hourly forecasts from Open-Meteo, sampled at the truck's arrival time.

Open-Meteo reports precipitation as the sum over the *preceding* hour, so the
value stamped 15:00 is the rate between 14:00 and 15:00. Wind is an
instantaneous value at the stamp. Sampling therefore uses:
  * wind / gusts / temperature: linear interpolation between the two hours
    around the arrival time;
  * rain / snow: the hourly bucket the arrival time falls in.
Many locations are requested per call (Open-Meteo accepts comma-separated
coordinates) and batches run in parallel.
"""

from __future__ import annotations

import bisect
import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone

from django.conf import settings
from django.core.cache import cache

from ..domain.geo import LatLon
from ..domain.risk import WeatherSample
from .http import ProviderError, request_json

log = logging.getLogger(__name__)

BATCH_SIZE = 50
METNO_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact"
HOURLY_VARS = "wind_speed_10m,wind_gusts_10m,wind_direction_10m,rain,showers,snowfall,temperature_2m"


SERIES_TTL_S = 1200      # a cell's forecast is reused for 20 minutes
LOOKBACK_H = 3           # departures can be up to an hour ago; the heatmap starts on the hour
LOOKAHEAD_DAYS = 10      # 7 day departure limit + a long trip + the 36 h departure scan


def grid_key(p: LatLon) -> tuple[float, float]:
    """Forecast models are ~11-13 km grids, so 0.1 degree cells lose nothing and let
    overlapping routes, the departure scan and the heatmap share forecast calls."""
    return round(p[0], 1), round(p[1], 1)


@dataclass
class HourlySeries:
    times: list[int]
    wind: list[float]
    gust: list[float]
    rain: list[float]
    snow: list[float]
    temp: list[float]
    wdir: list[float]
    source: str = "open-meteo"

    def _bracket(self, ts: float) -> tuple[int, int, float]:
        t = self.times
        if ts <= t[0]:
            return 0, 0, 0.0
        if ts >= t[-1]:
            return len(t) - 1, len(t) - 1, 0.0
        j = bisect.bisect_left(t, ts)
        i = j - 1
        return i, j, (ts - t[i]) / (t[j] - t[i])

    @staticmethod
    def _lerp(values, i, j, f) -> float:
        return values[i] + (values[j] - values[i]) * f

    def _lerp_angle(self, i: int, j: int, f: float) -> float:
        """Blend two compass bearings along the shorter arc (350 and 10 meet at 0, not 180)."""
        a, b = self.wdir[i], self.wdir[j]
        diff = (b - a + 180) % 360 - 180
        return (a + diff * f) % 360

    def sample(self, ts: float) -> WeatherSample:
        i, j, f = self._bracket(ts)
        # The bucket covering ts is the first stamp at or after ts.
        bucket = j if f > 0 else i
        return WeatherSample(
            wind_mph=self._lerp(self.wind, i, j, f),
            gust_mph=self._lerp(self.gust, i, j, f),
            rain_in_hr=self.rain[bucket],
            snow_in_hr=self.snow[bucket],
            temperature_f=self._lerp(self.temp, i, j, f),
            wind_dir_deg=self._lerp_angle(i, j, f) if self.wdir else None,
        )


def _hour_str(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:00")


def _clean(values) -> list[float]:
    return [0.0 if v is None else float(v) for v in values]


def _parse(item: dict) -> HourlySeries:
    hourly = item.get("hourly") or {}
    units = item.get("hourly_units") or {}
    if not hourly.get("time"):
        raise ProviderError("Open-Meteo", "response has no hourly data")
    snow = _clean(hourly.get("snowfall", []))
    if units.get("snowfall", "").startswith("cm"):
        snow = [v / 2.54 for v in snow]
    rain = [a + b for a, b in zip(_clean(hourly.get("rain", [])), _clean(hourly.get("showers", [])))]
    if units.get("rain", "").startswith("mm"):
        rain = [v / 25.4 for v in rain]
    return HourlySeries(
        times=[int(t) for t in hourly["time"]],
        wind=_clean(hourly.get("wind_speed_10m", [])),
        gust=_clean(hourly.get("wind_gusts_10m", [])),
        rain=rain,
        snow=snow,
        temp=_clean(hourly.get("temperature_2m", [])),
        wdir=_clean(hourly.get("wind_direction_10m", [])),
    )


def _fetch_batch(keys: list[tuple[float, float]], start_ts: float, end_ts: float) -> list[HourlySeries]:
    cfg = settings.TRUCK_ROUTING
    params = {
        "latitude": ",".join(f"{k[0]:.1f}" for k in keys),
        "longitude": ",".join(f"{k[1]:.1f}" for k in keys),
        "hourly": HOURLY_VARS,
        "wind_speed_unit": "mph",
        "precipitation_unit": "inch",
        "temperature_unit": "fahrenheit",
        "timeformat": "unixtime",
        "timezone": "GMT",
        "start_hour": _hour_str(start_ts),
        "end_hour": _hour_str(end_ts + 3600),
    }
    url = cfg["OPEN_METEO_URL"]
    if cfg["OPEN_METEO_API_KEY"]:
        params["apikey"] = cfg["OPEN_METEO_API_KEY"]
        url = url.replace("api.open-meteo.com", "customer-api.open-meteo.com")
    data = request_json("Open-Meteo", "GET", url, params=params, retries=3)
    items = data if isinstance(data, list) else [data]
    if len(items) != len(keys):
        raise ProviderError("Open-Meteo", f"expected {len(keys)} locations, got {len(items)}")
    return [_parse(item) for item in items]


def _series_key(k: tuple[float, float]) -> str:
    return f"om-series:{k[0]:.1f},{k[1]:.1f}"


def _metno_series(key: tuple[float, float]) -> HourlySeries:
    """Fallback forecast from MET Norway (free, no key, one call per location).

    It reports precipitation as one number, so rain and snow are split by temperature:
    at or below 0.5 C the water becomes snow at the usual 10:1 depth ratio. Steps are hourly for
    about 2.5 days and 6-hourly after that; the sampler interpolates across either.
    """
    data = request_json("MET Norway", "GET", METNO_URL, params={"lat": f"{key[0]:.2f}", "lon": f"{key[1]:.2f}"}, retries=2)
    series = (data.get("properties") or {}).get("timeseries") or []
    if len(series) < 2:
        raise ProviderError("MET Norway", "response has no forecast data")
    times = [int(datetime.fromisoformat(e["time"].replace("Z", "+00:00")).timestamp()) for e in series]
    wind, gust, wdir, temp, rain, snow = [], [], [], [], [], []
    for j, e in enumerate(series):
        d = e["data"]["instant"]["details"]
        wind.append(d.get("wind_speed", 0.0) * 2.23694)
        gust.append(d.get("wind_speed_of_gust", d.get("wind_speed", 0.0)) * 2.23694)
        wdir.append(d.get("wind_from_direction", 0.0))
        c = d.get("air_temperature", 10.0)
        temp.append(c * 9 / 5 + 32)
        # Our convention: the value at a stamp is the rate over the hour BEFORE it, so read the previous entry's forecast.
        mm_per_h = 0.0
        if j > 0:
            prev, gap_h = series[j - 1]["data"], (times[j] - times[j - 1]) / 3600
            block = prev.get("next_1_hours") if gap_h <= 1.5 else prev.get("next_6_hours")
            if block:
                mm = block.get("details", {}).get("precipitation_amount", 0.0)
                mm_per_h = mm / (1 if gap_h <= 1.5 else 6)
        inches = mm_per_h / 25.4
        if c <= 0.5:
            rain.append(0.0); snow.append(inches * 10)
        else:
            rain.append(inches); snow.append(0.0)
    return HourlySeries(times, wind, gust, rain, snow, temp, wdir, source="met.no")


def _fetch_batch_or_fallback(keys: list[tuple[float, float]], start_ts: float, end_ts: float) -> list[HourlySeries]:
    try:
        return _fetch_batch(keys, start_ts, end_ts)
    except ProviderError as exc:
        log.warning("Open-Meteo failed (%s); using MET Norway for %d locations", exc.message[:80], len(keys))
        with ThreadPoolExecutor(max_workers=6) as pool:
            try:
                return list(pool.map(_metno_series, keys))
            except ProviderError:
                raise exc from None  # both providers failed: report the original problem


def fetch_hourly(points: list[LatLon]) -> dict[tuple[float, float], HourlySeries]:
    """Forecast series for every point, keyed by `grid_key(point)`.

    Open-Meteo bills one call per location, and a minute's allowance is small. So each
    cell is fetched once for the whole 10 day window and kept for SERIES_TTL_S: a second
    trip, the departure scan and the heatmap all reuse it instead of calling again.
    """
    keys = sorted({grid_key(p) for p in points})
    if not keys:
        return {}
    cached = cache.get_many([_series_key(k) for k in keys])
    out = {k: cached[_series_key(k)] for k in keys if _series_key(k) in cached}
    missing = [k for k in keys if k not in out]
    if missing:
        now = math.floor(time.time() / 3600) * 3600
        start, end = now - LOOKBACK_H * 3600, now + LOOKAHEAD_DAYS * 86400
        batches = [missing[i:i + BATCH_SIZE] for i in range(0, len(missing), BATCH_SIZE)]
        with ThreadPoolExecutor(max_workers=min(3, len(batches))) as pool:
            results = list(pool.map(lambda b: _fetch_batch_or_fallback(b, start, end), batches))
        fresh: dict[tuple[float, float], HourlySeries] = {}
        for batch, series in zip(batches, results):
            fresh.update(zip(batch, series))
        cache.set_many({_series_key(k): v for k, v in fresh.items()}, SERIES_TTL_S)
        out.update(fresh)
    return out
