import { post } from "../api";
import { useRoute, useSession } from "../hooks";
import { ActionButton, Addr, Chip, Eth } from "./ui";

const NAV: [string, string][] = [
  ["", "Home"],
  ["market", "Market"],
  ["post", "Buy compute"],
  ["jobs", "My jobs"],
  ["provider", "Sell compute"],
];

export function Header({ activityOpen, onActivity }: { activityOpen: boolean; onActivity: () => void }) {
  const { status, account, refresh } = useSession();
  const route = useRoute();
  const section = route.split("/")[0];
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="#/">
          DeGPU
        </a>
        <nav className="nav" aria-label="Main">
          {NAV.map(([to, label]) => (
            <a key={to} href={`#/${to}`} aria-current={section === to ? "page" : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <div className="wallet">
          <span className="wallet-who">
            <strong>{status.wallet?.name}</strong> <Addr a={status.wallet?.address} />
          </span>
          <span className="wallet-balance">{account ? <Eth wei={account.balance_wei} digits={4} /> : "…"}</span>
          {status.serving && <Chip tone="good">Serving</Chip>}
          <button type="button" className="btn ghost small" aria-expanded={activityOpen} onClick={onActivity}>
            Activity
          </button>
          <ActionButton
            className="btn ghost small"
            busyText="Locking…"
            run={async () => {
              await post("/api/lock");
              refresh();
            }}
          >
            Lock
          </ActionButton>
        </div>
      </div>
    </header>
  );
}
