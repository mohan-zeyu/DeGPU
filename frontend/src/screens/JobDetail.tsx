import { useEffect, useRef, useState } from "react";
import { post } from "../api";
import { usePoll, useNow, useSession } from "../hooks";
import { clock, formatEth, plural, sameAddress, timeLeft } from "../format";
import { Route } from "../components/Route";
import { Stamp } from "../components/Stamp";
import { ActionButton, Addr, Chip, ErrorText, Eth, useConfirm } from "../components/ui";
import { OUTCOMES, STATUS_WORDS, VSTATE_WORDS, eventWords, roleWords } from "../words";
import labels from "../imagenet-classes.json";
import type { JobDetail, Outcome, Results } from "../types";

export function JobDetailScreen({ jobRef }: { jobRef: string }) {
  const { me, refresh } = useSession();
  const [closedNow, setClosedNow] = useState(false);
  const wasOpen = useRef<boolean | null>(null);
  const job = usePoll<JobDetail>(`/api/jobs/${encodeURIComponent(jobRef)}`, closedNow ? 0 : 2000);
  const now = useNow();
  const [dialog, ask] = useConfirm();
  const j = job.data;

  // The stamp lands only if the job closes while it's on screen.
  const [land, setLand] = useState(false);
  useEffect(() => {
    if (!j) return;
    if (wasOpen.current === true && j.closed) {
      setLand(true);
      refresh();
    }
    wasOpen.current = !j.closed;
    if (j.closed) setClosedNow(true);
  }, [j?.closed]); // eslint-disable-line react-hooks/exhaustive-deps

  if (job.error && !j) {
    return (
      <>
        <p>
          <a href="#/jobs">My jobs</a>
        </p>
        <ErrorText error={job.error.message} />
      </>
    );
  }
  if (!j) return <p className="muted">Loading {jobRef}…</p>;

  const left = j.closed ? null : timeLeft(j.deadline, now);
  const isClient = j.role === "client";
  const canCancel = j.status === "open" && (isClient || !left);
  const canExpire = !j.closed && !left && j.deadline > 0;
  const received = sumEvents(j, "Payout", "to", me);
  const slashed = sumEvents(j, "ProviderSlashed", "provider", me);

  return (
    <>
      {dialog}
      <p className="crumb">
        <a href="#/jobs">My jobs</a>
      </p>

      <article className="ticket job">
        <header className="job-head">
          <div>
            <h1>Job {j.ref}</h1>
            <p className="lede">
              {j.task}, {plural(j.num_items, "item")}. {roleWords(j.role)}.
            </p>
            {j.closed ? (
              <p>{OUTCOMES[j.outcome]?.text}</p>
            ) : (
              <p>
                <strong>{STATUS_WORDS[j.status] ?? j.status}.</strong>{" "}
                <span className="muted">{left ? `${left} left in this step.` : "This step's deadline has passed."}</span>
              </p>
            )}
          </div>
          <div className="job-stamp">{j.closed ? <Stamp outcome={j.outcome} land={land} /> : <Chip tone="info">In progress</Chip>}</div>
        </header>

        <Route job={j} />

        <div className="perforation" aria-hidden="true" />

        <div className="job-body">
          <section>
            <h2>Who's involved</h2>
            <dl className="parties">
              <dt>Client</dt>
              <dd>
                <Addr a={j.client} me={me} />
              </dd>
              <dt>Provider</dt>
              <dd>
                <Addr a={j.main} me={me} />
              </dd>
              {j.verifiers?.map((v, i) => (
                <PartyRow key={v.address} label={`Verifier ${i + 1}`}>
                  <Addr a={v.address} me={me} />{" "}
                  <span className="muted small">
                    items {v.items[0]}–{v.items[1] - 1}
                  </span>{" "}
                  <Chip tone={VSTATE_WORDS[v.state]?.tone}>{VSTATE_WORDS[v.state]?.text ?? v.state}</Chip>
                </PartyRow>
              ))}
              {j.tiebreaker && (
                <PartyRow label="Tie-breaker">
                  <Addr a={j.tiebreaker} me={me} />{" "}
                  <span className="muted small">{j.mismatched?.length ? `re-ran items ${j.mismatched.join(", ")}` : ""}</span>
                </PartyRow>
              )}
            </dl>
            {j.mode === "replicated" && (
              <p className="muted small">
                {j.verified
                  ? "Verified: two random providers re-ran every item."
                  : j.dropped === "client_no_reveal"
                    ? "Counts as unverified: the client's app didn't reveal the secret decision in time."
                    : j.dropped === "no_eligible_verifier"
                      ? "Ran unverified: not enough other providers were available."
                      : j.decided
                        ? "Not verified: the client chose not to (that choice stayed secret until the provider had committed)."
                        : "Whether this job gets verified stays secret until the provider has committed its results."}
              </p>
            )}
            <dl className="money">
              {isClient && (
                <>
                  <dt>Deposit</dt>
                  <dd>
                    <Eth wei={j.deposit_wei} />
                  </dd>
                </>
              )}
              {received > 0n && (
                <>
                  <dt>You received</dt>
                  <dd className="tone-text-good">
                    <Eth wei={received} />
                  </dd>
                </>
              )}
              {slashed > 0n && (
                <>
                  <dt>You lost</dt>
                  <dd className="tone-text-bad">
                    <Eth wei={slashed} /> of stake
                  </dd>
                </>
              )}
            </dl>
            {(canCancel || canExpire) && (
              <div className="row">
                {canCancel && (
                  <ActionButton
                    className="btn ghost"
                    run={async () => {
                      if (
                        await ask({
                          title: "Cancel this job?",
                          body: "Nobody has accepted it yet. The deposit goes back to the client.",
                          yes: "Cancel the job",
                          no: "Keep the job",
                          danger: true,
                        })
                      ) {
                        await post(`/api/jobs/${j.ref}/cancel`);
                        job.reload();
                        refresh();
                      }
                    }}
                  >
                    Cancel the job
                  </ActionButton>
                )}
                {canExpire && (
                  <ActionButton
                    className="btn ghost"
                    run={async () => {
                      if (
                        await ask({
                          title: "Move this job on?",
                          body: "The deadline of this step passed. This settles the step: whoever didn't act in time is slashed.",
                          yes: "Move it on",
                          no: "Wait",
                        })
                      ) {
                        await post(`/api/jobs/${j.ref}/expire`);
                        job.reload();
                        refresh();
                      }
                    }}
                  >
                    Move it on
                  </ActionButton>
                )}
              </div>
            )}
          </section>

          <section>
            <h2>Timeline</h2>
            <ol className="timeline">
              {j.timeline.map((e, i) => (
                <li key={i}>
                  <time className="num">{clock(e.time)}</time>
                  <span className={e.event === "ProviderSlashed" ? "tone-text-bad" : undefined}>{eventWords(e.event, e.args, me)}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </article>

      {isClient && <ResultsView job={j} />}
    </>
  );
}

function PartyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function sumEvents(j: JobDetail, event: string, field: string, me: string): bigint {
  return j.timeline
    .filter((e) => e.event === event && sameAddress(String(e.args[field]), me))
    .reduce((sum, e) => sum + BigInt(String(e.args.amount)), 0n);
}

const MISMATCH_NOTE: Partial<Record<Outcome, string>> = {
  verifier_outvoted: "Checked twice: these results are right (a verifier was wrong).",
  main_outvoted: "These results are wrong: the provider cheated on them. You were compensated.",
  both_outvoted: "Disputed: these results may be wrong.",
  no_majority: "Disputed: these results may be wrong.",
};

function ResultsView({ job }: { job: JobDetail }) {
  const ready = job.closed || ["publishing", "disputing", "tie_break"].includes(job.status);
  const res = usePoll<Results>(ready ? `/api/jobs/${encodeURIComponent(job.ref)}/results` : null, job.closed ? 0 : 5000);
  const wrong = job.outcome === "main_outvoted";
  const note = MISMATCH_NOTE[job.outcome];

  return (
    <section className="results">
      <h2>Results</h2>
      {!ready || res.error?.message === "no results yet" ? (
        <p className="muted">No results yet. They appear here once the provider publishes them.</p>
      ) : res.error ? (
        <ErrorText error={res.error.message} />
      ) : !res.data ? (
        <p className="muted">Decrypting the results…</p>
      ) : res.data.kind === "file" ? (
        <>
          {note && res.data.items.some((i) => i.mismatched) && <p className="note tone-warn">Marked frames: {note}</p>}
          <ul className="frames">
            {res.data.items.map((it) => (
              <li key={it.index} className={it.mismatched ? `mismatched${wrong ? " wrong" : ""}` : undefined}>
                {it.file ? (
                  <a href={it.file} target="_blank" rel="noreferrer">
                    <img src={it.file} alt={`Result ${it.index}`} loading="lazy" />
                  </a>
                ) : (
                  <div className="frame-missing">Missing</div>
                )}
                <span className="small">
                  Item {it.index}
                  {it.size ? `, ${Math.round(it.size / 1024)} KB` : ""}
                  {it.mismatched ? " (disputed)" : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          {note && res.data.items.some((i) => i.mismatched) && <p className="note tone-warn">Marked items: {note}</p>}
          <div className="table-wrap">
            <table className="table results-table">
              <thead>
                <tr>
                  <th className="right">Item</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {res.data.items.map((it) => (
                  <tr key={it.index} className={it.mismatched ? `mismatched${wrong ? " wrong" : ""}` : undefined}>
                    <td className="right num">{it.index}</td>
                    <td>
                      <ResultValue task={job.task} value={it.value} />
                      {it.mismatched && <Chip tone={wrong ? "bad" : "warn"}>Disputed</Chip>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {job.task === "key-search-v1" && job.closed && (
        <p className="muted small">
          Puzzles with no answer were refunded: you paid {formatEth(BigInt(job.solved ?? 0) * (BigInt(job.deposit_wei) / BigInt(job.num_items || 1)))} for{" "}
          {plural(job.solved ?? 0, "solved puzzle")}.
        </p>
      )}
    </section>
  );
}

function ResultValue({ task, value }: { task: string; value: number | string | null }) {
  if (value === null) return <span className="muted">{task === "key-search-v1" ? "Not found" : "No result"}</span>;
  if (task === "image-classify-v1" && typeof value === "number") {
    return (
      <span>
        {(labels as string[])[value] ?? "Unknown class"} <span className="muted small">class {value}</span>
      </span>
    );
  }
  return <span className="num break">{String(value)}</span>;
}
