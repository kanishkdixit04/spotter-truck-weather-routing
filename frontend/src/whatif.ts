import type { PlanResponse, Route } from "./types";

/** Same load rule as the backend (backend/routing/domain/risk.py), so a different weight can be tried instantly. */
export function loadLevel(windMph: number, lbs: number): number {
  if (windMph >= 55) return 4;
  if (windMph >= 45 && lbs > 30_000) return 4;
  if (windMph >= 35 && lbs > 40_000) return 3;
  return 0;
}

interface Tally { no: number; sev: number; hi: number; avg: number; time: number }

function tally(route: Route, lbs: number): Tally {
  const c = route.checkpoints, total = route.distance_mi || 1;
  let no = 0, sev = 0, hi = 0, weighted = 0;
  c.forEach((p, i) => {
    const f = p.risk.factors;
    const level = Math.max(f.wind, f.rain, f.snow, loadLevel(p.weather.wind_mph, lbs));
    const start = i === 0 ? 0 : (c[i - 1].mile + p.mile) / 2;
    const end = i === c.length - 1 ? total : (p.mile + c[i + 1].mile) / 2;
    const span = Math.max(0, end - start);
    if (level === 4) no += span; else if (level === 3) sev += span; else if (level === 2) hi += span;
    weighted += span * level;
  });
  return { no, sev, hi, avg: weighted / total, time: route.travel_time_s };
}

export interface WhatIf { lbs: number; routeId: string; no: number; sev: number; hi: number }

/** Which route the recommendation rule would pick if the truck carried `lbs`, and how risky it is. */
export function whatIf(plan: PlanResponse, lbs: number): WhatIf {
  const key = (t: Tally) => [Math.round(t.no * 10), Math.round(t.sev * 10), Math.round(t.hi * 10), Math.round(t.avg * 100), Math.round(t.time)];
  const rows = plan.routes.map((r) => ({ id: r.id, t: tally(r, lbs) }));
  rows.sort((a, b) => {
    const ka = key(a.t), kb = key(b.t);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
  const best = rows[0];
  return { lbs, routeId: best.id, no: best.t.no, sev: best.t.sev, hi: best.t.hi };
}
