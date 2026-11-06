import { useState } from "react";
import type { LayerKey, PlanResponse, Route } from "../types";
import { LAYER_STOPS, LAYER_UNIT, LEVELS } from "../risk";

const W = 380, H = 132, PAD = { l: 34, r: 12, t: 10, b: 20 };
const NAME: Record<LayerKey, string> = { risk: "Risk level", wind: "Wind", rain: "Rain", snow: "Snow" };

const value = (c: Route["checkpoints"][number], layer: LayerKey) =>
  layer === "risk" ? c.risk.level : layer === "wind" ? c.weather.wind_mph : layer === "rain" ? c.weather.rain_in_hr : c.weather.snow_in_hr;

/** Value of a route at a given mile, interpolated between its checkpoints. */
function at(route: Route, layer: LayerKey, mile: number): number {
  const c = route.checkpoints;
  if (mile <= c[0].mile) return value(c[0], layer);
  for (let i = 1; i < c.length; i++) {
    if (mile <= c[i].mile) {
      const f = (mile - c[i - 1].mile) / (c[i].mile - c[i - 1].mile || 1);
      return value(c[i - 1], layer) + (value(c[i], layer) - value(c[i - 1], layer)) * f;
    }
  }
  return value(c[c.length - 1], layer);
}

const fmt = (v: number, layer: LayerKey) =>
  layer === "risk" ? LEVELS[Math.round(v)].label : layer === "wind" ? `${Math.round(v)} mph` : `${v.toFixed(layer === "rain" ? 2 : 1)} in/hr`;

interface Props { plan: PlanResponse; layer: LayerKey; selected: string; onSelect: (id: string) => void }

/** The weather each truck meets, mile by mile, for all three routes on one set of axes. */
export default function RouteProfile({ plan, layer, selected, onSelect }: Props) {
  const [hoverMile, setHoverMile] = useState<number | null>(null);
  const maxMile = Math.max(...plan.routes.map((r) => r.distance_mi));
  const stops = LAYER_STOPS[layer];
  const peak = Math.max(...plan.routes.flatMap((r) => r.checkpoints.map((c) => value(c, layer))));
  const top = Math.max(stops[2] * 1.25, peak * 1.1, layer === "risk" ? 4 : 0.0001);
  const x = (m: number) => PAD.l + (m / maxMile) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - Math.min(v, top) / top) * (H - PAD.t - PAD.b);

  const bands = [1, 2, 3, 4].map((lvl) => ({ lvl, y1: y(stops[lvl]), y2: lvl === 4 ? y(top) : y(stops[lvl + 1]) }))
    .filter((b) => stops[b.lvl] < top);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHoverMile(Math.max(0, Math.min(maxMile, ((px - PAD.l) / (W - PAD.l - PAD.r)) * maxMile)));
  };

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round((f * maxMile) / 10) * 10);
  const lines = [...plan.routes].sort((a, b) => (a.id === selected ? 1 : 0) - (b.id === selected ? 1 : 0));

  return (
    <section className="profile" aria-label={`${NAME[layer]} along each route`} style={{ ["--i" as string]: 3 }}>
      <h3 className="head">{NAME[layer]} along the road</h3>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Chart of ${NAME[layer].toLowerCase()} by mile for routes A, B and C`}
           onPointerMove={onMove} onPointerLeave={() => setHoverMile(null)}>
        {bands.map((b) => (
          <rect key={b.lvl} x={PAD.l} width={W - PAD.l - PAD.r} y={b.y2} height={Math.max(0, b.y1 - b.y2)} fill={LEVELS[b.lvl].color} opacity={0.13} />
        ))}
        {stops.slice(1).filter((s) => s < top).map((s, i) => (
          <g key={s}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(s)} y2={y(s)} stroke="#364351" strokeDasharray="2 3" />
            <text x={PAD.l - 4} y={y(s) + 3} textAnchor="end" className="ax">{layer === "risk" ? LEVELS[i + 1].label.slice(0, 3) : s}</text>
          </g>
        ))}
        <text x={PAD.l - 4} y={y(0) + 3} textAnchor="end" className="ax">0</text>
        {ticks.map((t) => <text key={t} x={x(t)} y={H - 5} textAnchor="middle" className="ax">{t}</text>)}
        {lines.map((r) => {
          const on = r.id === selected;
          const d = r.checkpoints.map((c, i) => `${i ? "L" : "M"}${x(c.mile).toFixed(1)} ${y(value(c, layer)).toFixed(1)}`).join("");
          const end = r.checkpoints[r.checkpoints.length - 1];
          return (
            <g key={r.id} className="pline" onClick={() => onSelect(r.id)} style={{ cursor: "pointer" }}>
              <path d={d} fill="none" stroke="transparent" strokeWidth={12} />
              <path d={d} fill="none" stroke={on ? "#e9eef3" : "#8693a0"} strokeWidth={on ? 2.2 : 1.3} strokeDasharray={on ? undefined : r.id === "B" ? "5 3" : "1 3"}
                    strokeLinejoin="round" opacity={on ? 1 : 0.85} />
              <text x={Math.min(x(end.mile) + 3, W - 8)} y={y(value(end, layer)) + 3} className="pl" fill={on ? "#e9eef3" : "#8693a0"}>{r.id}</text>
            </g>
          );
        })}
        {hoverMile !== null && <line x1={x(hoverMile)} x2={x(hoverMile)} y1={PAD.t} y2={H - PAD.b} stroke="#e9eef3" strokeWidth={1} />}
      </svg>
      <p className="readout-line" aria-live="off">
        {hoverMile === null
          ? `Hover the chart to compare routes at any mile.${LAYER_UNIT[layer] ? ` Values in ${LAYER_UNIT[layer]}.` : ""}`
          : <>Mile {Math.round(hoverMile)}: {plan.routes.filter((r) => hoverMile <= r.distance_mi).map((r) => `${r.id} ${fmt(at(r, layer, hoverMile), layer)}`).join(", ")}</>}
      </p>
    </section>
  );
}

