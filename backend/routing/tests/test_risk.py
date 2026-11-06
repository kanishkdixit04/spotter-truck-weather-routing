from django.test import SimpleTestCase

from routing.domain.risk import (RiskLevel as L, WeatherSample, assess, classify_load,
                                 classify_rain, classify_snow, classify_wind)


class WindTests(SimpleTestCase):
    def test_table_boundaries(self):
        cases = [(0, L.LOW), (24.9, L.LOW), (25, L.MODERATE), (34.9, L.MODERATE),
                 (35, L.HIGH), (44.9, L.HIGH), (45, L.SEVERE), (54.9, L.SEVERE),
                 (55, L.NO_TRAVEL), (80, L.NO_TRAVEL)]
        for mph, expected in cases:
            with self.subTest(mph=mph):
                self.assertEqual(classify_wind(mph), expected)


class RainTests(SimpleTestCase):
    def test_table_boundaries(self):
        cases = [(0, L.LOW), (0.099, L.LOW), (0.10, L.MODERATE), (0.25, L.HIGH),
                 (0.49, L.HIGH), (0.50, L.SEVERE), (1.00, L.SEVERE), (1.01, L.NO_TRAVEL)]
        for rate, expected in cases:
            with self.subTest(rate=rate):
                self.assertEqual(classify_rain(rate), expected)


class SnowTests(SimpleTestCase):
    def test_table_boundaries(self):
        cases = [(0, L.LOW), (0.49, L.LOW), (0.5, L.MODERATE), (1.0, L.HIGH),
                 (2.0, L.SEVERE), (3.0, L.SEVERE), (3.01, L.NO_TRAVEL)]
        for rate, expected in cases:
            with self.subTest(rate=rate):
                self.assertEqual(classify_snow(rate), expected)


class LoadRuleTests(SimpleTestCase):
    def test_55_mph_no_travel_for_any_load(self):
        self.assertEqual(classify_load(55, 0), L.NO_TRAVEL)

    def test_45_to_54_heavy_is_no_travel(self):
        self.assertEqual(classify_load(45, 30_001), L.NO_TRAVEL)
        self.assertEqual(classify_load(54, 45_000), L.NO_TRAVEL)
        self.assertEqual(classify_load(50, 30_000), L.LOW)  # rule is ">30,000"

    def test_35_to_44_very_heavy_is_severe(self):
        self.assertEqual(classify_load(35, 40_001), L.SEVERE)
        self.assertEqual(classify_load(44, 40_000), L.LOW)
        self.assertEqual(classify_load(34, 50_000), L.LOW)

    def test_load_upgrades_overall_level(self):
        sample = WeatherSample(wind_mph=40, gust_mph=55, rain_in_hr=0, snow_in_hr=0)
        self.assertEqual(assess(sample, 20_000).level, L.HIGH)
        heavy = assess(sample, 42_000)
        self.assertEqual(heavy.level, L.SEVERE)
        self.assertIn("42,000 lb load in 40 mph wind", heavy.reasons)

    def test_worst_factor_wins(self):
        sample = WeatherSample(wind_mph=10, gust_mph=15, rain_in_hr=0.3, snow_in_hr=2.5)
        result = assess(sample, 10_000)
        self.assertEqual(result.level, L.SEVERE)
        self.assertEqual(result.rain, L.HIGH)
        self.assertEqual(result.reasons, ("Snow 2.5 in/hr",))
