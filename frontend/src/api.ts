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

const places = new Map<string, Place[]>(); // typing "dal", deleting, typing "dal" again costs nothing

export async function geocode(q: string, signal?: AbortSignal): Promise<Place[]> {
  const key = q.trim().toLowerCase();
  const hit = places.get(key);
  if (hit) return hit;
  const { results } = await call<{ results: Place[] }>(`/api/geocode?q=${encodeURIComponent(key)}`, { signal });
  if (results.length) places.set(key, results);
  return results;
}

export const planTrip = (input: PlanInput) => call<PlanResponse>("/api/plan", post(input));

export const getRoutes = (input: PlanInput) =>
  call<{ routes: RoutePreview[]; warnings: string[] }>("/api/routes", post(input));

export const getAlerts = (points: { lat: number; lon: number; mile: number }[]) =>
  call<AlertsResponse>("/api/alerts", post({ points }));

export const getHeatmap = (plan: PlanResponse) =>
  call<HeatmapResponse>("/api/heatmap", post({ corridor: plan.corridor, start_ts: plan.departure_ts, load_lbs: plan.load_lbs }));
