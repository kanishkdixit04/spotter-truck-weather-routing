import type { DepartureOption, DeparturesResponse } from "../types";
import { LEVELS } from "../risk";
import { fmtDay, fmtTime } from "../format";
import { departureScore } from "../verdict";

const worstColor = (o: DepartureOption) =>
  o.no_travel_mi > 0 ? LEVELS[4].color : o.severe_mi > 0 ? LEVELS[3].color : o.high_mi > 0 ? LEVELS[2].color : o.max_level >= 1 ? LEVELS[1].color : LEVELS[0].color;
const score = departureScore;

/** One plain sentence on what leaving at the best time changes. */
function insight(now: DepartureOption, best: DepartureOption): string {
  if (best.offset_h === 0) return "Leaving now is the best time in the next 36 hours.";
  const when = fmtTime(best.depart_ts);
  const pairs: [string, number, number][] = [
    ["No Travel", now.no_travel_mi, best.no_travel_mi], ["Severe", now.severe_mi, best.severe_mi], ["High risk", now.high_mi, best.high_mi],
  ];
  const hit = pairs.find(([, a, b]) => Math.round(a) !== Math.round(b));
  if (hit) return `Leave ${when} and ${hit[0]} miles drop from ${Math.round(hit[1])} to ${Math.round(hit[2])}.`;
  return `Leave ${when} for slightly calmer weather overall.`;
}

interface Props {
  data: DeparturesResponse;
  currentTs: number; onPick: (ts: number) => void;
}

export default function DepartureAdvisor({ data, currentTs, onPick }: Props) {
  const opts = data.options;
  const now = opts[0];
  const best = opts.find((o) => o.offset_h === data.best_offset_h) ?? now;
  const top = Math.max(1, ...opts.map(score));
  return (
    <section className="advisor" aria-label="Best time to leave">
      <h3 className="head">Best time to leave</h3>
      <p className="why">{insight(now, best)}</p>
      <div className="adv-bars" role="group" aria-label="Departure options">
        {opts.map((o, k) => {
          const isNow = Math.abs(o.depart_ts - currentTs) < 1800;
          const isBest = o.offset_h === data.best_offset_h;
          return (
            <button key={o.offset_h} className={"adv" + (isNow ? " now" : "") + (isBest ? " best" : "")}
                    aria-label={`Leave ${fmtTime(o.depart_ts)}: ${Math.round(o.severe_mi + o.no_travel_mi)} severe miles, ${Math.round(o.high_mi)} high miles${isBest ? ", best option" : ""}`}
                    aria-pressed={isNow} onClick={() => onPick(o.depart_ts)} title={fmtTime(o.depart_ts)} style={{ ["--k" as string]: k }}>
              <i style={{ height: `${18 + (score(o) / top) * 82}%`, background: worstColor(o) }} />
              {isBest && <b aria-hidden>Best</b>}
            </button>
          );
        })}
      </div>
      <div className="adv-ticks" aria-hidden>
        {opts.filter((_, i) => i % 3 === 0).map((o) => <span key={o.offset_h}>{o.offset_h === 0 ? "Now" : fmtDay(o.depart_ts)}</span>)}
      </div>
    </section>
  );
}
