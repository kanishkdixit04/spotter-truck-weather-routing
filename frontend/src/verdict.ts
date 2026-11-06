import type { DepartureOption, DeparturesResponse, Route, WeatherAlert } from "./types";

export type Tone = "go" | "care" | "wait" | "stop";
export interface Verdict { tone: Tone; label: string; leaveAt: DepartureOption | null }

/** How bad a departure option is, in the same order the recommendation rule uses. */
export const departureScore = (o: DepartureOption) => o.no_travel_mi * 3 + o.severe_mi * 2 + o.high_mi + o.avg_risk;

/** The call a set of risk miles deserves on its own, before any "wait" advice. */
export function toneFor(nt: number, sev: number, hi: number): { tone: Tone; label: string } {
  if (nt >= 0.5) return { tone: "stop", label: "Do not go" };
  if (sev >= 0.5 || hi >= 0.5) return { tone: "care", label: "Go with care" };
  return { tone: "go", label: "Good to go" };
}

/**
 * One plain call for the driver: go, go carefully, wait, or don't go.
 * Waiting is only suggested when a later departure within the scan is clearly better.
 */
export function decide(route: Route, deps: DeparturesResponse | null, alerts: WeatherAlert[] = []): Verdict {
  const m = route.summary.miles_by_level;
  const nt = m.no_travel, sev = m.severe, hi = m.high;
  const now = deps?.options[0];
  const best = deps?.options.find((o) => o.offset_h === deps.best_offset_h);
  const better = now && best && best.offset_h > 0 && departureScore(best) < departureScore(now) - 0.5 ? best : null;

  if (nt >= 0.5) return better && better.no_travel_mi < nt
    ? { tone: "wait", label: "Better to wait", leaveAt: better }
    : { tone: "stop", label: "Do not go", leaveAt: null };
  if (sev >= 0.5) return better ? { tone: "wait", label: "Better to wait", leaveAt: better } : { tone: "care", label: "Go with care", leaveAt: null };
  if (hi >= 0.5) return { tone: "care", label: "Go with care", leaveAt: better };
  // The forecast looks clean, but an official severe warning on the road still deserves care.
  if (alerts.some((a) => a.severity === "Extreme" || a.severity === "Severe")) return { tone: "care", label: "Go with care", leaveAt: null };
  return { tone: "go", label: "Good to go", leaveAt: null };
}
