import type { AlertsResponse, HeatmapResponse, RoutePreview, Place, PlanInput, PlanResponse } from "./types";

/** An API failure that remembers the HTTP status, so the UI can tell "busy" from "broken". */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error("Cannot reach the server. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status}).`, res.status);
  return data as T;
}

const post = (body: unknown): RequestInit => ({
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

export const geocode = (q: string, signal?: AbortSignal) =>
  call<{ results: Place[] }>(`/api/geocode?q=${encodeURIComponent(q)}`, { signal }).then((r) => r.results);

export const planTrip = (input: PlanInput) => call<PlanResponse>("/api/plan", post(input));

export const getRoutes = (input: PlanInput) =>
  call<{ routes: RoutePreview[]; warnings: string[] }>("/api/routes", post(input));

export const getAlerts = (points: { lat: number; lon: number; mile: number }[]) =>
  call<AlertsResponse>("/api/alerts", post({ points }));

export const getHeatmap = (plan: PlanResponse) =>
  call<HeatmapResponse>("/api/heatmap", post({ corridor: plan.corridor, start_ts: plan.departure_ts, load_lbs: plan.load_lbs }));
