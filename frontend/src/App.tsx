import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { Basemap, MapHandle } from "./components/MapView";
// MapLibre is most of the bundle: load it in parallel with the UI instead of before it.
const MapView = lazy(() => import("./components/MapView"));

const BASEMAPS: { id: Basemap; label: string }[] = [
  { id: "streets", label: "Streets" }, { id: "satellite", label: "Satellite" }, { id: "dark", label: "Dark" },
];
function savedBasemap(): Basemap {
  try {
    const v = localStorage.getItem("basemap");
    if (v === "streets" || v === "dark" || v === "satellite") return v;
  } catch { /* storage blocked: use the default */ }
  return "streets";
}
import TripForm, { type FormState } from "./components/TripForm";
import Results from "./components/Results";
import HeatBar, { type HeatBarHandle } from "./components/HeatBar";
import ShortcutHelp from "./components/ShortcutHelp";
import Loading from "./components/Loading";
import { ApiError, getAlerts, getHeatmap, getRoutes, planTrip } from "./api";
import RetryCountdown from "./components/RetryCountdown";
import DepartureAdvisor from "./components/DepartureAdvisor";
import { defaultDeparture, fmtDur, fmtTime, toIsoWithOffset, toLocalInput } from "./format";
import { decide } from "./verdict";
import type { Checkpoint, RoutePreview, WeatherAlert, HeatmapResponse, LayerKey, Place, PlanResponse } from "./types";

// Shareable URL: ?o=lat,lon,label&d=lat,lon,label&dep=...&w=...&i=...&h=0|1
const enc = (p: Place) => `${p.lat},${p.lon},${p.label}`;
function dec(s: string | null): Place | null {
  if (!s) return null;
  const [lat, lon, ...rest] = s.split(",");
  const a = Number(lat), b = Number(lon);
  return Number.isFinite(a) && Number.isFinite(b) ? { lat: a, lon: b, label: rest.join(",") } : null;
}
/** Shown to first-time visitors so the page proves itself before they type anything. */
const SAMPLE = {
  origin: { label: "Seattle, Washington", lat: 47.6062, lon: -122.3321 },
  destination: { label: "Salt Lake City, Utah", lat: 40.7608, lon: -111.891 },
};
const hasTripInUrl = () => new URLSearchParams(location.search).has("o");
function fromUrl(): FormState {
  const q = new URLSearchParams(location.search);
  if (!hasTripInUrl()) {
    return { ...SAMPLE, departure: defaultDeparture(), load: 42000, interval: 25, hos: true };
  }
  const i = Number(q.get("i"));
  return {
    origin: dec(q.get("o")), destination: dec(q.get("d")),
    departure: q.get("dep") || defaultDeparture(),
    load: q.has("w") ? Number(q.get("w")) || 0 : 30000,
    interval: i === 10 || i === 50 ? i : 25,
    hos: q.get("h") !== "0",
  };
}

export default function App() {
  const [form, setForm] = useState<FormState>(fromUrl);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [planKey, setPlanKey] = useState(0);
  const [ends, setEnds] = useState({ from: "", to: "" });
  const [selected, setSelected] = useState("A");
  const setHover = useCallback((c: Checkpoint | null) => map.current?.setHover(c), []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false); // provider rate limit: retry automatically
  const [heat, setHeat] = useState<HeatmapResponse | null>(null);
  const [heatLoading, setHeatLoading] = useState(false);
  const [heatError, setHeatError] = useState("");
  const [preview, setPreview] = useState<{ from: [number, number]; to: [number, number] } | null>(null);
  const [draft, setDraft] = useState<RoutePreview[] | null>(null); // route lines shown before the weather is ready
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number>();
  const showToast = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3500);
  }, []);
  const [alerts, setAlerts] = useState<WeatherAlert[] | null>(null);
  const [snap, setSnap] = useState<0 | 1 | 2>(1); // phone bottom sheet: peek, half, full
  const sheet = useRef<HTMLElement>(null);
  const drag = useRef<{ y: number; h: number; t: number; moved: boolean } | null>(null);
  const heights = () => [148, window.innerHeight * 0.5, window.innerHeight * 0.9];
  const onGrabDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, h: sheet.current!.offsetHeight, t: performance.now(), moved: false };
    sheet.current!.style.transition = "none";
  };
  const onGrabMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.y - e.clientY;
    if (Math.abs(dy) > 4) d.moved = true;
    sheet.current!.style.height = `${Math.max(110, Math.min(window.innerHeight * 0.92, d.h + dy))}px`;
  };
  const onGrabUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    drag.current = null;
    const el = sheet.current!;
    el.style.transition = "";
    if (!d) return;
    const dy = d.y - e.clientY, v = dy / Math.max(1, performance.now() - d.t); // px per ms, up is positive
    const hs = heights();
    let target = d.moved ? hs.reduce((best, h, i) => (Math.abs(h - el.offsetHeight) < Math.abs(hs[best] - el.offsetHeight) ? i : best), 0) : -1;
    if (d.moved && Math.abs(v) > 0.5) target = Math.max(0, Math.min(2, (hs.findIndex((h) => h >= d.h - 4) === -1 ? 2 : hs.findIndex((h) => h >= d.h - 4)) + (v > 0 ? 1 : -1)));
    el.style.height = "";
    setSnap(target === -1 ? (((snap + 1) % 3) as 0 | 1 | 2) : (target as 0 | 1 | 2));
  };
  const [layer, setLayer] = useState<LayerKey>("risk");
  const [sample, setSample] = useState(!hasTripInUrl());
  const [formKey, setFormKey] = useState(0); // bumping it empties the From and To boxes
  const [basemap, setBasemap] = useState<Basemap>(savedBasemap);
  const pickBasemap = (b: Basemap) => {
    setBasemap(b);
    try { localStorage.setItem("basemap", b); } catch { /* ignore */ }
  };
  const map = useRef<MapHandle>(null);
  const heatBar = useRef<HeatBarHandle>(null);
  const [help, setHelp] = useState(false);
  const run = useRef(0);

  const submit = useCallback(async (f: FormState) => {
    if (!f.origin || !f.destination) return;
    const id = ++run.current;
    setPreview({ from: [f.origin.lon, f.origin.lat], to: [f.destination.lon, f.destination.lat] });
    setLoading(true); setError(""); setBusy(false); setHeat(null); setHeatError(""); setAlerts(null);
    const q = new URLSearchParams({
      o: enc(f.origin), d: enc(f.destination), dep: f.departure, w: String(f.load), i: String(f.interval), h: f.hos ? "1" : "0",
    });
    history.replaceState(null, "", `?${q}`);
    const input = {
      origin: f.origin, destination: f.destination, departure: toIsoWithOffset(f.departure),
      load_lbs: f.load, interval_mi: f.interval, hos: f.hos,
    };
    try {
      // Lines first (about a second), weather after: the map answers quickly and the wait feels shorter.
      const pre = await getRoutes(input).catch(() => null);
      if (id !== run.current) return;
      if (pre) setDraft(pre.routes);
      const p = await planTrip(input);
      if (id !== run.current) return;
      setPreview(null);
      setDraft(null);
      setEnds({ from: f.origin.label, to: f.destination.label });
      setPlan(p);
      if (window.innerWidth < 800) setSnap(0); // phones: show the map first, the answer sits in the peek bar
      setPlanKey((k) => k + 1);
      setSelected(p.recommendation.route_id);
      setLoading(false);
      setHeatLoading(true);
      getHeatmap(p)
        .then((h) => id === run.current && setHeat(h))
        .catch((e) => id === run.current && setHeatError(e.message))
        .finally(() => id === run.current && setHeatLoading(false));
      // Official alerts for the recommended route, checked about every 80 miles.
      const rec = p.routes.find((r) => r.id === p.recommendation.route_id) ?? p.routes[0];
      const every = Math.max(1, Math.round(80 / p.interval_mi));
      const pts = rec.checkpoints.filter((_, i) => i % every === 0 || i === rec.checkpoints.length - 1).slice(0, 16)
        .map((c) => ({ lat: c.lat, lon: c.lon, mile: c.mile }));
      getAlerts(pts).then((a) => id === run.current && setAlerts(a.alerts)).catch(() => id === run.current && setAlerts([]));

    } catch (e) {
      if (id !== run.current) return;
      setPreview(null);
      setDraft(null);
      setError((e as Error).message);
      setBusy(e instanceof ApiError && e.status === 503);
      setLoading(false);
    }
  }, []);

  // Open a shared link, or show the sample trip, straight away.
  useEffect(() => {
    if (form.origin && form.destination) submit(form);
  }, []); // eslint-disable-line

  const editForm = (f: FormState) => {
    if (sample && (f.origin !== form.origin || f.destination !== form.destination)) setSample(false);
    setForm(f);
  };
  const leaveAt = (ts: number) => {
    const f = { ...form, departure: toLocalInput(ts) };
    setForm(f);
    submit(f);
  };
  const changeLoad = (lbs: number) => {
    const f = { ...form, load: lbs };
    setForm(f);
    submit(f);
  };
  const startOwn = () => {
    setSample(false);
    setForm({ ...form, origin: null, destination: null });
    setFormKey((k) => k + 1);
    window.setTimeout(() => document.querySelector<HTMLInputElement>(".place input")?.focus(), 0); // after the boxes remount
  };

  // Keyboard shortcuts, ignored while typing in a field.
  const planRef = useRef(plan);
  planRef.current = plan;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      if (e.key === " " && t.tagName === "BUTTON") return; // let a focused button handle its own press
      const k = e.key.toLowerCase();
      const route = planRef.current?.routes.find((r) => r.id.toLowerCase() === k);
      if (e.key === " ") { e.preventDefault(); heatBar.current?.toggle(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); heatBar.current?.nudge(e.shiftKey ? 6 : 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); heatBar.current?.nudge(e.shiftKey ? -6 : -1); }
      else if (e.key === "]") heatBar.current?.cycleLayer(1);
      else if (e.key === "[") heatBar.current?.cycleLayer(-1);
      else if (e.key === "?") setHelp(true);
      else if (e.key === "/") { e.preventDefault(); document.querySelector<HTMLInputElement>(".place input")?.focus(); }
      else if (route) setSelected(route.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onFrame = useCallback((h: number, l: LayerKey, p: boolean) => map.current?.setHeat(h, l, p), []);

  const recRoute = plan?.routes.find((r) => r.id === plan.recommendation.route_id) ?? plan?.routes[0];
  const peek = recRoute ? decide(recRoute, plan?.departures ?? null, alerts ?? []) : { tone: "go", label: "" };

  // The tab title carries the answer, so it is useful in a tab strip and in history.
  useEffect(() => {
    document.title = plan && recRoute ? `${ends.from.split(",")[0]} to ${ends.to.split(",")[0]}: ${peek.label} | Spotter` : "Spotter | Weather-aware truck routing";
  }, [plan, recRoute, ends, peek.label]);

  return (
    <div className="app">
      <a className="skip" href="#verdict" onClick={(e) => { e.preventDefault(); document.getElementById("verdict")?.focus(); }}>Skip to the result</a>
      <Suspense fallback={<div className="map map-wait" aria-hidden />}>
        <MapView ref={map} preview={preview} draft={draft} alerts={alerts ?? []} plan={plan} selected={selected} onSelect={setSelected} heat={heat} ends={ends} basemap={basemap} layer={layer} />
      </Suspense>
      <section className="basemap" aria-label="Map style">
        <button className="helpbtn" aria-label="Keyboard shortcuts" onClick={() => setHelp(true)}>?</button>
        <div role="radiogroup" aria-label="Map style">
          {BASEMAPS.map((b) => (
            <button key={b.id} role="radio" aria-checked={basemap === b.id} className={basemap === b.id ? "on" : ""} onClick={() => pickBasemap(b.id)}>{b.label}</button>
          ))}
        </div>
      </section>
      <aside className="panel" data-snap={snap} ref={sheet}>
        <button className="grab" aria-label="Resize panel: drag, or press Enter to cycle" onPointerDown={onGrabDown} onPointerMove={onGrabMove} onPointerUp={onGrabUp}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSnap(((snap + 1) % 3) as 0 | 1 | 2); } }}>
          <i className="bar" aria-hidden />
        </button>
        <div className="peek" onClick={() => setSnap(1)}>
          {plan ? (
            <>
              <span className={"status tone-" + peek.tone}>{peek.label}</span>
              <span>Route {plan.recommendation.route_id}, {fmtDur(recRoute!.travel_time_s)}, arrive {fmtTime(recRoute!.arrival_ts)}</span>
            </>
          ) : <span>Pick a start and an end to compare routes</span>}
        </div>
        <div className="scroll">
          <header className="brand">
            <h1>Spotter</h1>
            <p>Truck routes ranked by weather</p>
          </header>
          {sample && (
            <p className="sample" role="note">
              <span>Sample trip, live forecast.</span>
              <button className="link" onClick={startOwn}>Plan your own</button>
            </p>
          )}
          <TripForm key={formKey} form={form} set={editForm} loading={loading} onSubmit={() => { setSample(false); submit(form); setSnap((s) => (s === 0 ? 1 : s)); }} />
          {error && (
            <div className="error" role="alert">
              <TriangleAlert size={16} aria-hidden />
              <div><b>Could not compare routes</b><p>{error}</p>{busy ? <RetryCountdown seconds={45} onRetry={() => submit(form)} /> : <button className="link" onClick={() => submit(form)}>Try again</button>}</div>
            </div>
          )}
          {loading && <Loading routesReady={!!draft} />}
          {plan && !loading && (
            <Results key={planKey} plan={plan} layer={layer} selected={selected} onSelect={setSelected} onHover={setHover}
                     deps={plan.departures} alerts={alerts} ends={ends} onToast={showToast} onLoad={changeLoad} onLeaveAt={leaveAt}
                     advisor={<DepartureAdvisor data={plan.departures} currentTs={plan.departure_ts} onPick={leaveAt} />} />
          )}
        </div>
      </aside>
      <div className={"toast" + (toast ? " show" : "")} role="status" aria-live="polite">{toast}</div>
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      <HeatBar ref={heatBar} heat={heat} loading={heatLoading} error={heatError} onFrame={onFrame} onLayer={setLayer} onFollow={(on) => map.current?.setFollow(on)}
               route={plan?.routes.find((r) => r.id === selected) ?? null} />
    </div>
  );
}
