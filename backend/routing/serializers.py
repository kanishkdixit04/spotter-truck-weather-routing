"""Request validation for the public API."""

from __future__ import annotations

import time

from rest_framework import serializers

MAX_DAYS_AHEAD = 7
MAX_LOAD_LBS = 80_000


class PointSerializer(serializers.Serializer):
    lat = serializers.FloatField(min_value=-85, max_value=85)
    lon = serializers.FloatField(min_value=-180, max_value=180)
    label = serializers.CharField(required=False, allow_blank=True, max_length=200)


class PlanRequestSerializer(serializers.Serializer):
    origin = PointSerializer()
    destination = PointSerializer()
    departure = serializers.DateTimeField(help_text="ISO-8601 with timezone offset")
    load_lbs = serializers.FloatField(min_value=0, max_value=MAX_LOAD_LBS)
    interval_mi = serializers.ChoiceField(choices=[10, 25, 50], default=25)
    hos = serializers.BooleanField(default=True)

    def validate_departure(self, value):
        ts = value.timestamp()
        now = time.time()
        if ts < now - 3600:
            raise serializers.ValidationError("Departure can't be in the past.")
        if ts > now + MAX_DAYS_AHEAD * 86400:
            raise serializers.ValidationError(
                f"Departure must be within {MAX_DAYS_AHEAD} days - forecasts beyond that are unreliable."
            )
        return value

    def validate(self, attrs):
        o, d = attrs["origin"], attrs["destination"]
        if abs(o["lat"] - d["lat"]) < 1e-4 and abs(o["lon"] - d["lon"]) < 1e-4:
            raise serializers.ValidationError("Origin and destination are the same place.")
        return attrs


class HeatmapRequestSerializer(serializers.Serializer):
    corridor = serializers.ListField(
        child=serializers.ListField(child=serializers.FloatField(), min_length=2, max_length=2),
        min_length=2, max_length=5000,
    )
    start_ts = serializers.FloatField()
    load_lbs = serializers.FloatField(min_value=0, max_value=MAX_LOAD_LBS)

    def validate_start_ts(self, value):
        now = time.time()
        if not (now - 3 * 3600 <= value <= now + MAX_DAYS_AHEAD * 86400):
            raise serializers.ValidationError("start_ts is outside the forecast window.")
        return value


class AlertPointSerializer(serializers.Serializer):
    lat = serializers.FloatField(min_value=-85, max_value=85)
    lon = serializers.FloatField(min_value=-180, max_value=180)
    mile = serializers.FloatField(min_value=0)


class AlertsRequestSerializer(serializers.Serializer):
    points = AlertPointSerializer(many=True, min_length=1, max_length=16)
