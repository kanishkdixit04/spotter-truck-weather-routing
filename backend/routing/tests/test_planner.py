"""End-to-end planner/API test with the routing and weather APIs faked."""

import math
import time
from datetime import datetime, timedelta, timezone
from unittest import mock

from django.core.cache import cache
from django.test import SimpleTestCase
from rest_framework.test import APIClient

from routing.domain import geo

ORIGIN, DEST = (40.0, -90.0), (40.0, -85.0)


def fake_osrm(provider, method, url, params=None, **kw):
    path = url.split("/driving/")[1]
    pts = [tuple(map(float, p.split(",")))[::-1] for p in path.split(";")]
    coords = []
    for a, b in zip(pts, pts[1:]):
        for k in range(100):
            coords.append(geo.interpolate(a, b, k / 100))
    coords.append(pts[-1])
    dist = sum(geo.haversine_m(a, b) for a, b in zip(coords, coords[1:]))
    seg = [geo.haversine_m(a, b) / 25 for a, b in zip(coords, coords[1:])]
    return {"code": "Ok", "routes": [{
        "distance": dist, "duration": dist / 25,
        "geometry": {"coordinates": [[lon, lat] for lat, lon in coords]},
        "legs": [{"summary": "I 70", "annotation": {"duration": seg}}],
    }]}


def fake_meteo(provider, method, url, params=None, **kw):
    lats = [float(x) for x in params["latitude"].split(",")]
    lons = [float(x) for x in params["longitude"].split(",")]
    start = datetime.strptime(params["start_hour"], "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
    end = datetime.strptime(params["end_hour"], "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
    times = list(range(int(start.timestamp()), int(end.timestamp()) + 1, 3600))
    out = []
    for lat, lon in zip(lats, lons):
        # a wind storm sits on the middle of the direct road
        storm = abs(lat - 40.0) < 0.15 and -88.5 < lon < -86.5
        n = len(times)
        out.append({
            "hourly_units": {"snowfall": "inch", "rain": "inch"},
            "hourly": {"time": times,
                       "wind_speed_10m": [48.0 if storm else 12.0] * n,
                       "wind_gusts_10m": [60.0 if storm else 18.0] * n,
                       "rain": [0.0] * n, "showers": [0.0] * n, "snowfall": [0.0] * n,
                       "temperature_2m": [50.0] * n}})
    return out if len(out) > 1 else out[0]


@mock.patch("routing.services.weather.request_json", side_effect=fake_meteo)
@mock.patch("routing.services.routing.request_json", side_effect=fake_osrm)
class PlanApiTests(SimpleTestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.departure = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()

    def plan(self, **overrides):
        body = {"origin": {"lat": ORIGIN[0], "lon": ORIGIN[1]},
                "destination": {"lat": DEST[0], "lon": DEST[1]},
                "departure": self.departure, "load_lbs": 35_000, "interval_mi": 25}
        body.update(overrides)
        return self.client.post("/api/plan", body, format="json")

    def test_three_routes_and_storm_avoided(self, *_):
        res = self.plan()
        self.assertEqual(res.status_code, 200, res.content)
        data = res.json()
        self.assertEqual(len(data["routes"]), 3)
        direct = next(r for r in data["routes"] if r["id"] == "A")  # fastest
        # 48 mph wind + 35,000 lb (>30k) -> No Travel on the direct road
        self.assertGreater(direct["summary"]["miles_by_level"]["no_travel"], 0)
        self.assertNotEqual(data["recommendation"]["route_id"], "A")
        self.assertTrue(data["recommendation"]["safe_to_travel"])
        for route in data["routes"]:
            total = sum(route["summary"]["miles_by_level"].values())
            self.assertAlmostEqual(total, route["distance_mi"], delta=0.5)
            etas = [c["eta_ts"] for c in route["checkpoints"]]
            self.assertEqual(etas, sorted(etas))
            self.assertEqual(route["checkpoints"][0]["progress"], 0)
            self.assertEqual(route["checkpoints"][-1]["progress"], 1)

    def test_checkpoint_spacing_follows_interval(self, *_):
        for interval in (10, 50):
            data = self.plan(interval_mi=interval).json()
            miles = [c["mile"] for c in data["routes"][0]["checkpoints"]]
            self.assertEqual(miles[1] - miles[0], interval)

    def test_light_load_same_storm_is_only_severe(self, *_):
        data = self.plan(load_lbs=10_000).json()
        direct = next(r for r in data["routes"] if r["id"] == "A")
        self.assertEqual(direct["summary"]["miles_by_level"]["no_travel"], 0)
        self.assertGreater(direct["summary"]["miles_by_level"]["severe"], 0)

    def test_validation_errors(self, *_):
        past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        res = self.plan(departure=past)
        self.assertEqual(res.status_code, 400)
        self.assertIn("past", res.json()["error"])
        self.assertEqual(self.plan(interval_mi=30).status_code, 400)

    def test_heatmap(self, *_):
        data = self.plan().json()
        res = self.client.post("/api/heatmap", {"corridor": data["corridor"],
                               "start_ts": time.time(), "load_lbs": 35_000}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        hm = res.json()
        self.assertEqual(len(hm["hours"]), 49)
        n = len(hm["grid"]["cells"])
        self.assertTrue(0 < n <= 240)
        self.assertEqual(len(hm["layers"]["risk"][0]), n)
        self.assertIn(4, {v for row in hm["layers"]["risk"] for v in row})


@mock.patch("routing.services.weather.request_json", side_effect=fake_meteo)
@mock.patch("routing.services.routing.request_json", side_effect=fake_osrm)
class DepartureScanTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    def body(self):
        return {"origin": {"lat": ORIGIN[0], "lon": ORIGIN[1]}, "destination": {"lat": DEST[0], "lon": DEST[1]},
                "departure": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
                "load_lbs": 35_000, "interval_mi": 25}

    def test_plan_includes_one_option_per_step_and_a_best(self, *_):
        res = APIClient().post("/api/plan", self.body(), format="json")
        self.assertEqual(res.status_code, 200, res.content)
        dep = res.json()["departures"]
        self.assertEqual([o["offset_h"] for o in dep["options"]], list(range(0, 37, 3)))
        self.assertIn(dep["best_offset_h"], [o["offset_h"] for o in dep["options"]])
        for o in dep["options"]:
            self.assertIn(o["route_id"], "ABC")

    def test_forecast_is_fetched_once_per_cell_and_reused(self, _osrm, meteo):
        client = APIClient()
        client.post("/api/plan", self.body(), format="json")
        first = meteo.call_count
        self.assertGreater(first, 0)
        client.post("/api/plan", self.body(), format="json")  # same cells again: no new weather calls
        self.assertEqual(meteo.call_count, first)
