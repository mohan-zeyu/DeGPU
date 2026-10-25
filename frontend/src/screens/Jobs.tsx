import { useState } from "react";
import { usePoll, useNow, useSession } from "../hooks";
import { plural, timeLeft } from "../format";
import { Stamp } from "../components/Stamp";
import { Empty, ErrorText, Eth } from "../components/ui";
import { ROLE_WORDS, STATUS_WORDS } from "../words";
import type { JobSummary } from "../types";

/** A table of jobs; each row opens the job. */
export function JobTable({ jobs, showDeposit = true }: { jobs: JobSummary[]; showDeposit?: boolean }) {
  const now = useNow();
  return (
    <div className="table-wrap">
      <table className="table jobs">
        <thead>
          <tr>
            <th>Job</th>
            <th>Task</th>
            <th>Your part</th>
            <th className="right">Items</th>
            <th>Where it is</th>
            {showDeposit && <th className="right">Deposit</th>}
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const left = j.closed ? null : timeLeft(j.deadline, now);
            return (
              <tr key={`${j.ref}-${j.role}`} className="clickable" onClick={() => (window.location.hash = `/jobs/${j.ref}`)}>
                <td>
                  <a href={`#/jobs/${j.ref}`} onClick={(e) => e.stopPropagation()}>
                    {j.ref}
                  </a>
                </td>
                <td>{j.task}</td>
                <td>{j.role ? ROLE_WORDS[j.role] ?? j.role : "—"}</td>
                <td className="right num">{j.num_items}</td>
                <td>
                  {j.closed ? (
                    <Stamp outcome={j.outcome} size="small" />
                  ) : (
                    <>
                      {STATUS_WORDS[j.status] ?? j.status}
                      <span className="muted small block">{left ? `${left} left in this step` : "Deadline passed"}</span>
                    </>
                  )}
                </td>
                {showDeposit && <td className="right">{j.role === "client" ? <Eth wei={j.deposit_wei} /> : "—"}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Jobs() {
  const { status } = useSession();
  const jobs = usePoll<JobSummary[]>("/api/jobs", 3000);
  const [tab, setTab] = useState<"bought" | "worked">("bought");
  const all = jobs.data ?? [];
  const bought = all.filter((j) => j.role === "client");
  const worked = all.filter((j) => j.role !== "client");
  const shown = tab === "bought" ? bought : worked;

  return (
    <>
      <h1>My jobs</h1>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "bought"} onClick={() => setTab("bought")}>
          Bought ({bought.length})
        </button>
        <button type="button" role="tab" aria-selected={tab === "worked"} onClick={() => setTab("worked")}>
          Worked on ({worked.length})
        </button>
      </div>
      <ErrorText error={jobs.error?.message} />
      {!jobs.data ? (
        <p className="muted">Loading jobs…</p>
      ) : shown.length === 0 ? (
        tab === "bought" ? (
          <Empty title="You haven't bought any compute yet.">
            <a className="btn primary" href="#/post">
              Post a job
            </a>
          </Empty>
        ) : (
          <Empty title="Your computer hasn't worked on any jobs yet.">
            <p className="muted">
              {status.serving
                ? "You're serving: jobs show up here once a client picks you or you're drawn as a verifier."
                : "Register and start serving to receive jobs."}
            </p>
            {!status.serving && (
              <a className="btn primary" href="#/provider">
                Sell compute
              </a>
            )}
          </Empty>
        )
      ) : (
        <>
          <p className="muted">{plural(shown.length, "job")}, newest first.</p>
          <JobTable jobs={shown} showDeposit={tab === "bought"} />
        </>
      )}
    </>
  );
}
