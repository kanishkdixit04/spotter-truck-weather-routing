import { describe, expect, it } from "vitest";
import { loadLevel, whatIf } from "../whatif";
import { decide, toneFor } from "../verdict";
import { truckStatus } from "../truck";
import { fmtDelta, toIsoWithOffset } from "../format";
import { heatColor, rampPos } from "../risk";
import type { PlanResponse, Route } from "../types";

const cp = (mile: number, wind: number, windLevel: number, eta = mile * 60, level = windLevel) => ({
  index: 0, mile, lat: 0, lon: 0, progress: 0, eta_ts: eta,
  weather: { wind_mph: wind, gust_mph: wind, rain_in_hr: 0, snow_in_hr: 0, temp_f: 40 },
  risk: { level, key: "", label: "", reasons: [], factors: { wind: windLevel, rain: 0, snow: 0, load: 0 } },
});
const route = (id: string, winds: number[], time = 3600): Route => ({
  id, name: id, distance_mi: 100, drive_time_s: time, travel_time_s: time, arrival_ts: 100 * 60 + time, geometry: [], stops: [], track: [],
  checkpoints: [cp(0, 10, 0), ...winds.map((w, i) => cp(50 + i, w, w >= 45 ? 3 : w >= 35 ? 2 : 0)), cp(100, 10, 0)],
  summary: { miles_by_level: { low: 100, moderate: 0, high: 0, severe: 0, no_travel: 0 }, avg_risk: 0, max_level: 0, max_level_key: "low" },
  rank: 1, recommended: true,
});

describe("load rule (same thresholds as the backend)", () => {
  it("55 mph is No Travel for any load", () => expect(loadLevel(55, 0)).toBe(4));
  it("45 mph is No Travel only above 30,000 lb", () => {
    expect(loadLevel(45, 30_000)).toBe(0);
    expect(loadLevel(45, 30_001)).toBe(4);
  });
  it("35 mph is Severe only above 40,000 lb", () => {
    expect(loadLevel(35, 40_000)).toBe(0);
    expect(loadLevel(35, 40_001)).toBe(3);
  });
  it("calm wind never matters", () => expect(loadLevel(20, 80_000)).toBe(0));
});

describe("what-if", () => {
  it("a heavier load turns a Severe stretch into No Travel", () => {
    const plan = { routes: [route("A", [47])] } as PlanResponse;
    expect(whatIf(plan, 20_000).sev).toBeGreaterThan(0);
    expect(whatIf(plan, 20_000).no).toBe(0);
    expect(whatIf(plan, 35_000).no).toBeGreaterThan(0);
  });
  it("prefers the clean route even when it is slower", () => {
    const plan = { routes: [route("A", [47], 3600), route("B", [20], 7200)] } as PlanResponse;
    expect(whatIf(plan, 42_000).routeId).toBe("B");
  });
});

describe("verdict", () => {
  it("maps risk miles to a call", () => {
    expect(toneFor(0, 0, 0).tone).toBe("go");
    expect(toneFor(0, 0, 12).tone).toBe("care");
    expect(toneFor(3, 0, 0).tone).toBe("stop");
  });
  it("suggests waiting when a later departure is clearly better", () => {
    const r = route("A", [20]);
    r.summary.miles_by_level.severe = 40;
    const opt = (offset_h: number, severe_mi: number) => ({ offset_h, depart_ts: offset_h, route_id: "A", no_travel_mi: 0, severe_mi, high_mi: 0, avg_risk: 0, max_level: 0, arrival_ts: 0 });
    const deps = { options: [opt(0, 40), opt(6, 0)], best_offset_h: 6, step_h: 3 };
    const v = decide(r, deps);
    expect(v.tone).toBe("wait");
    expect(v.leaveAt?.offset_h).toBe(6);
  });
  it("an official severe alert stops a clean forecast saying Good to go", () => {
    const alert = { id: "x", event: "High Wind Warning", severity: "Severe", headline: "", ends: null, onset: null, first_mile: 0, last_mile: 1, lat: 0, lon: 0 } as const;
    expect(decide(route("A", [20]), null, [alert]).tone).toBe("care");
  });
});

describe("truck status", () => {
  const r = route("A", [20]);
  it("waits before departure and is arrived after", () => {
    expect(truckStatus(r, -1).phase).toBe("waiting");
    expect(truckStatus(r, r.arrival_ts + 1).phase).toBe("arrived");
  });
  it("reports a rest while stopped", () => {
    const rr = { ...r, stops: [{ kind: "rest" as const, mile: 50, lat: 0, lon: 0, start_ts: 7000, end_ts: 8000 }] };
    expect(truckStatus(rr, 7500).phase).toBe("resting");
  });
});

describe("formatting and colour", () => {
  it("signs durations", () => {
    expect(fmtDelta(4200)).toBe("+1h 10m");
    expect(fmtDelta(-1500)).toBe("-25m");
  });
  it("keeps the browser's UTC offset on the departure", () => {
    expect(toIsoWithOffset("2026-11-06T09:30")).toMatch(/^2026-11-06T09:30:00[+-]\d\d:\d\d$/);
  });
  it("heat ramp follows the rule thresholds", () => {
    expect(rampPos("wind", 25)).toBeCloseTo(1);
    expect(rampPos("wind", 55)).toBeCloseTo(4);
    expect(rampPos("rain", 0.5)).toBeCloseTo(3);
  });
  it("calm weather is more transparent than severe weather", () => {
    expect(heatColor("risk", 0)[3]).toBeLessThan(heatColor("risk", 3)[3]);
  });
});
