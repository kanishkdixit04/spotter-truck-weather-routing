import { useEffect, useRef, type ReactNode } from "react";
import type { Checkpoint, DeparturesResponse, LayerKey, PlanResponse, Route, WeatherAlert } from "../types";
import { decide } from "../verdict";
import RouteProfile from "./RouteProfile";
import Briefing from "./Briefing";
import WhyThis from "./WhyThis";
import LoadWhatIf from "./LoadWhatIf";
import { Link2, Printer } from "lucide-react";
import { LEVELS, layerLevel, levelColor } from "../risk";
import { fmtDelta, fmtDur, fmtMi, fmtTime } from "../format";

const KEYS = ["low", "moderate", "high", "severe", "no_travel"] as const;

function Swatch({ level }: { level: number }) {
  return <i className="sw" style={{ background: levelColor(level) }} aria-hidden />;
}

/** One cell per checkpoint, sized by the stretch of road it covers, coloured by its risk. */
function Ribbon({ route, layer }: { route: Route; layer: LayerKey }) {
  const c = route.checkpoints;
  const total = route.distance_mi || 1;
  const cuts = c.map((x, i) => (i === 0 ? 0 : (c[i - 1].mile + x.mile) / 2));
  cuts.push(total);
  return (
    <span className="ribbon" aria-hidden>
      {c.map((x, i) => (
        <i key={x.index} style={{ flexGrow: Math.max(cuts[i + 1] - cuts[i], 0.001), background: levelColor(layerLevel(x, layer)) }} />
      ))}
    </span>
  );
}

function riskLine(r: Route) {
  const m = r.summary.miles_by_level;
  const parts = KEYS.map((k, i) => (i > 0 && m[k] >= 1 ? `${Math.round(m[k])} mi ${LEVELS[i].label.toLowerCase()}` : "")).filter(Boolean);
  return parts.length ? parts.join(", ") : "Low risk the whole way";
}

const SEV_COLOR = { Extreme: "#b388f5", Severe: "#e5484d", Moderate: "#ee8a3c", Minor: "#e3b341" } as const;

function AlertList({ alerts, routeId }: { alerts: WeatherAlert[] | null; routeId: string }) {
  if (alerts === null) return null;
  if (alerts.length === 0) return <p className="noalerts">No active weather alerts along Route {routeId} (National Weather Service).</p>;
  return (
    <section className="alerts" aria-label="Active weather alerts">
      <h3 className="head">Official alerts on Route {routeId}</h3>
      <ul>
        {alerts.map((a) => (
          <li key={a.id}>
            <span className="sev" style={{ background: SEV_COLOR[a.severity] }}>{a.severity}</span>
            <div>
              <b>{a.event}</b>
              <small>Miles {Math.round(a.first_mile)} to {Math.round(a.last_mile)}{a.ends ? `, until ${new Date(a.ends).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}</small>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Clipboard API where allowed, the old textarea trick where a frame or policy blocks it. */
async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* fall through */ }
  const t = document.createElement("textarea");
  t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
  document.body.appendChild(t); t.select();
  const ok = document.execCommand("copy");
  t.remove();
  if (!ok) throw new Error("copy failed");
}

interface Props {
  plan: PlanResponse; layer: LayerKey; selected: string; onSelect: (id: string) => void; onHover: (c: Checkpoint | null) => void;
  onRules: () => void; onLoad: (lbs: number) => void; onToast: (message: string) => void; ends: { from: string; to: string }; deps: DeparturesResponse | null; alerts: WeatherAlert[] | null; advisor: ReactNode; onLeaveAt: (ts: number) => void;
}

export default function Results({ plan, layer, selected, onSelect, onHover, deps, alerts, advisor, onLeaveAt, onLoad, onRules, ends, onToast }: Props) {
  const top = useRef<HTMLElement>(null);
  // On phones the results sit below the form inside the sheet: bring them into view.
  useEffect(() => {
    // Scroll only the sheet's own scroller; scrollIntoView would also shift the clipped app frame.
    const el = top.current, sc = el?.closest(".scroll");
    if (window.innerWidth < 800 && el && sc) sc.scrollTo({ top: sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 8, behavior: "smooth" });
  }, []);
  const rec = plan.recommendation;
  const best = plan.routes.find((r) => r.id === rec.route_id) ?? plan.routes[0];
  const sel = plan.routes.find((r) => r.id === selected) ?? plan.routes[0];
  const ordered = [...plan.routes].sort((a, b) => a.rank - b.rank);
  const verdict = decide(best, deps, alerts ?? []);
  async function share() {
    const url = location.href;
    const title = `${ends.from.split(",")[0]} to ${ends.to.split(",")[0]}: ${verdict.label}`;
    try {
      if (navigator.share && window.matchMedia("(pointer: coarse)").matches) await navigator.share({ title, url });
      else { await copyText(url); onToast("Link copied. Anyone who opens it sees this trip."); }
    } catch (e) {
      if ((e as Error).name !== "AbortError") onToast("Couldn't copy. Copy the address bar instead.");
    }
  }
  return (
    <>
      <section ref={top} id="verdict" tabIndex={-1} className={"verdict tone-" + verdict.tone} style={{ ["--i" as string]: 0 }} aria-live="polite">
        <p className="status">{verdict.label}</p>
        <div className="vbody">
          <b className="glyph" aria-hidden>{rec.route_id}</b>
          <div>
            <h2>{rec.safe_to_travel ? `Take Route ${rec.route_id}` : `Least bad is Route ${rec.route_id}`}</h2>
            <p>{rec.reason}</p>
            {plan.warnings.map((w) => <p className="note" key={w}>{w}</p>)}
          </div>
        </div>
        {verdict.leaveAt && (
          <button className="cta" onClick={() => onLeaveAt(verdict.leaveAt!.depart_ts)}>
            Leave {fmtTime(verdict.leaveAt.depart_ts)} instead
          </button>
        )}
      </section>

      <WhyThis plan={plan} />
      <button className="link rules-link" onClick={onRules}>How is risk scored?</button>

      <AlertList alerts={alerts} routeId={rec.route_id} />
      <div className="actions">
        <button className="printbtn" onClick={share}><Link2 size={15} aria-hidden /> Share trip</button>
        <button className="printbtn" onClick={() => window.print()}><Printer size={15} aria-hidden /> Driver briefing</button>
      </div>
      <Briefing plan={plan} route={best} verdict={verdict} alerts={alerts} from={ends.from} to={ends.to} />

      {advisor}

      <LoadWhatIf plan={plan} onPick={onLoad} />

      <section className="routes" aria-label="Route options">
        <h3 className="head">Routes</h3>
        {ordered.map((r, i) => (
          <button key={r.id} className={"route" + (r.id === sel.id ? " on" : "")} style={{ ["--i" as string]: i + 1 }}
                  onClick={() => onSelect(r.id)} aria-pressed={r.id === sel.id}>
            <b className="ltr">{r.id}</b>
            <span className="name">{r.via ? `via ${r.via}` : r.name}{r.recommended && <em>Best</em>}</span>
            <span className="nums">
              <span>{fmtMi(r.distance_mi)}</span>
              <span>{fmtDur(r.travel_time_s)}</span>
              <span className="delta">{r.id === best.id ? "" : `${fmtDelta(r.travel_time_s - best.travel_time_s)} vs ${best.id}`}</span>
            </span>
            <Ribbon route={r} layer={layer} />
            <span className="sub"><span>{riskLine(r)}</span><span>Arrive {fmtTime(r.arrival_ts)}</span></span>
          </button>
        ))}
        <p className="legend">
          {LEVELS.map((l) => <span key={l.key}><i className="sw" style={{ background: l.color }} />{l.label}</span>)}
        </p>
      </section>

      <RouteProfile plan={plan} layer={layer} selected={selected} onSelect={onSelect} />

      <section className="cps" style={{ ["--i" as string]: 4 }}>
        <h3 className="head">Route {sel.id} every {plan.interval_mi} mi</h3>
        <table>
          <thead><tr><th>Mile</th><th>ETA</th><th>Wind</th><th>Rain / Snow</th><th>Risk</th></tr></thead>
          <tbody>
            {sel.checkpoints.map((c) => {
              const w = c.weather;
              const precip = [w.rain_in_hr > 0 ? `${w.rain_in_hr.toFixed(2)} r` : "", w.snow_in_hr > 0 ? `${w.snow_in_hr.toFixed(1)} s` : ""].filter(Boolean).join(" ");
              return (
                <tr key={c.index} tabIndex={0} title={c.risk.reasons.join(", ")}
                    onMouseEnter={() => onHover(c)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(c)} onBlur={() => onHover(null)}>
                  <td>{Math.round(c.mile)}</td>
                  <td>{fmtTime(c.eta_ts)}</td>
                  <td>{layer === "wind" && <Swatch level={c.risk.factors.wind} />}{Math.round(w.wind_mph)}<small> mph</small></td>
                  <td className={precip ? "" : "none"}>{(layer === "rain" || layer === "snow") && <Swatch level={c.risk.factors[layer]} />}{precip || "none"}</td>
                  <td className="rk"><Swatch level={c.risk.level} />{c.risk.label}{c.risk.reasons.length > 0 && <small>{c.risk.reasons[0]}</small>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sel.stops.length > 0 && (
          <p className="note">ETAs include {sel.stops.filter((s) => s.kind === "rest").length} rest and {sel.stops.filter((s) => s.kind === "break").length} break stops.</p>
        )}
      </section>
    </>
  );
}
