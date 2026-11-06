"""Consistent JSON errors: {"error": "...", "details": {...}}."""

from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_handler

from .services.http import ProviderError


def exception_handler(exc, context):
    if isinstance(exc, ProviderError):
        busy = exc.status == 503
        text = (f"{exc.provider} is busy right now. Wait a minute and try again." if busy
                else f"{exc.provider} is unavailable or rejected the request.")
        return Response(
            {"error": text,
             "details": {"provider": exc.provider, "message": exc.message}},
            status=exc.status,
        )
    response = drf_handler(exc, context)
    if response is not None:
        data = response.data
        message = "Invalid request."
        if isinstance(data, dict):
            if "detail" in data:
                message = str(data["detail"])
            elif "non_field_errors" in data:
                message = str(data["non_field_errors"][0])
            else:
                field, errs = next(iter(data.items()))
                first = errs[0] if isinstance(errs, list) and errs else errs
                message = f"{field}: {first}"
        response.data = {"error": message, "details": data}
    return response
