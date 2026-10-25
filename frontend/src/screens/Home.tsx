import { useState } from "react";
import { post } from "../api";
import { usePoll, useSession } from "../hooks";
import { formatEth } from "../format";
import { ActionButton, Eth } from "../components/ui";
import { JobTable } from "./Jobs";
import type { FaucetReply, JobSummary } from "../types";

export function Home() {
  const { status, account, refresh } = useSession();
  const jobs = usePoll<JobSummary[]>("/api/jobs", 3000);
  const [received, setReceived] = useState<string | null>(null);
  const running = (jobs.data ?? []).filter((j) => !j.closed);
  const mustStayOpen = status.serving || running.length > 0;
  const empty = account?.balance_wei === "0";

  return (
    <>
      <section className="home-head">
        <h1>Buy compute, or sell it</h1>
        <p className="lede">
          Wallet {status.wallet?.name} holds {account ? <Eth wei={account.balance_wei} /> : "…"} of test money.
        </p>
      </section>

      {empty && (
        <section className="callout" aria-label="Get test ETH">
          <p>
            Your wallet is empty. The network's faucet gives every new wallet{" "}
            {status.network && "faucet_wei" in status.network ? formatEth(status.network.faucet_wei) : "some test ETH"},
            once.
          </p>
          <ActionButton
            run={async () => {
              const r = await post<FaucetReply>("/api/faucet");
              setReceived(formatEth(r.amount_wei));
              refresh();
            }}
            busyText="Asking the faucet…"
          >
            Get test ETH
          </ActionButton>
        </section>
      )}
      {received && <p className="note tone-good">You received {received}.</p>}

      <section className="choices">
        <a className="choice" href="#/post">
          <span className="choice-title">Buy compute</span>
          <span>Post a job: classify images, find hidden keys or render frames. Pick a provider and pay a deposit.</span>
        </a>
        <a className="choice" href="#/provider">
          <span className="choice-title">Sell compute</span>
          <span>Stake ETH and let this computer run other people's jobs. Honest work gets paid; wrong work gets slashed.</span>
        </a>
      </section>

      <section>
        <h2>Running now</h2>
        {mustStayOpen && (
          <p className="note tone-info">
            Keep the DeGPU app open on this computer: it takes the next steps of your jobs by itself.
          </p>
        )}
        {!jobs.data ? (
          <p className="muted">Loading…</p>
        ) : running.length === 0 ? (
          <p className="muted">
            Nothing is running. <a href="#/jobs">See finished jobs</a>.
          </p>
        ) : (
          <JobTable jobs={running} />
        )}
      </section>
    </>
  );
}
