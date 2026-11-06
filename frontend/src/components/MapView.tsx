import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import maplibregl, { type CanvasSource, type GeoJSONSource, type Map as MLMap, type StyleSpecification } from "maplibre-gl";
import type { Checkpoint, HeatmapResponse, LayerKey, PlanResponse, Route, WeatherAlert } from "../types";
import { heatColor, LEVELS, layerLevel, levelColor } from "../risk";
import { fmtTime } from "../format";
import { createWindFlow } from "../windFlow";

export type Basemap = "streets" | "dark" | "satellite";
export const BASEMAPS: { id: Basemap; label: string }[] = [
  { id: "streets", label: "Streets" }, { id: "satellite", label: "Satellite" }, { id: "dark", label: "Dark" },
];

const URLS = {
  streets: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
};
let satellite: Promise<StyleSpecification> | undefined;
/** USGS imagery (free, no key, US coverage) under the place and road labels of the dark CARTO style. */
function satelliteStyle() {
  satellite ??= fetch(URLS.dark).then((r) => r.json()).then((st: StyleSpecification) => ({
    ...st,
    sources: {
      ...st.sources,
      sat: {
        type: "raster", tileSize: 256, maxzoom: 16, attribution: "Imagery: USGS The National Map",
        tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"],
      },
    },
    layers: [{ id: "sat", type: "raster", source: "sat" }, ...st.layers.filter((l) => l.type === "symbol")],
  }));
  satellite.catch(() => { satellite = undefined; }); // retry on the next switch
  return satellite;
}
const resolveStyle = (b: Basemap): Promise<string | StyleSpecification> => (b === "satellite" ? satelliteStyle() : Promise.resolve(URLS[b]));

// Unselected route line colours that stay readable on each basemap.
const IDLE: Record<Basemap, [string, string]> = { streets: ["#5a6571", "#2b343d"], dark: ["#8a96a3", "#c3ccd5"], satellite: ["#e4eaf0", "#ffffff"] };

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const US: maplibregl.LngLatBoundsLike = [[-125, 24], [-66.5, 49.5]];
const HEAT_SCALE = 10; // heat canvas is cols*10 by rows*10 so the GPU has real pixels to blend

export interface MapHandle { setHover: (c: Checkpoint | null) => void; setHeat: (hour: number, layer: LayerKey, playing: boolean) => void; setFollow: (on: boolean) => void }
interface Props {
  plan: PlanResponse | null; selected: string; onSelect: (id: string) => void;
  preview: { from: [number, number]; to: [number, number] } | null; alerts: WeatherAlert[]; heat: HeatmapResponse | null; ends: { from: string; to: string }; basemap: Basemap; layer: LayerKey;
}

const dot = (cls: string, text = "") => {
  const el = document.createElement("div");
  el.className = cls; el.textContent = text;
  return el;
};

/** Position of the truck `sec` seconds after departure, interpolated along the route track. */
function truckAt(route: Route, sec: number): [number, number] {
  const t = route.track;
  if (!t.length) return [route.geometry[0][0], route.geometry[0][1]];
  if (sec <= t[0][2]) return [t[0][1], t[0][0]];
  if (sec >= t[t.length - 1][2]) return [t[t.length - 1][1], t[t.length - 1][0]];
  let lo = 0, hi = t.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m][2] <= sec) lo = m; else hi = m; }
  const f = (sec - t[lo][2]) / (t[hi][2] - t[lo][2] || 1);
  return [t[lo][1] + (t[hi][1] - t[lo][1]) * f, t[lo][0] + (t[hi][0] - t[lo][0]) * f];
}

/** Colour stops along the route for the layer on show (overall risk, or only wind, rain or snow). */
function gradient(r: Route, layer: LayerKey): maplibregl.ExpressionSpecification {
  const stops: (number | string)[] = [];
  let prev = -1;
  for (const c of r.checkpoints) {
    const p = Math.min(1, Math.max(0, c.progress));
    if (p > prev + 1e-6) { stops.push(p, levelColor(layerLevel(c, layer))); prev = p; }
  }
  if (stops.length < 4) { // a one-checkpoint route still needs a valid ramp
    const color = stops.length ? stops[1] : levelColor(0);
    return ["interpolate", ["linear"], ["line-progress"], 0, color, 1, color] as maplibregl.ExpressionSpecification;
  }
  return ["interpolate", ["linear"], ["line-progress"], ...stops] as maplibregl.ExpressionSpecification;
}

const MapView = forwardRef<MapHandle, Props>(function MapView({ preview, alerts, plan, selected, onSelect, heat, ends, basemap, layer }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap>();
  const [ready, setReady] = useState(false);
  const markers = useRef<maplibregl.Marker[]>([]);
  const trucks = useRef<Record<string, maplibregl.Marker>>({});
  const heatState = useRef<{ canvas: HTMLCanvasElement; small: HTMLCanvasElement; data: HeatmapResponse } | null>(null);
  const planRef = useRef(plan);
  planRef.current = plan;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const base = useRef(basemap);
  const flow = useRef<ReturnType<typeof createWindFlow>>();
  const follow = useRef(false);
  const followZoom = useRef(6.5);
  const selRef = useRef(selected);
  selRef.current = selected;
  const lastSec = useRef(0);
  const layerRef = useRef(layer);
  layerRef.current = layer;
  const fitted = useRef<PlanResponse | null>(null);

  useImperativeHandle(ref, () => ({
    /** Highlight a checkpoint from the list. Goes straight to the map so hovering never re-renders React. */
    setHover(c) {
      const m = map.current;
      const src = m?.getStyle() && (m.getSource("hl") as GeoJSONSource | undefined);
      if (!src) return;
      src.setData(c ? { type: "Feature", properties: { color: levelColor(layerLevel(c, layerRef.current)) }, geometry: { type: "Point", coordinates: [c.lon, c.lat] } } : EMPTY);
    },
    setHeat(hour, layer, playing) {
      const m = map.current, hs = heatState.current, p = planRef.current;
      if (!m || !hs || !p) return;
      const { data, canvas, small } = hs;
      const h0 = Math.max(0, Math.min(48, Math.floor(hour))), h1 = Math.min(48, h0 + 1), f = hour - h0;
      const a = data.layers[layer][h0], b = data.layers[layer][h1];
      const sctx = small.getContext("2d")!;
      const img = sctx.createImageData(small.width, small.height);
      data.grid.cells.forEach((cell, k) => {
        const [r, g, bl, al] = heatColor(layer, a[k] + (b[k] - a[k]) * f);
        img.data.set([r, g, bl, al], cell * 4);
      });
      sctx.putImageData(img, 0, 0);
      // Blow the coarse grid up with smoothing so it reads as weather, not as squares.
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.filter = `blur(${HEAT_SCALE * 0.55}px)`;
      ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
      ctx.filter = "none";
      const src = m.getSource("heat") as CanvasSource | undefined;
      if (src) { src.play(); m.triggerRepaint(); if (!playing) m.once("render", () => src.pause()); }
      const sec = data.hours[0] - p.departure_ts + hour * 3600;
      for (const r of p.routes) trucks.current[r.id]?.setLngLat(truckAt(r, sec));
      lastSec.current = sec;
      flow.current?.setHour(hour);
      if (follow.current) {
        const sel = p.routes.find((r) => r.id === selRef.current) ?? p.routes[0];
        const center = truckAt(sel, sec);
        const padding = { left: m.getContainer().clientWidth >= 800 ? 440 : 0, bottom: m.getContainer().clientWidth >= 800 ? 170 : 330, top: 0, right: 0 };
        const zoom = followZoom.current;
        if (playing) m.jumpTo({ center, padding, zoom }); else m.easeTo({ center, padding, zoom, duration: 250 });
      }
    },
    setFollow(on) {
      follow.current = on;
      const m = map.current, p = planRef.current;
      if (!on || !m || !p) return;
      const sel = p.routes.find((r) => r.id === selRef.current) ?? p.routes[0];
      const padding = { left: m.getContainer().clientWidth >= 800 ? 440 : 0, bottom: m.getContainer().clientWidth >= 800 ? 170 : 330, top: 0, right: 0 };
      followZoom.current = Math.max(m.getZoom(), 6.5);
      m.easeTo({ center: truckAt(sel, lastSec.current), zoom: followZoom.current, padding, duration: 700 });
    },
  }));

  // map init
  useEffect(() => {
    const m = new maplibregl.Map({
      container: box.current!, style: base.current === "streets" ? URLS.streets : URLS.dark, center: [-96, 38.5], zoom: 3.6,
      attributionControl: { compact: true }, maxPitch: 0, dragRotate: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-right");
    m.touchZoomRotate.disableRotation();
    // If the window is resized before the user moves the map, keep the trip framed.
    let touched = false;
    m.on("dragstart", () => (touched = true));
    m.on("zoomstart", (e) => { if ((e as unknown as { originalEvent?: Event }).originalEvent) touched = true; });
    const ro = new ResizeObserver(() => {
      const p = planRef.current;
      if (touched || !box.current) return;
      if (p) {
        const b = new maplibregl.LngLatBounds();
        p.routes.forEach((r) => r.geometry.forEach((c) => b.extend(c)));
        m.resize();
        m.fitBounds(b, { padding: padFor(box.current), duration: 0 });
      } else fitUS(m, box.current);
    });
    ro.observe(box.current!);
    const onStyle = () => {
      m.addSource("cps", { type: "geojson", data: EMPTY });
      m.addSource("hl", { type: "geojson", data: EMPTY });
      setReady(true);
    };
    (m as unknown as { _onStyle: () => void })._onStyle = onStyle;
    let first = true;
    m.on("style.load", () => {
      onStyle();
      if (first) { first = false; if (!planRef.current) fitUS(m, box.current!); }
    });
    // Satellite is assembled from the dark style plus USGS imagery, so it is applied after the first load.
    if (base.current === "satellite") resolveStyle("satellite").then((st) => { setReady(false); m.setStyle(st, { diff: false }); });
    map.current = m;
    flow.current = createWindFlow(m);
    if (import.meta.env.DEV) (window as unknown as { __map: MLMap }).__map = m;
    return () => { ro.disconnect(); flow.current?.destroy(); m.remove(); };
  }, []);

  // basemap switch: swap the style, then rebuild our layers on top of it
  useEffect(() => {
    const m = map.current;
    if (!m || base.current === basemap) return;
    base.current = basemap;
    setReady(false);
    resolveStyle(basemap).then((st) => { if (base.current === basemap) m.setStyle(st, { diff: false }); });
  }, [basemap]);

  // routes, markers, checkpoints for a new plan
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    markers.current.forEach((x) => x.remove());
    trucks.current = {};
    markers.current = [];
    const style = m.getStyle();
    if (!style) return;
    for (const l of style.layers) if (l.id.startsWith("rt-") || l.id.startsWith("cp") || l.id === "hl") m.removeLayer(l.id);
    for (const id of Object.keys(style.sources)) if (id.startsWith("rt-")) m.removeSource(id);
    if (!plan) return;

    for (const r of plan.routes) {
      m.addSource(`rt-${r.id}`, {
        type: "geojson", lineMetrics: true,
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: r.geometry } },
      });
    }
    for (const r of plan.routes) {
      const src = `rt-${r.id}`;
      m.addLayer({ id: `${src}-hit`, type: "line", source: src, paint: { "line-width": 18, "line-opacity": 0 } });
      m.addLayer({
        id: `${src}-case`, type: "line", source: src, layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
        paint: { "line-color": "#0b0e12", "line-width": 11, "line-opacity": 0.9 },
      });
      m.addLayer({
        id: `${src}-flat`, type: "line", source: src, layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#7c8895", "line-width": 3.5, "line-opacity": 0.95 },
      });
      m.addLayer({
        id: `${src}-grad`, type: "line", source: src, layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
        paint: { "line-width": 6.5, "line-gradient": gradient(r, layerRef.current) },
      });
      m.on("click", `${src}-hit`, () => selectRef.current(r.id));
      m.on("mouseenter", `${src}-hit`, () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", `${src}-hit`, () => (m.getCanvas().style.cursor = ""));
    }
    m.addLayer({ id: "cp-ring", type: "circle", source: "cps", paint: { "circle-radius": 6, "circle-color": "#0b0e12" } });
    m.addLayer({ id: "cp", type: "circle", source: "cps", paint: { "circle-radius": 4, "circle-color": ["get", "color"] } });
    m.addLayer({
      id: "hl", type: "circle", source: "hl",
      paint: { "circle-radius": 11, "circle-color": ["get", "color"], "circle-opacity": 0.4, "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
    });
    m.on("click", "cp", (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string | number>;
      const pop = document.createElement("div");
      pop.className = "pop";
      const t = document.createElement("b"); t.textContent = String(p.label); t.style.color = String(p.color);
      const s = document.createElement("div"); s.textContent = `Mile ${p.mile}, ${p.eta}`;
      const w = document.createElement("div"); w.textContent = String(p.wx);
      pop.append(t, s, w);
      if (p.why) { const y = document.createElement("div"); y.className = "dim"; y.textContent = String(p.why); pop.append(y); }
      new maplibregl.Popup({ offset: 10, closeButton: false }).setLngLat((f.geometry as GeoJSON.Point).coordinates as [number, number]).setDOMContent(pop).addTo(m);
    });
    m.on("mouseenter", "cp", () => (m.getCanvas().style.cursor = "pointer"));
    m.on("mouseleave", "cp", () => (m.getCanvas().style.cursor = ""));

    const any = plan.routes.find((r) => r.recommended) ?? plan.routes[0];
    const flag = (mark: string, name: string) => {
      const el = dot("flag");
      const b = document.createElement("b"); b.textContent = mark;
      const s = document.createElement("span"); s.textContent = name.split(",")[0];
      el.append(b, s);
      return el;
    };
    markers.current.push(
      new maplibregl.Marker({ element: flag("A", ends.from), anchor: "left", offset: [16, -14] }).setLngLat(any.geometry[0]).addTo(m),
      new maplibregl.Marker({ element: flag("B", ends.to), anchor: "left", offset: [16, -14] }).setLngLat(any.geometry[any.geometry.length - 1]).addTo(m),
    );
    for (const r of plan.routes) {
      const mk = new maplibregl.Marker({ element: dot("truck", r.id) }).setLngLat([r.geometry[0][0], r.geometry[0][1]]);
      mk.getElement().style.display = "none";
      mk.addTo(m);
      trucks.current[r.id] = mk;
      markers.current.push(mk);
    }
    if (fitted.current !== plan) {
      fitted.current = plan;
      const b = new maplibregl.LngLatBounds();
      plan.routes.forEach((r) => r.geometry.forEach((c) => b.extend(c)));
      m.resize();
      m.fitBounds(b, { padding: padFor(box.current!), duration: 900 });
    }
  }, [plan, ready]); // eslint-disable-line

  // selection styling, checkpoints, stop markers
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !plan || !m.getSource("cps")) return;
    const [idle, idleRec] = IDLE[basemap];
    for (const r of plan.routes) {
      const on = r.id === selected, src = `rt-${r.id}`;
      if (!m.getLayer(`${src}-grad`)) return;
      m.setLayoutProperty(`${src}-grad`, "visibility", on ? "visible" : "none");
      m.setLayoutProperty(`${src}-flat`, "visibility", on ? "none" : "visible");
      m.setLayoutProperty(`${src}-case`, "visibility", on ? "visible" : "none");
      m.setPaintProperty(`${src}-flat`, "line-width", r.recommended ? 4.5 : 3.5);
      m.setPaintProperty(`${src}-flat`, "line-color", r.recommended ? idleRec : idle);
      m.setPaintProperty(`${src}-grad`, "line-gradient", gradient(r, layer));
      if (on) { m.moveLayer(`${src}-case`, "cp-ring"); m.moveLayer(`${src}-grad`, "cp-ring"); }
    }
    const r = plan.routes.find((x) => x.id === selected) ?? plan.routes[0];
    (m.getSource("cps") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: r.checkpoints.map((c) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] },
        properties: {
          color: levelColor(layerLevel(c, layer)), label: layer === "risk" ? c.risk.label : `${LEVELS[layerLevel(c, layer)].label} ${layer}`, mile: Math.round(c.mile), eta: fmtTime(c.eta_ts),
          wx: `${Math.round(c.weather.wind_mph)} mph wind, ${c.weather.rain_in_hr.toFixed(2)} in/hr rain, ${c.weather.snow_in_hr.toFixed(1)} in/hr snow`,
          why: c.risk.reasons.join(", "),
        },
      })),
    });
    const stops = r.stops.map((s) => {
      const el = dot("stop " + s.kind, s.kind === "rest" ? "10h" : "30m");
      el.title = `${s.kind === "rest" ? "10 h rest" : "30 min break"} at mile ${Math.round(s.mile)}, ${fmtTime(s.start_ts)}`;
      return new maplibregl.Marker({ element: el }).setLngLat([s.lon, s.lat]).addTo(m);
    });
    return () => stops.forEach((s) => s.remove());
  }, [plan, selected, ready, basemap, layer]);

  useEffect(() => { flow.current?.setLight(basemap === "streets"); }, [basemap]);

  // wind streaks run while the Wind layer is on
  useEffect(() => { flow.current?.setActive(layer === "wind" && !!heat); }, [layer, heat]);

  // while routes load: a dashed straight line and two dots, so the map answers the moment you press the button
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const clear = () => {
      if (!m.getStyle()) return; // the map is already gone (unmount) or mid style swap
      if (m.getLayer("preview")) m.removeLayer("preview");
      if (m.getLayer("preview-dots")) m.removeLayer("preview-dots");
      if (m.getSource("preview")) m.removeSource("preview");
    };
    clear();
    if (!preview) return clear;
    m.addSource("preview", { type: "geojson", data: { type: "FeatureCollection", features: [
      { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [preview.from, preview.to] } },
      { type: "Feature", properties: {}, geometry: { type: "MultiPoint", coordinates: [preview.from, preview.to] } },
    ] } });
    m.addLayer({ id: "preview", type: "line", source: "preview", filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": "#0e1216", "line-width": 2.5, "line-dasharray": [1.5, 2] } });
    m.addLayer({ id: "preview-dots", type: "circle", source: "preview", filter: ["==", ["geometry-type"], "MultiPoint"],
      paint: { "circle-radius": 6, "circle-color": "#fff", "circle-stroke-color": "#0e1216", "circle-stroke-width": 2.5 } });
    const b = new maplibregl.LngLatBounds(preview.from, preview.from).extend(preview.to);
    m.resize();
    m.fitBounds(b, { padding: padFor(box.current!), duration: 700, maxZoom: 7 });
    return clear;
  }, [preview, ready]);

  // official alerts: a flag where each one first touches the route
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const pins = alerts.map((a) => {
      const el = dot("alertpin", "!");
      el.title = `${a.event} (${a.severity})`;
      el.style.background = a.severity === "Extreme" ? "#b388f5" : a.severity === "Severe" ? "#e5484d" : "#ee8a3c";
      return new maplibregl.Marker({ element: el }).setLngLat([a.lon, a.lat]).addTo(m);
    });
    return () => pins.forEach((p) => p.remove());
  }, [alerts, ready, basemap]);

  // heatmap canvas source
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    if (m.getLayer("heat")) m.removeLayer("heat");
    if (m.getSource("heat")) m.removeSource("heat");
    heatState.current = null;
    flow.current?.setData(null);
    Object.values(trucks.current).forEach((t) => (t.getElement().style.display = heat ? "" : "none"));
    if (!heat || !plan) return;
    const g = heat.grid;
    const small = document.createElement("canvas");
    small.width = g.cols; small.height = g.rows;
    const canvas = document.createElement("canvas");
    canvas.width = g.cols * HEAT_SCALE; canvas.height = g.rows * HEAT_SCALE;
    m.addSource("heat", {
      type: "canvas", canvas, animate: false,
      coordinates: [[g.west, g.north], [g.east, g.north], [g.east, g.south], [g.west, g.south]],
    });
    m.addLayer({ id: "heat", type: "raster", source: "heat", paint: { "raster-resampling": "linear", "raster-opacity": 0.78, "raster-fade-duration": 0 } }, "rt-" + plan.routes[0].id + "-hit");
    heatState.current = { canvas, small, data: heat };
    flow.current?.setData(heat);
  }, [heat, plan, ready]);

  return <div ref={box} className="map" role="region" aria-label="Map of the routes and weather" />;
});

function padFor(el: HTMLElement) {
  const w = el.clientWidth, h = el.clientHeight;
  return w < 800
    ? { top: 235, bottom: 170, left: 30, right: 100 }
    : { top: 60, bottom: 200, left: Math.min(450, w * 0.4), right: 70 };
}
function fitUS(m: MLMap, el: HTMLElement) {
  m.resize();
  m.fitBounds(US, { padding: padFor(el), duration: 0 });
}

export default MapView;
