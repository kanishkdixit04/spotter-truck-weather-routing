import type { Route } from "./types";

export interface TruckStatus {
  phase: "waiting" | "driving" | "resting" | "arrived";
  mile: number; wind: number; rain: number; snow: number; level: number; label: string;
}

/** Where the truck is, and what it is driving through, at a moment on the forecast timeline. */
export function truckStatus(route: Route, ts: number): TruckStatus {
  const c = route.checkpoints;
  const first = c[0], last = c[c.length - 1];
  const dep = route.arrival_ts - route.travel_time_s;
  let phase: TruckStatus["phase"] = "driving";
  let label = "Driving";
  const stop = route.stops.find((s) => ts >= s.start_ts && ts < s.end_ts);
  if (ts < dep) { phase = "waiting"; label = "Not yet left"; }
  else if (ts >= route.arrival_ts) { phase = "arrived"; label = "Arrived"; }
  else if (stop) { phase = "resting"; label = stop.kind === "rest" ? "On a 10 hour rest" : "On a 30 minute break"; }

  // Weather is read from the nearest checkpoint in time, with the mile interpolated between neighbours.
  let i = c.findIndex((x) => x.eta_ts >= ts);
  if (i === -1) i = c.length - 1;
  const a = c[Math.max(0, i - 1)], b = c[i];
  const f = b.eta_ts === a.eta_ts ? 0 : Math.max(0, Math.min(1, (ts - a.eta_ts) / (b.eta_ts - a.eta_ts)));
  const near = f < 0.5 ? a : b;
  const clamp = phase === "waiting" ? first : phase === "arrived" ? last : null;
  const src = clamp ?? near;
  return {
    phase, label,
    mile: clamp ? clamp.mile : a.mile + (b.mile - a.mile) * f,
    wind: src.weather.wind_mph, rain: src.weather.rain_in_hr, snow: src.weather.snow_in_hr, level: src.risk.level,
  };
}
