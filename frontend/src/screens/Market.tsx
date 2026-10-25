import { usePoll, useSession } from "../hooks";
import { plural, sameAddress, sentence } from "../format";
import { Addr, Chip, Empty, ErrorText, Eth } from "../components/ui";
import { MODE_WORDS } from "../words";
import type { Provider } from "../types";

export function jobsDone(p: Provider): number {
  const r = p.record.replicated ?? {};
  const c = p.record.checked ?? {};
  return (r.verified_completed ?? 0) + (r.unverified_completed ?? 0) + (c.completed ?? 0);
}

export function caught(p: Provider): number {
  return (p.record.replicated?.outvoted ?? 0) + (p.record.replicated?.checks_outvoted ?? 0);
}

export function Market() {
  const { me, tasks } = useSession();
  const providers = usePoll<Provider[]>("/api/providers", 10000);
  const list = providers.data ?? [];
  const active = list.filter((p) => p.active).length;

  return (
    <>
      <h1>Market</h1>
      <p className="lede">
        {providers.data ? `${plural(list.length, "provider")}, ${active} active.` : "Loading providers…"} Prices are per
        item.
      </p>
      <ErrorText error={providers.error?.message} />

      {providers.data && list.length === 0 ? (
        <Empty title="Nobody sells compute on this network yet.">
          <a className="btn primary" href="#/provider">
            Be the first provider
          </a>
        </Empty>
      ) : (
        list.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th className="right">Stake</th>
                  <th>State</th>
                  {tasks.map((t) => (
                    <th key={t.name} className="right">
                      {t.name}
                    </th>
                  ))}
                  <th className="right">Jobs done</th>
                  <th className="right">Caught cheating</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.address} className={sameAddress(p.address, me) ? "mine" : undefined}>
                    <td>
                      <Addr a={p.address} me={me} />
                    </td>
                    <td className="right">
                      <Eth wei={p.stake_wei} digits={3} />
                    </td>
                    <td>
                      {p.active ? <Chip tone="good">Active</Chip> : <Chip tone="warn">Stake too low</Chip>}
                      {p.open_jobs > 0 && <span className="muted small block">{plural(p.open_jobs, "job")} in progress</span>}
                    </td>
                    {tasks.map((t) => (
                      <td key={t.name} className="right">
                        {p.prices_wei[t.name] && p.prices_wei[t.name] !== "0" ? <Eth wei={p.prices_wei[t.name]} /> : <span className="muted">—</span>}
                      </td>
                    ))}
                    <td className="right num">{jobsDone(p)}</td>
                    <td className={`right num${caught(p) ? " tone-text-bad" : ""}`}>{caught(p)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      <h2>Task types</h2>
      <ul className="task-list">
        {tasks.map((t) => (
          <li key={t.name}>
            <h3>{t.name}</h3>
            <p>{sentence(t.description)}</p>
            <p className="muted small">
              {MODE_WORDS[t.mode]}. Default price <Eth wei={t.default_price_wei} /> per item.{" "}
              {t.runs_here ? "This computer can run it." : "This computer can't run it (software missing)."}
            </p>
            {t.code_matches === false && (
              <p className="note tone-warn">
                Your DeGPU code for this task differs from the network's version, so providers will refuse your jobs.
                Update the code.
              </p>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
