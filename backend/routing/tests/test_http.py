from unittest import mock

from django.test import SimpleTestCase

from routing.errors import exception_handler
from routing.services.http import ProviderError, request_json


class Resp:
    def __init__(self, status, body=None):
        self.status_code, self._body, self.text = status, body or {}, "limit"

    def json(self):
        return self._body


class RateLimitTests(SimpleTestCase):
    def test_retries_then_reports_busy(self):
        sess = mock.Mock()
        sess.request.return_value = Resp(429)
        with mock.patch("routing.services.http.session", return_value=sess), mock.patch("time.sleep"):
            with self.assertRaises(ProviderError) as ctx:
                request_json("Open-Meteo", "GET", "http://x", retries=2)
        self.assertEqual(sess.request.call_count, 3)
        self.assertEqual(ctx.exception.status, 503)

    def test_busy_message_is_friendly(self):
        r = exception_handler(ProviderError("Open-Meteo", "HTTP 429", status=503), {})
        self.assertEqual(r.status_code, 503)
        self.assertIn("busy", r.data["error"])

    def test_recovers_after_one_failure(self):
        sess = mock.Mock()
        sess.request.side_effect = [Resp(503), Resp(200, {"ok": 1})]
        with mock.patch("routing.services.http.session", return_value=sess), mock.patch("time.sleep"):
            self.assertEqual(request_json("P", "GET", "http://x"), {"ok": 1})
