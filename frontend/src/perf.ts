/** Timings the performance panel (press P) reads. Plain numbers, written where the work happens. */
export const perf = { planMs: 0, routesMs: 0, heatmapMs: 0, heatDrawMs: 0 };

export async function timed<T>(slot: keyof typeof perf, work: Promise<T>): Promise<T> {
  const t = performance.now();
  try { return await work; } finally { perf[slot] = performance.now() - t; }
}
