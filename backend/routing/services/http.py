"""Shared HTTP session with retries, a polite User-Agent and response caching."""

from __future__ import annotations

import hashlib
import json
import logging
import time
from typing import Any

import requests
from django.conf import settings
from django.core.cache import cache

log = logging.getLogger(__name__)


class ProviderError(Exception):
    """A third-party API failed or returned something unusable."""

    def __init__(self, provider: str, message: str, status: int = 502):
        super().__init__(f"{provider}: {message}")
        self.provider = provider
        self.message = message
        self.status = status


_session: requests.Session | None = None


def session() -> requests.Session:
    global _session
    if _session is None:
        s = requests.Session()
        s.headers["User-Agent"] = settings.TRUCK_ROUTING["USER_AGENT"]
        adapter = requests.adapters.HTTPAdapter(pool_connections=8, pool_maxsize=16)
        s.mount("https://", adapter)
        s.mount("http://", adapter)
        _session = s
    return _session


def _cache_key(method: str, url: str, params: Any, body: Any) -> str:
    raw = json.dumps([method, url, params, body], sort_keys=True, default=str)
    return "http:" + hashlib.sha1(raw.encode()).hexdigest()


def request_json(
    provider: str,
    method: str,
    url: str,
    *,
    params: dict | None = None,
    json_body: Any = None,
    headers: dict | None = None,
    cache_seconds: int = 0,
    retries: int = 2,
) -> Any:
    key = _cache_key(method, url, params, json_body) if cache_seconds else None
    if key and (hit := cache.get(key)) is not None:
        return hit

    timeout = settings.TRUCK_ROUTING["HTTP_TIMEOUT"]
    last_error = "unknown error"
    last_status = 0
    for attempt in range(retries + 1):
        try:
            resp = session().request(
                method, url, params=params, json=json_body, headers=headers, timeout=timeout
            )
        except requests.RequestException as exc:
            last_error = f"network error ({exc.__class__.__name__})"
        else:
            if resp.status_code == 200:
                try:
                    data = resp.json()
                except ValueError:
                    raise ProviderError(provider, "invalid JSON response") from None
                if key:
                    cache.set(key, data, cache_seconds)
                return data
            last_status = resp.status_code
            last_error = f"HTTP {resp.status_code}: {resp.text[:200]}"
            if resp.status_code not in (429, 500, 502, 503, 504):
                break
        if attempt < retries:
            time.sleep(0.6 * (attempt + 1))
    log.warning("%s request failed: %s", provider, last_error)
    if last_status == 429:  # rate limited: tell the caller to wait rather than blame the request
        raise ProviderError(provider, last_error, status=503)
    raise ProviderError(provider, last_error)
