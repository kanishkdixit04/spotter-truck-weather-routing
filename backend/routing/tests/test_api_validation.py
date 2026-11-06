"""Request validation: the API rejects what the forecast can't answer."""

import time
from datetime import datetime, timedelta, timezone

from django.test import SimpleTestCase

from routing.serializers import HeatmapRequestSerializer, PlanRequestSerializer

A = {"lat": 41.88, "lon": -87.63}
B = {"lat": 39.74, "lon": -104.99}


def plan(**over):
    body = {"origin": A, "destination": B, "load_lbs": 30000, "interval_mi": 25, "hos": True,
            "departure": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()}
    body.update(over)
    return PlanRequestSerializer(data=body)


class PlanValidationTests(SimpleTestCase):
    def test_valid_request(self):
        self.assertTrue(plan().is_valid())

    def test_past_departure_rejected(self):
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        s = plan(departure=past)
        self.assertFalse(s.is_valid())
        self.assertIn("departure", s.errors)

    def test_departure_beyond_seven_days_rejected(self):
        far = (datetime.now(timezone.utc) + timedelta(days=8)).isoformat()
        s = plan(departure=far)
        self.assertFalse(s.is_valid())
        self.assertIn("departure", s.errors)

    def test_interval_must_be_10_25_or_50(self):
        self.assertFalse(plan(interval_mi=30).is_valid())

    def test_load_limit(self):
        self.assertFalse(plan(load_lbs=90000).is_valid())
        self.assertFalse(plan(load_lbs=-1).is_valid())

    def test_same_origin_and_destination_rejected(self):
        self.assertFalse(plan(destination=A).is_valid())


class HeatmapValidationTests(SimpleTestCase):
    def test_start_outside_window_rejected(self):
        s = HeatmapRequestSerializer(data={"corridor": [[40, -100], [41, -99]], "start_ts": time.time() - 86400, "load_lbs": 0})
        self.assertFalse(s.is_valid())
