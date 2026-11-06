import type { PlanResponse, Route, WeatherAlert } from "../types";
import { fmtDur, fmtMi, fmtTime } from "../format";
import type { Verdict } from "../verdict";

interface Props { plan: PlanResponse; route: Route; verdict: Verdict; alerts: WeatherAlert[] | null; from: string; to: string }

/** A plain one-page sheet for the cab or the dispatcher. Hidden on screen, shown when printing. */
export default function Briefing({ plan, route, verdict, alerts, from, to }: Props) {
  return (
    <article className="briefing" aria-hidden>
      <h1>{from.split(",")[0]} to {to.split(",")[0]}</h1>
      <p className="meta">
        Leaves {fmtTime(plan.departure_ts)} with {plan.load_lbs.toLocaleString()} lb. Route {route.id}, {fmtMi(route.distance_mi)}, {fmtDur(route.travel_time_s)} door to door, arriving {fmtTime(route.arrival_ts)}.
      </p>
      <p className="call"><b>{verdict.label}.</b> {plan.recommendation.reason}</p>
      {verdict.leaveAt && <p>Better departure: {fmtTime(verdict.leaveAt.depart_ts)}.</p>}

      {alerts && alerts.length > 0 && (
        <>
          <h2>Weather alerts</h2>
          <ul>{alerts.map((a) => <li key={a.id}>{a.severity}: {a.event}, miles {Math.round(a.first_mile)} to {Math.round(a.last_mile)}</li>)}</ul>
        </>
      )}

      {route.stops.length > 0 && (
        <>
          <h2>Stops built into the schedule</h2>
          <ul>{route.stops.map((s, i) => <li key={i}>{s.kind === "rest" ? "10 hour rest" : "30 minute break"} at mile {Math.round(s.mile)}, from {fmtTime(s.start_ts)} to {fmtTime(s.end_ts)}</li>)}</ul>
        </>
      )}

      <h2>Weather at each checkpoint</h2>
      <table>
        <thead><tr><th>Mile</th><th>Arrive</th><th>Wind</th><th>Rain</th><th>Snow</th><th>Risk</th></tr></thead>
        <tbody>
          {route.checkpoints.map((c) => (
            <tr key={c.index}>
              <td>{Math.round(c.mile)}</td><td>{fmtTime(c.eta_ts)}</td><td>{Math.round(c.weather.wind_mph)} mph</td>
              <td>{c.weather.rain_in_hr ? c.weather.rain_in_hr.toFixed(2) : "none"}</td><td>{c.weather.snow_in_hr ? c.weather.snow_in_hr.toFixed(1) : "none"}</td>
              <td>{c.risk.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="foot">Forecast from Open-Meteo. Alerts from the National Weather Service. Planning aid only, not a substitute for your own judgement on the road.</p>
    </article>
  );
}
