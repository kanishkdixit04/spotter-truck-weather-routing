import type { Map as MLMap } from "maplibre-gl";
import type { HeatmapResponse } from "./types";

const COUNT = 700;
const MAX_AGE = 90;
export const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const lat0 = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * (180 / Math.PI);

interface Particle { lng: number; lat: number; age: number }

/**
 * Animated wind streaks (like windy.com) drawn on a canvas above the map.
 * They only live inside the forecast grid, move the way the wind blows, and speed up with wind speed.
 */
export function createWindFlow(map: MLMap) {
  const canvas = document.createElement("canvas");
  canvas.className = "windflow";
  canvas.setAttribute("aria-hidden", "true");
  map.getCanvasContainer().appendChild(canvas);
  const ctx = canvas.getContext("2d")!;

  let data: HeatmapResponse | null = null;
  let u: Float32Array[] = [], v: Float32Array[] = [];  // per hour, per cell: east / north speed in mph
  let slot = new Map<number, number>();                // flat cell index -> k
  let y0 = 0, y1 = 0;
  let hour = 0, active = false, raf = 0, light = false;
  const parts: Particle[] = [];
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = map.getContainer().clientWidth, h = map.getContainer().clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
  }

  function setData(h: HeatmapResponse | null) {
    data = h;
    parts.length = 0;
    if (!h) { u = []; v = []; slot = new Map(); return; }
    const g = h.grid;
    y0 = mercY(g.south); y1 = mercY(g.north);
    slot = new Map(g.cells.map((c, k) => [c, k]));
    u = []; v = [];
    for (let t = 0; t < h.hours.length; t++) {
      const uu = new Float32Array(g.cells.length), vv = new Float32Array(g.cells.length);
      for (let k = 0; k < g.cells.length; k++) {
        const to = ((h.wind_dir[t][k] + 180) * Math.PI) / 180; // wind blows toward the opposite of where it comes from
        const sp = h.layers.wind[t][k];
        uu[k] = Math.sin(to) * sp; vv[k] = Math.cos(to) * sp;
      }
      u.push(uu); v.push(vv);
    }
  }

  /** Wind vector at a place and the current forecast hour, or null outside the corridor. */
  function field(lng: number, lat: number): [number, number] | null {
    if (!data) return null;
    const g = data.grid;
    const col = Math.floor(((lng - g.west) / (g.east - g.west)) * g.cols);
    const row = Math.floor(((y1 - mercY(lat)) / (y1 - y0)) * g.rows);
    if (col < 0 || row < 0 || col >= g.cols || row >= g.rows) return null;
    const k = slot.get(row * g.cols + col);
    if (k === undefined) return null;
    const h0 = Math.min(48, Math.floor(hour)), h1 = Math.min(48, h0 + 1), f = hour - h0;
    return [u[h0][k] + (u[h1][k] - u[h0][k]) * f, v[h0][k] + (v[h1][k] - v[h0][k]) * f];
  }

  function spawn(p: Particle) {
    const g = data!.grid;
    for (let tries = 0; tries < 12; tries++) {
      const lng = g.west + Math.random() * (g.east - g.west);
      const lat = lat0(y0 + Math.random() * (y1 - y0));
      if (field(lng, lat)) { p.lng = lng; p.lat = lat; p.age = Math.floor(Math.random() * MAX_AGE); return; }
    }
    p.age = MAX_AGE; // no luck this time; try again next frame
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    if (!data || !active || document.hidden) return;
    const w = map.getContainer().clientWidth, h = map.getContainer().clientHeight;
    // fade the previous frame to leave trails
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,0.09)";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
    ctx.lineWidth = 1.6; ctx.lineCap = "round";
    // degrees moved per frame at 1 mph, scaled so a zoomed-out map still shows motion
    const scale = 0.00055 * Math.pow(2, 4.2 - map.getZoom());
    while (parts.length < COUNT) parts.push({ lng: 0, lat: 0, age: MAX_AGE });
    for (const p of parts) {
      if (p.age >= MAX_AGE) { spawn(p); if (p.age >= MAX_AGE) continue; }
      const vec = field(p.lng, p.lat);
      if (!vec) { p.age = MAX_AGE; continue; }
      const a = map.project([p.lng, p.lat]);
      const nlng = p.lng + (vec[0] * scale) / Math.max(0.2, Math.cos((p.lat * Math.PI) / 180));
      const nlat = p.lat + vec[1] * scale;
      const b = map.project([nlng, nlat]);
      const speed = Math.hypot(vec[0], vec[1]);
      const alpha = Math.min(0.95, 0.4 + speed / 40);
      ctx.strokeStyle = light ? `rgba(18,38,60,${alpha})` : `rgba(255,255,255,${alpha})`;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      p.lng = nlng; p.lat = nlat; p.age++;
    }
  }

  const clear = () => ctx.clearRect(0, 0, canvas.width, canvas.height);
  map.on("resize", resize);
  map.on("movestart", clear); // trails are in screen space; drop them when the view changes
  map.on("zoomstart", clear);
  resize();
  raf = requestAnimationFrame(frame);

  return {
    setData,
    setHour(h: number) { hour = h; },
    /** Streaks turn dark on the light Streets map so they stay visible. */
    setLight(on: boolean) { light = on; },
    setActive(on: boolean) { active = on && !reduce.matches; if (!active) clear(); },
    destroy() { cancelAnimationFrame(raf); map.off("resize", resize); map.off("movestart", clear); map.off("zoomstart", clear); canvas.remove(); },
  };
}
