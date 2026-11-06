"""When Open-Meteo is rate limited, MET Norway answers instead."""

from unittest import mock

from django.core.cache import cache
from django.test import SimpleTestCase

from routing.services import weather
from routing.services.http import ProviderError


def metno_payload(temp_c=10.0):
    def entry(hour, wind_ms, mm):
        return {"time": f"2026-11-06T{hour:02d}:00:00Z", "data": {
            "instant": {"details": {"wind_speed": wind_ms, "wind_speed_of_gust": wind_ms * 1.5, "wind_from_direction": 270, "air_temperature": temp_c}},
            "next_1_hours": {"details": {"precipitation_amount": mm}}}}
    return {"properties": {"timeseries": [entry(10, 10, 0.0), entry(11, 20, 2.54), entry(12, 20, 0.0)]}}


class MetNorwayTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    def test_units_and_rain_attribution(self):
        with mock.patch("routing.services.weather.request_json", return_value=metno_payload()):
            s = weather._metno_series((40.0, -100.0))
        self.assertEqual(s.source, "met.no")
        self.assertAlmostEqual(s.wind[0], 22.37, places=1)            # 10 m/s in mph
        self.assertAlmostEqual(s.temp[0], 50.0, places=1)             # 10 C in F
        self.assertEqual(s.rain[1], 0.0)                              # nothing fell between 10:00 and 11:00
        self.assertAlmostEqual(s.rain[2], 0.1, places=3)              # 2.54 mm fell between 11:00 and 12:00, so it sits on the 12:00 stamp

    def test_precip_lands_on_the_stamp_after_it_fell(self):
        payload = metno_payload()
        payload["properties"]["timeseries"][0]["data"]["next_1_hours"]["details"]["precipitation_amount"] = 2.54
        with mock.patch("routing.services.weather.request_json", return_value=payload):
            s = weather._metno_series((40.0, -100.0))
        self.assertAlmostEqual(s.rain[1], 0.1, places=3)              # 2.54 mm = 0.1 in

    def test_cold_precip_becomes_snow(self):
        payload = metno_payload(temp_c=-5.0)
        payload["properties"]["timeseries"][0]["data"]["next_1_hours"]["details"]["precipitation_amount"] = 2.54
        with mock.patch("routing.services.weather.request_json", return_value=payload):
            s = weather._metno_series((40.0, -100.0))
        self.assertEqual(s.rain[1], 0.0)
        self.assertAlmostEqual(s.snow[1], 1.0, places=3)              # 0.1 in of water at 10:1

    def test_falls_back_when_open_meteo_is_limited(self):
        def fake(provider, method, url, params=None, **kw):
            if provider == "Open-Meteo":
                raise ProviderError("Open-Meteo", "HTTP 429", status=503)
            return metno_payload()
        with mock.patch("routing.services.weather.request_json", side_effect=fake):
            out = weather.fetch_hourly([(40.0, -100.0), (41.0, -99.0)])
        self.assertEqual({s.source for s in out.values()}, {"met.no"})

    def test_reports_original_error_when_both_fail(self):
        with mock.patch("routing.services.weather.request_json", side_effect=ProviderError("X", "down", status=503)):
            with self.assertRaises(ProviderError):
                weather.fetch_hourly([(40.0, -100.0)])
