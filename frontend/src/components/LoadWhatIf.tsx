import type { PlanResponse } from "../types";
import { whatIf } from "../whatif";
import { toneFor } from "../verdict";

const LOADS = [20_000, 30_000, 40_000, 45_000, 60_000];

interface Props { plan: PlanResponse; onPick: (lbs: number) => void }

/** How much weight this day allows: the verdict for a few loads, worked out from the forecast already on screen. */
export default function LoadWhatIf({ plan, onPick }: Props) {
  const loads = [...new Set([...LOADS, plan.load_lbs])].sort((a, b) => a - b);
  const rows = loads.map((l) => whatIf(plan, l));
  // Only worth showing when weight changes the answer somewhere.
  const tones = new Set(rows.map((r) => toneFor(r.no, r.sev, r.hi).tone));
  const routes = new Set(rows.map((r) => r.routeId));
  if (tones.size === 1 && routes.size === 1) return null;
  return (
    <section className="whatif" aria-label="What if the load changes">
      <h3 className="head">What if the load changes?</h3>
      <ul>
        {rows.map((r) => {
          const v = toneFor(r.no, r.sev, r.hi);
          const current = r.lbs === plan.load_lbs;
          return (
            <li key={r.lbs}>
              <button className={current ? "on" : ""} onClick={() => !current && onPick(r.lbs)} aria-pressed={current}>
                <b>{r.lbs.toLocaleString()} lb</b>
                <span className={"status tone-" + v.tone}>{v.label}</span>
                <small>Route {r.routeId}{current ? ", your load" : ""}</small>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
