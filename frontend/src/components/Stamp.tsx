import { OUTCOMES } from "../words";
import type { Outcome } from "../types";

/** The outcome of a closed job, as an inked stamp. `land` plays the one animation in the GUI:
 *  the stamp coming down, used only when the job closes while the user is watching it. */
export function Stamp({ outcome, land = false, size = "big" }: { outcome: Outcome; land?: boolean; size?: "big" | "small" }) {
  const o = OUTCOMES[outcome] ?? OUTCOMES.none;
  return (
    <span className={`stamp stamp-${size} tone-${o.tone}${land ? " land" : ""}`} role="img" aria-label={`Outcome: ${o.stamp}`}>
      {o.stamp}
    </span>
  );
}
