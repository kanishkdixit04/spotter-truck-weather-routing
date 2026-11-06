"""HTTP endpoints. Views stay thin: validate, delegate to services, serialize."""

from rest_framework.decorators import api_view
from rest_framework.request import Request
from rest_framework.response import Response

from .serializers import AlertsRequestSerializer, HeatmapRequestSerializer, PlanRequestSerializer
from .services import alerts as nws, geocoding, heatmap, planner


@api_view(["GET"])
def health(_request: Request) -> Response:
    return Response({"ok": True})


@api_view(["GET"])
def geocode(request: Request) -> Response:
    query = request.query_params.get("q", "").strip()
    if len(query) < 2:
        return Response({"results": []})
    bias = None
    try:
        if "lat" in request.query_params and "lon" in request.query_params:
            bias = (float(request.query_params["lat"]), float(request.query_params["lon"]))
    except ValueError:
        bias = None
    return Response({"results": geocoding.search(query[:120], bias=bias)})


@api_view(["POST"])
def plan(request: Request) -> Response:
    s = PlanRequestSerializer(data=request.data)
    s.is_valid(raise_exception=True)
    v = s.validated_data
    trip = planner.TripRequest(
        origin=(v["origin"]["lat"], v["origin"]["lon"]),
        destination=(v["destination"]["lat"], v["destination"]["lon"]),
        departure_ts=v["departure"].timestamp(),
        load_lbs=v["load_lbs"],
        interval_mi=int(v["interval_mi"]),
        hos=v["hos"],
    )
    return Response(planner.plan_trip(trip))


@api_view(["POST"])
def heatmap_view(request: Request) -> Response:
    s = HeatmapRequestSerializer(data=request.data)
    s.is_valid(raise_exception=True)
    v = s.validated_data
    corridor = [(p[0], p[1]) for p in v["corridor"]]
    return Response(heatmap.build_heatmap(corridor, v["start_ts"], v["load_lbs"]))


@api_view(["POST"])
def alerts(request: Request) -> Response:
    """Active weather alerts at points along a route."""
    s = AlertsRequestSerializer(data=request.data)
    s.is_valid(raise_exception=True)
    return Response(nws.alerts_along(s.validated_data["points"]))
