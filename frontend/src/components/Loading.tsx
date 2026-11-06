import { useEffect, useState } from "react";

const STEPS = ["Finding three routes", "Reading the forecast at every checkpoint", "Scoring the risk and ranking the routes"];
// The server answers in one go, so these steps follow typical timing rather than live progress.
const AT = [0, 2200, 5200];

export default function Loading({ routesReady }: { routesReady: boolean }) {
  const [timed, setTimed] = useState(0);
  useEffect(() => {
    const ids = AT.map((ms, i) => window.setTimeout(() => setTimed(i), ms));
    return () => ids.forEach(clearTimeout);
  }, []);
  // Once the route lines are in, the first step is truly done.
  const step = Math.max(timed, routesReady ? 1 : 0);
  return (
    <div className="loading" role="status" aria-live="polite">
      <ol>
        {STEPS.map((s, i) => (
          <li key={s} className={i < step ? "done" : i === step ? "now" : ""}>
            <i aria-hidden />{s}
          </li>
        ))}
      </ol>
      <p>This usually takes 5 to 10 seconds.</p>
    </div>
  );
}
