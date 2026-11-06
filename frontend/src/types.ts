export interface Place { label: string; lat: number; lon: number; kind?: string }
export interface Weather { wind_mph: number; gust_mph: number; rain_in_hr: number; snow_in_hr: number; temp_f: number | null }
export interface Risk {
  level: number; key: string; label: string; reasons: string[];
  factors: { wind: number; rain: number; snow: number; load: number };
}
export interface Checkpoint {
  index: number; mile: number; lat: number; lon: number; progress: number;
  eta_ts: number; weather: Weather; risk: Risk;
}
export interface Stop { kind: "break" | "rest"; mile: number; lat: number; lon: number; start_ts: number; end_ts: number }
export interface Summary {
  miles_by_level: Record<"low" | "moderate" | "high" | "severe" | "no_travel", number>;
  avg_risk: number; max_level: number; max_level_key: string;
}
export interface Route {
  id: string; name: string; via?: string; distance_mi: number; drive_time_s: number; travel_time_s: number;
  arrival_ts: number; geometry: [number, number][]; checkpoints: Checkpoint[]; stops: Stop[];
  track: [number, number, number][]; summary: Summary; rank: number; recommended: boolean;
}
export interface PlanResponse {
  departure_ts: number; load_lbs: number; interval_mi: number; hos: boolean; routes: Route[];
  recommendation: { route_id: string; order: string[]; decided_by: string; reason: string; safe_to_travel: boolean };
  corridor: [number, number][]; warnings: string[]; routing_source: string;
  departures: DeparturesResponse;
}
export interface HeatmapResponse {
  grid: { cols: number; rows: number; west: number; east: number; north: number; south: number; cells: number[]; cell_km: number };
  hours: number[];
  layers: Record<LayerKey, number[][]>;
  wind_dir: number[][]; // degrees the wind blows from, per hour per cell
}
export interface DepartureOption {
  offset_h: number; depart_ts: number; route_id: string; no_travel_mi: number; severe_mi: number; high_mi: number;
  avg_risk: number; max_level: number; arrival_ts: number;
}
export interface DeparturesResponse { options: DepartureOption[]; best_offset_h: number; step_h: number }
export interface WeatherAlert {
  id: string; event: string; severity: "Extreme" | "Severe" | "Moderate" | "Minor"; headline: string;
  ends: string | null; onset: string | null; first_mile: number; last_mile: number; lat: number; lon: number;
}
export interface AlertsResponse { alerts: WeatherAlert[]; checked: number; answered: number }
export interface RoutePreview { id: string; via?: string; distance_mi: number; geometry: [number, number][] }
export type LayerKey = "risk" | "wind" | "rain" | "snow";
export interface PlanInput {
  origin: Place; destination: Place; departure: string; load_lbs: number; interval_mi: 10 | 25 | 50; hos: boolean;
}
