from django.urls import path

from . import views

urlpatterns = [
    path("health", views.health),
    path("geocode", views.geocode),
    path("routes", views.routes_preview),
    path("plan", views.plan),
    path("heatmap", views.heatmap_view),
    path("alerts", views.alerts),
]
