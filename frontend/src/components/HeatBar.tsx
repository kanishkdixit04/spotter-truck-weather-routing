import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Loader2, LocateFixed, Pause, Play } from "lucide-react";
import type { HeatmapResponse, LayerKey, Route } from "../types";
import { truckStatus } from "../truck";
import { LAYER_STOPS, LAYER_UNIT, LEVELS, levelColor, rampPos } from "../risk";
import { fmtDay, fmtTime } from "../format";

const LAYERS: [LayerKey, string][] = [["risk", "Risk"], ["wind", "Wind"], ["rain", "Rain"], ["snow", "Snow"]];
const HOURS_PER_SECOND = 3;
const TICKS = [0, 12, 24, 36, 48];

/** What the selected route's truck is doing and driving through at the scrubbed time. */
function TruckLine({ route, ts }: { route: Route; ts: number }) {
  const t = truckStatus(route, ts);
  const live = t.phase === "driving";
  return (
    <p className="truckline" aria-live="off">
      <b>Truck {route.id}</b>
      <span>{t.label}</span>
      {t.phase !== "waiting" && <span>mile {Math.round(t.mile)}</span>}
      {live && <span><i className="sw" style={{ background: levelColor(t.level) }} />{Math.round(t.wind)} mph wind{t.rain > 0 ? `, ${t.rain.toFixed(2)} rain` : ""}{t.snow > 0 ? `, ${t.snow.toFixed(1)} snow` : ""}</span>}
    </p>
  );
}

interface Props {
  heat: HeatmapResponse | null; loading: boolean; error: string;
  onFrame: (hour: number, layer: LayerKey, playing: boolean) => void;
  onLayer: (layer: LayerKey) => void; onFollow: (on: boolean) => void; route: Route | null;
}

export interface HeatBarHandle { toggle: () => void; nudge: (hours: number) => void; cycleLayer: (step: number) => void }

const HeatBar = forwardRef<HeatBarHandle, Props>(function HeatBar({ heat, loading, error, onFrame, onLayer, onFollow, route }, ref) {
  const [hour, setHour] = useState(0);
  const [layer, setLayer] = useState<LayerKey>("risk");
  const [playing, setPlaying] = useState(false);
  const [follow, setFollow] = useState(false);
  const state = useRef({ hour: 0, layer: "risk" as LayerKey });

  const push = useCallback((h: number, l: LayerKey, p: boolean) => {
    state.current = { hour: h, layer: l };
    setHour(h);
    onFrame(h, l, p);
  }, [onFrame]);

  useImperativeHandle(ref, () => ({
    toggle() { if (heat) setPlaying((p) => !p); },
    nudge(hours) { if (!heat) return; setPlaying(false); push(Math.max(0, Math.min(48, state.current.hour + hours)), state.current.layer, false); },
    cycleLayer(step) {
      if (!heat) return;
      const i = LAYERS.findIndex(([k]) => k === state.current.layer);
      const next = LAYERS[(i + step + LAYERS.length) % LAYERS.length][0];
      setLayer(next); onLayer(next); push(state.current.hour, next, false);
    },
  }), [heat, push, onLayer]);

  useEffect(() => { setPlaying(false); setFollow(false); onFollow(false); if (heat) push(0, state.current.layer, false); }, [heat]); // eslint-disable-line

  useEffect(() => {
    if (!playing || !heat) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const next = state.current.hour + ((now - last) / 1000) * HOURS_PER_SECOND;
      last = now;
      push(next >= 48 ? 0 : next, state.current.layer, true);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); onFrame(state.current.hour, state.current.layer, false); };
  }, [playing, heat, push, onFrame]);

  // Worst value anywhere on the corridor for each forecast hour: the shape of the next 48 hours.
  const worst = useMemo(() => {
    if (!heat) return [];
    return heat.layers[layer].map((row) => rampPos(layer, Math.max(...row)));
  }, [heat, layer]);

  const stops = LAYER_STOPS[layer], unit = LAYER_UNIT[layer];
  const disabled = !heat;
  const msg = error || (loading ? "Loading 48 hour forecast" : disabled ? "Compare a trip to see the forecast" : "");

  return (
    <section className="timeline" aria-label="Weather forecast along the corridor">
      <button className="play" disabled={disabled} aria-label={playing ? "Pause forecast" : "Play forecast"} onClick={() => setPlaying((p) => !p)}>
        {loading ? <Loader2 className="spin" size={18} /> : playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>

      <div className="readout">
        {msg ? <b className="msg">{msg}</b> : <><b>{fmtTime(heat!.hours[0] + hour * 3600)}</b><span>+{hour.toFixed(1)} h</span></>}
      </div>

      {heat && route && <TruckLine route={route} ts={heat.hours[0] + hour * 3600} />}

      <button className={"follow" + (follow ? " on" : "")} aria-pressed={follow} aria-label="Follow truck" disabled={disabled}
              onClick={() => { setFollow(!follow); onFollow(!follow); }}>
        <LocateFixed size={15} aria-hidden /> <span className="flabel">Follow truck</span>
      </button>

      <div className="layers" role="radiogroup" aria-label="Heatmap layer">
        {LAYERS.map(([k, n]) => (
          <button key={k} role="radio" aria-checked={layer === k} className={layer === k ? "on" : ""} disabled={disabled}
                  onClick={() => { setLayer(k); onLayer(k); push(state.current.hour, k, false); }}>{n}</button>
        ))}
      </div>

      <div className="track">
        <div className="bars" aria-hidden>
          {worst.map((p, i) => (
            <i key={i} style={{ height: `${12 + (p / 4) * 88}%`, background: levelColor(p), opacity: i === Math.floor(hour) ? 1 : 0.55 }} />
          ))}
        </div>
        <input type="range" min={0} max={48} step={0.05} value={hour} disabled={disabled} aria-label="Forecast hour, 0 to 48"
               aria-valuetext={heat ? fmtTime(heat.hours[0] + hour * 3600) : undefined}
               onChange={(e) => { setPlaying(false); push(Number(e.target.value), layer, false); }} />
        <div className="ticks" aria-hidden>
          {TICKS.map((h) => <span key={h} style={{ left: `${(h / 48) * 100}%` }}>{heat ? fmtDay(heat.hours[0] + h * 3600) : `+${h}h`}</span>)}
        </div>
      </div>

      <div className="scale" aria-label="Legend">
        {LEVELS.map((l, i) => (
          <span key={l.key}><i className="sw" style={{ background: l.color }} />{l.label}
            {layer !== "risk" && <small>{i === 0 ? `<${stops[1]}` : `${stops[i]}+`}</small>}</span>
        ))}
        {unit && <em>{unit}</em>}
      </div>
    </section>
  );
});

export default HeatBar;
