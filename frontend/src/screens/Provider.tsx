import { useState } from "react";
import { post } from "../api";
import { usePoll, useSession } from "../hooks";
import { ethInput, formatEth, parseEth, plural } from "../format";
import { ActionButton, Chip, ErrorText, Eth, useConfirm } from "../components/ui";
import { RECORD_WORDS } from "../words";
import type { Behavior, MeAsProvider, TaskInfo } from "../types";

const BEHAVIORS: { value: Behavior; text: string }[] = [
  { value: "honest", text: "Honest" },
  { value: "cheat", text: "Cheat: fake 20% of results as the provider" },
  { value: "liar", text: "Liar: report random results as a verifier" },
  { value: "offline", text: "Offline: accept jobs, then do nothing" },
];

export function ProviderScreen() {
  const { tasks, refresh } = useSession();
  const me = usePoll<MeAsProvider>("/api/provider", 5000);
  const [warning, setWarning] = useState<string | null>(null);
  const p = me.data;

  const after = (r: MeAsProvider) => {
    setWarning(r.warning ?? null);
    me.reload();
    refresh();
  };

  return (
    <>
      <h1>Sell compute</h1>
      {!p ? (
        <>
          <p className="muted">Loading…</p>
          <ErrorText error={me.error?.message} />
        </>
      ) : !p.registered ? (
        <Register p={p} tasks={tasks} onDone={after} />
      ) : (
        <Registered p={p} tasks={tasks} warning={warning} onDone={after} />
      )}
    </>
  );
}

function Register({ p, tasks, onDone }: { p: MeAsProvider; tasks: TaskInfo[]; onDone: (r: MeAsProvider) => void }) {
  const [stake, setStake] = useState("1");
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(tasks.map((t) => [t.name, t.runs_here ? ethInput(t.default_price_wei) : "0"])),
  );

  return (
    <>
      <p className="lede">
        Stake some ETH as a promise to work honestly. While you serve, this computer accepts jobs, runs them and gets
        paid. If it returns wrong results or misses a deadline, part of the stake is taken.
      </p>
      <section className="ticket pad">
        <h2>Become a provider</h2>
        <div className="form">
          <label className="field">
            <span>Stake (ETH)</span>
            <input inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} />
            <small>At least {formatEth(p.min_stake_wei)}. You can take it back later, when you're in no open job.</small>
          </label>
          <PriceInputs tasks={tasks} prices={prices} onChange={setPrices} />
          <ActionButton
            run={async () => {
              const prices_wei = Object.fromEntries(tasks.filter((t) => t.runs_here).map((t) => [t.name, parseEth(prices[t.name] || "0")]));
              await post<MeAsProvider>("/api/provider/register", { stake_wei: parseEth(stake), prices_wei });
              // Serve right away: a provider that offers tasks but doesn't serve can be drawn as a
              // verifier and slashed for not answering.
              onDone(await post<MeAsProvider>("/api/provider/serve", { on: true }));
            }}
            busyText="Registering…"
          >
            Stake, register and start serving
          </ActionButton>
        </div>
      </section>
    </>
  );
}

function PriceInputs({
  tasks,
  prices,
  onChange,
}: {
  tasks: TaskInfo[];
  prices: Record<string, string>;
  onChange: (p: Record<string, string>) => void;
}) {
  return (
    <fieldset className="prices">
      <legend>Price per item (ETH). 0 means you don't offer the task.</legend>
      {tasks.map((t) => (
        <label key={t.name} className="field inline">
          <span>{t.name}</span>
          <input
            inputMode="decimal"
            value={prices[t.name] ?? "0"}
            disabled={!t.runs_here}
            onChange={(e) => onChange({ ...prices, [t.name]: e.target.value })}
          />
          <small>{t.runs_here ? `Default ${formatEth(t.default_price_wei)}` : "Can't run on this computer (software missing)"}</small>
        </label>
      ))}
    </fieldset>
  );
}

function Registered({
  p,
  tasks,
  warning,
  onDone,
}: {
  p: MeAsProvider;
  tasks: TaskInfo[];
  warning: string | null;
  onDone: (r: MeAsProvider) => void;
}) {
  const [dialog, ask] = useConfirm();
  const [add, setAdd] = useState("");
  const [take, setTake] = useState("");
  const [prices, setPrices] = useState<Record<string, string> | null>(null);
  const [presentation, setPresentation] = useState(p.behavior !== "honest");
  const shownPrices = prices ?? Object.fromEntries(tasks.map((t) => [t.name, ethInput(p.prices_wei[t.name] ?? "0")]));
  const offering = Object.values(p.prices_wei).some((w) => w !== "0");

  async function serve(on: boolean, behavior?: Behavior) {
    const r = await post<MeAsProvider>("/api/provider/serve", { on, behavior });
    if (!on && offering) {
      const stop = await ask({
        title: "Also stop offering your tasks?",
        body: "Verifiers are drawn from everyone who offers a task, even when their app is closed. A drawn provider that doesn't answer is slashed. Setting your prices to 0 keeps you out of new draws.",
        yes: "Set my prices to 0",
        no: "Keep offering",
      });
      if (stop) {
        const zero = Object.fromEntries(Object.keys(p.prices_wei).map((name) => [name, "0"]));
        setPrices(null);
        return onDone(await post<MeAsProvider>("/api/provider/prices", { prices_wei: zero }));
      }
    }
    onDone(r);
  }

  return (
    <>
      {dialog}
      {p.behavior !== "honest" && (
        <p className="banner bad" role="status">
          This provider is cheating on purpose, for the demo ({BEHAVIORS.find((b) => b.value === p.behavior)?.text}).
        </p>
      )}

      <section className={`serve${p.serving ? " on" : ""}`}>
        <div>
          <h2>{p.serving ? "Serving" : "Not serving"}</h2>
          <p>
            {p.serving
              ? "This computer accepts and runs jobs by itself while the DeGPU app is open."
              : "Turn serving on to receive jobs. Keep the DeGPU app open while you serve."}
          </p>
          {p.serving && !offering && (
            <p className="note tone-warn">You don't offer any task, so no jobs will come. Set a price below.</p>
          )}
          {!p.active && <p className="note tone-warn">Your stake is below the minimum of {formatEth(p.min_stake_wei)}, so you get no new jobs. Add stake.</p>}
          {warning && <p className="note tone-warn">{warning.charAt(0).toUpperCase() + warning.slice(1)}.</p>}
        </div>
        <ActionButton className={`btn ${p.serving ? "ghost" : "primary"}`} run={() => serve(!p.serving)}>
          {p.serving ? "Stop serving" : "Start serving"}
        </ActionButton>
      </section>

      <div className="grid-2">
        <section className="ticket pad">
          <h2>Stake</h2>
          <p className="big-figure">
            <Eth wei={p.stake_wei} />
          </p>
          <p className="muted small">
            {p.active ? <Chip tone="good">Active</Chip> : <Chip tone="warn">Stake too low</Chip>}{" "}
            {p.open_jobs ? `In ${plural(p.open_jobs, "open job")}.` : "In no open job."}
          </p>
          <div className="form">
            <label className="field inline">
              <span>Add (ETH)</span>
              <input inputMode="decimal" value={add} onChange={(e) => setAdd(e.target.value)} placeholder="0.5" />
              <ActionButton className="btn ghost" disabled={!add} run={async () => onDone(await post<MeAsProvider>("/api/provider/stake", { amount_wei: parseEth(add) }))}>
                Add stake
              </ActionButton>
            </label>
            <label className="field inline">
              <span>Take back (ETH)</span>
              <input inputMode="decimal" value={take} onChange={(e) => setTake(e.target.value)} placeholder="0.5" disabled={p.open_jobs > 0} />
              <ActionButton
                className="btn ghost"
                disabled={!take || p.open_jobs > 0}
                run={async () => onDone(await post<MeAsProvider>("/api/provider/withdraw", { amount_wei: parseEth(take) }))}
              >
                Withdraw
              </ActionButton>
            </label>
            {p.open_jobs > 0 && <small className="muted">You can withdraw once you're in no open job.</small>}
          </div>
        </section>

        <section className="ticket pad">
          <h2>Prices</h2>
          <PriceInputs tasks={tasks} prices={shownPrices} onChange={setPrices} />
          <ActionButton
            className="btn primary"
            disabled={!prices}
            run={async () => {
              const changed = Object.fromEntries(
                tasks
                  .filter((t) => t.runs_here || (p.prices_wei[t.name] ?? "0") !== "0")
                  .map((t) => [t.name, parseEth(shownPrices[t.name] || "0")])
                  .filter(([name, wei]) => wei !== (p.prices_wei[name] ?? "0")),
              );
              if (Object.keys(changed).length) onDone(await post<MeAsProvider>("/api/provider/prices", { prices_wei: changed }));
              setPrices(null);
            }}
          >
            Save prices
          </ActionButton>
        </section>
      </div>

      <section>
        <h2>Your record</h2>
        <div className="grid-2">
          {(["replicated", "checked"] as const).map((mode) => (
            <div key={mode} className="record">
              <h3>{mode === "replicated" ? "Re-run jobs" : "Puzzle jobs"}</h3>
              <dl>
                {Object.entries(p.record[mode] ?? {}).map(([k, v]) => (
                  <div key={k} className="record-row">
                    <dt>{RECORD_WORDS[k] ?? k}</dt>
                    <dd className={`num${v && /missed|outvoted/.test(k) ? " tone-text-bad" : ""}`}>{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </section>

      <section className="presentation-section">
        <label className="switch">
          <input type="checkbox" checked={presentation} onChange={(e) => setPresentation(e.target.checked)} />
          <span>Presentation mode</span>
        </label>
        {presentation && (
          <div className="presentation">
            <p className="muted">Make this provider misbehave on purpose, to show the class how cheating gets caught.</p>
            <div className="behaviors" role="radiogroup" aria-label="Behaviour">
              {BEHAVIORS.map((b) => (
                <ActionButton
                  key={b.value}
                  className={`btn ${p.behavior === b.value ? "primary" : "ghost"}`}
                  run={async () => onDone(await post<MeAsProvider>("/api/provider/serve", { on: true, behavior: b.value }))}
                >
                  {b.text}
                </ActionButton>
              ))}
            </div>
            <p className="muted small">Choosing a behaviour also turns serving on.</p>
          </div>
        )}
      </section>
    </>
  );
}
