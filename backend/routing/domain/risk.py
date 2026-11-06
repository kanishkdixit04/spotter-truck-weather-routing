"""Weather risk classification - a direct encoding of the assessment rule table.

    Condition   Low        Moderate    High       Severe      No Travel
    Wind        <25 mph    25-34       35-44      45-54       >=55 mph
    Rain        <0.10 in/h 0.10-0.25   0.25-0.50  0.50-1.00   >1.00
    Snow        <0.5 in/h  0.5-1.0     1.0-2.0    2.0-3.0     >3.0

    Load rules:
      * >=55 mph                 -> No Travel for any load
      * 45-54 mph and >30,000 lb -> No Travel
      * 35-44 mph and >40,000 lb -> Severe

Boundary handling (the table's ranges share end points, so we pick one side):
  * Lower bounds are inclusive ("0.25" is High, "35 mph" is High).
  * The No Travel bound follows the table's own operator: wind uses ">=55",
    rain/snow use ">" - so exactly 1.00 in/h rain is still Severe.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum


class RiskLevel(IntEnum):
    LOW = 0
    MODERATE = 1
    HIGH = 2
    SEVERE = 3
    NO_TRAVEL = 4

    @property
    def key(self) -> str:
        return self.name.lower()

    @property
    def label(self) -> str:
        return self.name.replace("_", " ").title()


# (threshold, level) pairs: value >= threshold => at least that level.
WIND_THRESHOLDS_MPH = ((25.0, RiskLevel.MODERATE), (35.0, RiskLevel.HIGH),
                       (45.0, RiskLevel.SEVERE), (55.0, RiskLevel.NO_TRAVEL))
RAIN_THRESHOLDS_IN_HR = ((0.10, RiskLevel.MODERATE), (0.25, RiskLevel.HIGH),
                         (0.50, RiskLevel.SEVERE))
RAIN_NO_TRAVEL_ABOVE = 1.00
SNOW_THRESHOLDS_IN_HR = ((0.5, RiskLevel.MODERATE), (1.0, RiskLevel.HIGH),
                         (2.0, RiskLevel.SEVERE))
SNOW_NO_TRAVEL_ABOVE = 3.0

LOAD_NO_TRAVEL_WIND_MPH = 45.0
LOAD_NO_TRAVEL_LBS = 30_000
LOAD_SEVERE_WIND_MPH = 35.0
LOAD_SEVERE_LBS = 40_000


def _from_thresholds(value: float, thresholds) -> RiskLevel:
    level = RiskLevel.LOW
    for threshold, candidate in thresholds:
        if value >= threshold:
            level = candidate
    return level


def classify_wind(mph: float) -> RiskLevel:
    return _from_thresholds(mph, WIND_THRESHOLDS_MPH)


def classify_rain(in_per_hr: float) -> RiskLevel:
    if in_per_hr > RAIN_NO_TRAVEL_ABOVE:
        return RiskLevel.NO_TRAVEL
    return _from_thresholds(in_per_hr, RAIN_THRESHOLDS_IN_HR)


def classify_snow(in_per_hr: float) -> RiskLevel:
    if in_per_hr > SNOW_NO_TRAVEL_ABOVE:
        return RiskLevel.NO_TRAVEL
    return _from_thresholds(in_per_hr, SNOW_THRESHOLDS_IN_HR)


def classify_load(wind_mph: float, load_lbs: float) -> RiskLevel:
    """Extra risk a heavy load adds in strong wind (high-profile rollover risk)."""
    if wind_mph >= 55.0:
        return RiskLevel.NO_TRAVEL
    if wind_mph >= LOAD_NO_TRAVEL_WIND_MPH and load_lbs > LOAD_NO_TRAVEL_LBS:
        return RiskLevel.NO_TRAVEL
    if wind_mph >= LOAD_SEVERE_WIND_MPH and load_lbs > LOAD_SEVERE_LBS:
        return RiskLevel.SEVERE
    return RiskLevel.LOW


@dataclass(frozen=True)
class WeatherSample:
    wind_mph: float
    gust_mph: float
    rain_in_hr: float
    snow_in_hr: float
    temperature_f: float | None = None
    wind_dir_deg: float | None = None  # direction the wind blows FROM (meteorological)


@dataclass(frozen=True)
class RiskAssessment:
    level: RiskLevel
    wind: RiskLevel
    rain: RiskLevel
    snow: RiskLevel
    load: RiskLevel
    reasons: tuple[str, ...] = field(default_factory=tuple)


def assess(sample: WeatherSample, load_lbs: float) -> RiskAssessment:
    """Overall checkpoint risk = the worst of wind, rain, snow and load rules."""
    wind = classify_wind(sample.wind_mph)
    rain = classify_rain(sample.rain_in_hr)
    snow = classify_snow(sample.snow_in_hr)
    load = classify_load(sample.wind_mph, load_lbs)
    level = max(wind, rain, snow, load)

    reasons: list[str] = []
    if level > RiskLevel.LOW:
        if wind == level:
            reasons.append(f"Wind {sample.wind_mph:.0f} mph")
        if rain == level:
            reasons.append(f"Rain {sample.rain_in_hr:.2f} in/hr")
        if snow == level:
            reasons.append(f"Snow {sample.snow_in_hr:.1f} in/hr")
        if load == level and load > wind:
            reasons.append(
                f"{load_lbs:,.0f} lb load in {sample.wind_mph:.0f} mph wind"
            )
    return RiskAssessment(level, wind, rain, snow, load, tuple(reasons))
