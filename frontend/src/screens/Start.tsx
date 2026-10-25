import { useState } from "react";
import { post } from "../api";
import { usePoll } from "../hooks";
import { short } from "../format";
import { ErrorText } from "../components/ui";
import type { Status, WalletEntry } from "../types";

type Tab = "unlock" | "new" | "import";
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Join a network and unlock a wallet, or make one first. */
export function Start({ status, onUnlocked }: { status: Status; onUnlocked: () => void }) {
  const wallets = usePoll<WalletEntry[]>("/api/wallets", 0);
  const list = wallets.data ?? [];
  const [tab, setTab] = useState<Tab | null>(null);
  const shown: Tab = tab ?? (wallets.data && list.length === 0 ? "new" : "unlock");

  const [network, setNetwork] = useState(status.network?.url ?? "");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = name || list[0]?.name || "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const walletName = shown === "unlock" ? chosen : name.trim();
    if (!network.trim()) return setError("Type the network address the host printed, like http://192.168.1.20:8600");
    if (shown !== "unlock") {
      if (!NAME_RE.test(walletName)) return setError("A wallet name is 1–32 letters, digits, - or _.");
      if (!password) return setError("Choose a password.");
      if (password !== repeat) return setError("The two passwords are different.");
    }
    setBusy(true);
    try {
      if (shown === "new") await post("/api/wallets", { name: walletName, password });
      if (shown === "import") {
        await post("/api/wallets", { name: walletName, password, private_key: key });
        setKey("");
      }
      await post("/api/unlock", { name: walletName, password, network: network.trim() });
      setPassword("");
      setRepeat("");
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      wallets.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="start">
      <section className="start-intro">
        <h1 className="wordmark">DeGPU</h1>
        <p className="lede">
          Rent out your computer's spare power, or pay other people's computers to run your jobs. Results are checked
          by other providers or by the contract, and a provider caught cheating loses its stake.
        </p>
        <p className="muted">
          Payments use test ETH on your class network. It has no value; every new wallet gets some from the network's
          faucet.
        </p>
      </section>

      <section className="ticket start-card" aria-label="Open a wallet">
        <div className="tabs" role="tablist">
          {(
            [
              ["unlock", "Unlock a wallet"],
              ["new", "New wallet"],
              ["import", "Import a key"],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={shown === t}
              disabled={t === "unlock" && list.length === 0}
              onClick={() => {
                setTab(t);
                setError(null);
                setName("");
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <form className="form" onSubmit={submit}>
          {shown === "unlock" ? (
            <label className="field">
              <span>Wallet</span>
              <select value={chosen} onChange={(e) => setName(e.target.value)}>
                {list.map((w) => (
                  <option key={w.name} value={w.name}>
                    {w.name} ({short(w.address)})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field">
              <span>Wallet name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="alice" autoComplete="off" />
              <small>Letters, digits, - or _. Only you see it.</small>
            </label>
          )}

          {shown === "import" && (
            <label className="field">
              <span>Private key</span>
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="64 hex digits, with or without 0x"
                autoComplete="off"
                spellCheck={false}
              />
              <small>Saved encrypted on this computer only. Use a test wallet, not one that holds real money.</small>
            </label>
          )}

          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={shown === "unlock" ? "current-password" : "new-password"}
            />
          </label>
          {shown !== "unlock" && (
            <label className="field">
              <span>Repeat the password</span>
              <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" />
            </label>
          )}

          <label className="field">
            <span>Network address</span>
            <input
              value={network}
              onChange={(e) => setNetwork(e.target.value)}
              placeholder="http://192.168.1.20:8600"
              autoComplete="off"
              spellCheck={false}
            />
            <small>The join URL that "degpu host" printed on the host laptop.</small>
          </label>

          <ErrorText error={error} />
          <button type="submit" className="btn primary wide" disabled={busy} aria-busy={busy}>
            {busy ? "Opening the wallet…" : shown === "unlock" ? "Unlock and join" : shown === "new" ? "Create wallet and join" : "Import and join"}
          </button>
        </form>
      </section>
    </main>
  );
}
