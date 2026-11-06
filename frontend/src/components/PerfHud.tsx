import { useEffect, useState } from "react";
import { perf } from "../perf";

/** Frames per second, the slowest recent frame, and how long the key steps took. Toggled with P. */
export default function PerfHud() {
  const [s, setS] = useState({ fps: 0, worst: 0 });
  useEffect(() => {
    let raf = 0, last = performance.now(), frames = 0, worst = 0, since = last;
    const tick = (now: number) => {
      const dt = now - last; last = now; frames++; worst = Math.max(worst, dt);
      if (now - since >= 500) { setS({ fps: Math.round((frames * 1000) / (now - since)), worst: Math.round(worst) }); frames = 0; worst = 0; since = now; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const ms = (v: number) => (v ? `${Math.round(v)} ms` : "n/a");
  return (
    <dl className="perf" aria-label="Performance">
      <div><dt>Frame rate</dt><dd>{s.fps} fps</dd></div>
      <div><dt>Slowest frame</dt><dd>{s.worst} ms</dd></div>
      <div><dt>Heat redraw</dt><dd>{perf.heatDrawMs ? `${perf.heatDrawMs.toFixed(1)} ms` : "n/a"}</dd></div>
      <div><dt>Routes</dt><dd>{ms(perf.routesMs)}</dd></div>
      <div><dt>Full plan</dt><dd>{ms(perf.planMs)}</dd></div>
      <div><dt>Heatmap data</dt><dd>{ms(perf.heatmapMs)}</dd></div>
    </dl>
  );
}
