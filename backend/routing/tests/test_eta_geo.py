from django.test import SimpleTestCase

from routing.domain import eta, geo
from routing.services.planner import checkpoint_distances, simplify


class HoursOfServiceTests(SimpleTestCase):
    def test_short_trip_has_no_stops(self):
        self.assertEqual(eta.hos_stops(7 * 3600), [])

    def test_break_and_rest_schedule(self):
        stops = eta.hos_stops(20 * 3600)
        self.assertEqual([(s.drive_s / 3600, s.kind) for s in stops],
                         [(8, "break"), (11, "rest"), (19, "break")])
        # 20 h driving + 0.5 + 10 + 0.5 h of stops
        self.assertEqual(eta.elapsed_clock_s(20 * 3600, stops), 31 * 3600)

    def test_truck_speed_cap(self):
        # 1609 m in 30 s is ~120 mph; capped at 60 mph -> 60 s
        self.assertAlmostEqual(eta.truck_segment_durations([1609.344], [30], 60)[0], 60, places=3)


class GeoTests(SimpleTestCase):
    def test_haversine_known_distance(self):
        # Chicago -> Denver is ~1,477 km great-circle
        d = geo.haversine_m((41.8781, -87.6298), (39.7392, -104.9903)) / 1000
        self.assertAlmostEqual(d, 1477, delta=10)

    def test_mercator_roundtrip(self):
        for lat in (-60, 0, 33.3, 71):
            self.assertAlmostEqual(geo.merc_y_to_lat(geo.lat_to_merc_y(lat)), lat, places=9)

    def test_checkpoints_every_interval_plus_destination(self):
        mile = geo.METERS_PER_MILE
        self.assertEqual([round(d / mile) for d in checkpoint_distances(60 * mile, 25)],
                         [0, 25, 50, 60])
        # a tiny stub at the end merges into the destination
        self.assertEqual([round(d / mile, 1) for d in checkpoint_distances(50.5 * mile, 25)],
                         [0, 25, 50.5])

    def test_simplify_keeps_ends_and_corners(self):
        line = [(0, 0), (0, 0.001), (0, 0.002), (0.01, 0.002)]
        self.assertEqual(simplify(line, 5), [0, 2, 3])


class WindDirectionTests(SimpleTestCase):
    def test_bearing_blend_takes_the_short_way_round(self):
        from routing.services.weather import HourlySeries
        s = HourlySeries(times=[0, 3600], wind=[10, 10], gust=[10, 10], rain=[0, 0], snow=[0, 0], temp=[50, 50], wdir=[350, 10])
        self.assertAlmostEqual(s.sample(1800).wind_dir_deg % 360, 0, delta=0.5)
