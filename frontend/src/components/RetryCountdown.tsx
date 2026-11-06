import { useEffect, useState } from "react";

/** Counts down, then retries once by itself. Used when a provider says it is rate limited. */
export default function RetryCountdown({ seconds, onRetry }: { seconds: number; onRetry: () => void }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (left <= 0) { onRetry(); return; }
    const id = window.setTimeout(() => setLeft((l) => l - 1), 1000);
    return () => clearTimeout(id);
  }, [left, onRetry]);
  return (
    <div className="retry">
      <span aria-live="off">Trying again in {left}s</span>
      <button className="link" onClick={onRetry}>Retry now</button>
    </div>
  );
}
