import type { PlanResponse, Route } from "../types";
import { fmtDur } from "../format";

interface Row { key: string; label: string; value: (r: Route) => number; show: (v: number) => string }

// Same order as the recommendation rule in the brief. No Travel comes first because it is worse than Severe.
const ROWS: Row[] = [
  { key: "no_travel_miles", label: "No Travel miles", value: (r) => r.summary.miles_by_level.no_travel, show: (v) => `${Math.round(v)} mi` },
  { key: "severe_miles", label: "Severe miles", value: (r) => r.summary.miles_by_level.severe, show: (v) => `${Math.round(v)} mi` },
  { key: "high_miles", label: "High miles", value: (r) => r.summary.miles_by_level.high, show: (v) => `${Math.round(v)} mi` },
  { key: "avg_risk", label: "Average risk", value: (r) => r.summary.avg_risk, show: (v) => v.toFixed(2) },
  { key: "travel_time_s", label: "Travel time", value: (r) => r.travel_time_s, show: (v) => fmtDur(v) },
];
// The server compares at this resolution, so a 0.04 mile gap is a tie, not a win.
const STEP: Record<string, number> = { no_travel_miles: 0.1, severe_miles: 0.1, high_miles: 0.1, avg_risk: 0.01, travel_time_s: 1 };

/** The ranking behind the recommendation, row by row, so the choice can be checked. */
export default function WhyThis({ plan }: { plan: PlanResponse }) {
  const rec = plan.recommendation;
  const routes = [...plan.routes].sort((a, b) => a.id.localeCompare(b.id));
  const q = (key: string, v: number) => Math.round(v / STEP[key]);
  return (
    <details className="why-this">
      <summary>Why Route {rec.route_id}?</summary>
      <p className="why-lead">Routes are compared one rule at a time, in this order. The first rule where they differ decides.</p>
      <table>
        <thead><tr><th scope="col">Rule</th>{routes.map((r) => <th scope="col" key={r.id}>{r.id}</th>)}</tr></thead>
        <tbody>
          {ROWS.map((row) => {
            const vals = routes.map((r) => q(row.key, row.value(r)));
            const best = Math.min(...vals);
            const tie = vals.every((v) => v === best);
            const decided = rec.decided_by === row.key;
            return (
              <tr key={row.key} className={decided ? "decided" : ""}>
                <th scope="row">{row.label}{decided && <em>decides</em>}</th>
                {routes.map((r, i) => (
                  <td key={r.id} className={!tie && vals[i] === best ? "win" : tie ? "tie" : ""}>{row.show(row.value(r))}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="note">Bold is the best value in a row. Greyed rows are ties, so the next rule decides.</p>
    </details>
  );
}
