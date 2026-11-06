from django.test import SimpleTestCase

from routing.domain.ranking import Candidate, recommend, summarize
from routing.domain.risk import RiskLevel as L


def cand(rid, levels, total=100.0, hours=2.0, spacing=25.0):
    miles = [min(i * spacing, total) for i in range(len(levels))]
    return Candidate(rid, summarize(miles, levels, total), hours * 3600)


class SummarizeTests(SimpleTestCase):
    def test_miles_split_at_midpoints_and_sum_to_length(self):
        s = summarize([0, 25, 50, 75, 100], [L.LOW, L.HIGH, L.LOW, L.LOW, L.SEVERE], 100)
        self.assertAlmostEqual(s.miles(L.HIGH), 25)       # 12.5 .. 37.5
        self.assertAlmostEqual(s.miles(L.SEVERE), 12.5)   # 87.5 .. 100
        self.assertAlmostEqual(sum(s.miles_by_level.values()), 100)
        self.assertAlmostEqual(s.avg_risk, (25 * 2 + 12.5 * 3) / 100)
        self.assertEqual(s.max_level, L.SEVERE)


class RecommendTests(SimpleTestCase):
    def test_fewest_severe_beats_faster(self):
        slow_safe = cand("A", [L.LOW] * 5, hours=3)
        fast_severe = cand("B", [L.LOW, L.SEVERE, L.LOW, L.LOW, L.LOW], hours=2)
        rec = recommend([fast_severe, slow_safe])
        self.assertEqual(rec.route_id, "A")
        self.assertEqual(rec.decided_by, "severe_miles")

    def test_high_miles_break_severe_tie(self):
        a = cand("A", [L.LOW, L.HIGH, L.HIGH, L.LOW, L.LOW])
        b = cand("B", [L.LOW, L.HIGH, L.LOW, L.LOW, L.LOW])
        self.assertEqual(recommend([a, b]).route_id, "B")

    def test_average_risk_then_time(self):
        a = cand("A", [L.MODERATE, L.MODERATE, L.LOW, L.LOW, L.LOW], hours=1)
        b = cand("B", [L.LOW] * 5, hours=2)
        self.assertEqual(recommend([a, b]).route_id, "B")
        c = cand("C", [L.LOW] * 5, hours=1.5)
        rec = recommend([b, c])
        self.assertEqual(rec.route_id, "C")
        self.assertEqual(rec.decided_by, "travel_time_s")

    def test_no_travel_ranked_below_severe_and_flagged(self):
        a = cand("A", [L.LOW, L.NO_TRAVEL, L.LOW, L.LOW, L.LOW])
        b = cand("B", [L.SEVERE, L.SEVERE, L.SEVERE, L.LOW, L.LOW])
        rec = recommend([a, b])
        self.assertEqual(rec.route_id, "B")
        self.assertTrue(rec.safe_to_travel)

        all_blocked = recommend([a, cand("C", [L.NO_TRAVEL] * 5)])
        self.assertFalse(all_blocked.safe_to_travel)
        self.assertIn("consider delaying", all_blocked.reason)
