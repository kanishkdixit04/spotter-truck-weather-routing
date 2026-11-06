"""Django settings for the weather-aware truck routing API.

The API is stateless (no database models): every request fetches routes and
forecasts from third-party providers, so the DB is a throwaway SQLite file.
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def env_bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).lower() in {"1", "true", "yes", "on"}


def env_list(name: str, default: str = "") -> list[str]:
    return [item.strip() for item in os.environ.get(name, default).split(",") if item.strip()]


SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-only-insecure-key-change-me")
DEBUG = env_bool("DJANGO_DEBUG", False)
ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,.vercel.app")

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.staticfiles",
    "corsheaders",
    "rest_framework",
    "routing",
]

MIDDLEWARE = [
    "django.middleware.gzip.GZipMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": ":memory:",
    }
}

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "truck-routing",
        "TIMEOUT": 15 * 60,
        "OPTIONS": {"MAX_ENTRIES": 2000},
    }
}

TEMPLATES = []
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_TZ = True
STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

REST_FRAMEWORK = {
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "DEFAULT_PERMISSION_CLASSES": [],
    "UNAUTHENTICATED_USER": None,
    "EXCEPTION_HANDLER": "routing.errors.exception_handler",
    "DEFAULT_THROTTLE_CLASSES": [],
}

CORS_ALLOWED_ORIGINS = env_list("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
CORS_ALLOWED_ORIGIN_REGEXES = [r"^https://.*\.vercel\.app$"]

# ---------------------------------------------------------------------------
# Provider configuration
# ---------------------------------------------------------------------------
TRUCK_ROUTING = {
    # OpenRouteService has a real heavy-goods-vehicle profile. When a key is set
    # it is used; otherwise we fall back to the public OSRM server (car graph,
    # with truck speeds applied on top - see domain/eta.py).
    "ORS_API_KEY": os.environ.get("ORS_API_KEY", ""),
    "OSRM_BASE_URL": os.environ.get("OSRM_BASE_URL", "https://router.project-osrm.org"),
    "OSRM_FALLBACK_URL": os.environ.get(
        "OSRM_FALLBACK_URL", "https://routing.openstreetmap.de/routed-car"
    ),
    "OPEN_METEO_URL": os.environ.get("OPEN_METEO_URL", "https://api.open-meteo.com/v1/forecast"),
    "OPEN_METEO_API_KEY": os.environ.get("OPEN_METEO_API_KEY", ""),
    "PHOTON_URL": os.environ.get("PHOTON_URL", "https://photon.komoot.io/api/"),
    "USER_AGENT": "spotter-weather-truck-routing/1.0 (assessment project)",
    "HTTP_TIMEOUT": float(os.environ.get("HTTP_TIMEOUT", "20")),
    # Truck assumptions
    "TRUCK_MAX_MPH": float(os.environ.get("TRUCK_MAX_MPH", "65")),
    "TRUCK_TARE_LBS": float(os.environ.get("TRUCK_TARE_LBS", "35000")),
}

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": "INFO"},
}
