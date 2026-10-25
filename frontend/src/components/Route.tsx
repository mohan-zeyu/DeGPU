import { clock } from "../format";
import type { JobDetail } from "../types";

type StationState = "done" | "current" | "todo" | "skipped";

interface Station {
  label: string;
  state: StationState;
  time?: number;
}

/** The stations a job passes, worked out from its events (what happened) and its status (where it
 *  is now). Stations a closed job never reached are "skipped", e.g. the checks of an unverified job. */
export function stations(job: JobDetail): Station[] {
  const at = (...events: string[]) => job.timeline.find((e) => events.includes(e.event))?.time;
  const s = job.status;
  const reveals = job.timeline.filter((e) => e.event === "CheckRevealed");
  const checkedAt =
    reveals.length > 0 && reveals.length >= (job.verifiers?.length ?? 0) ? reveals[reveals.length - 1].time : undefined;
  const list: { label: string; time?: number; current: boolean; optional?: boolean }[] =
    job.mode === "checked"
      ? [
          { label: "Posted", time: at("JobCreated"), current: false },
          { label: "Accepted", time: at("JobAccepted"), current: s === "open" },
          { label: "Solved and checked", time: at("ResultsSubmitted"), current: s === "working" },
        ]
      : [
          { label: "Posted", time: at("JobCreated"), current: false },
          { label: "Accepted", time: at("JobAccepted"), current: s === "open" },
          { label: "Computed", time: at("ResultsCommitted"), current: s === "committing" },
          { label: "Decision revealed", time: at("DecisionRevealed", "VerificationDropped"), current: s === "deciding" },
          {
            label: "Checked by verifiers",
            time: checkedAt,
            current: s === "checking" || s === "check_reveal",
          },
          { label: "Results published", time: at("ResultsPublished"), current: s === "publishing" },
          {
            label: "Tie-break",
            time: at("TiebreakSubmitted", "JudgementSubmitted"),
            current: s === "disputing" || s === "tie_break",
            optional: true,
          },
        ];
  const out: Station[] = [];
  for (const st of list) {
    if (st.optional && !st.time && !st.current) continue; // only shown when there was a disagreement
    const state: StationState = st.time ? "done" : st.current ? "current" : job.closed ? "skipped" : "todo";
    out.push({ label: st.label, state, time: st.time });
  }
  out.push({ label: "Closed", state: job.closed ? "done" : "todo", time: at("JobClosed") });
  return out;
}

export function Route({ job }: { job: JobDetail }) {
  return (
    <ol className="route" aria-label="Where the job is">
      {stations(job).map((st, i) => (
        <li key={i} className={`station ${st.state}`} aria-current={st.state === "current" ? "step" : undefined}>
          <span className="dot" aria-hidden="true" />
          <span className="station-label">{st.label}</span>
          <span className="station-time">
            {st.state === "done" && st.time ? clock(st.time) : st.state === "current" ? "now" : st.state === "skipped" ? "skipped" : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}
