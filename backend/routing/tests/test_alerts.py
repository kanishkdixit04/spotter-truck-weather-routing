from unittest import mock

from django.test import SimpleTestCase

from routing.services import alerts


def feature(id_, event, severity="Moderate"):
    return {"properties": {"id": id_, "event": event, "severity": severity, "headline": event + " issued", "ends": "2026-11-08T12:00:00-07:00"}}


class AlertsTests(SimpleTestCase):
    def test_merges_same_alert_and_skips_irrelevant_events(self):
        by_mile = {
            0: {"features": [feature("a", "High Wind Warning", "Severe"), feature("h", "Heat Advisory")]},
            100: {"features": [feature("a", "High Wind Warning", "Severe"), feature("b", "Winter Storm Watch")]},
            200: {"features": []},
        }

        def fake(provider, method, url, params=None, **kw):
            lat = float(params["point"].split(",")[0])
            return by_mile[round(lat)]

        points = [{"lat": 0.0, "lon": 0.0, "mile": 0}, {"lat": 100.0, "lon": 0.0, "mile": 100}, {"lat": 200.0, "lon": 0.0, "mile": 200}]
        with mock.patch("routing.services.alerts.request_json", side_effect=fake):
            out = alerts.alerts_along(points)
        self.assertEqual([a["id"] for a in out["alerts"]], ["a", "b"])  # severe first, heat advisory dropped
        wind = out["alerts"][0]
        self.assertEqual((wind["first_mile"], wind["last_mile"]), (0, 100))

    def test_failed_points_are_counted_not_fatal(self):
        from routing.services.http import ProviderError
        with mock.patch("routing.services.alerts.request_json", side_effect=ProviderError("NWS", "down")):
            out = alerts.alerts_along([{"lat": 40.0, "lon": -100.0, "mile": 0}])
        self.assertEqual((out["alerts"], out["answered"], out["checked"]), ([], 0, 1))
