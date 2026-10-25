import { useEffect, useMemo, useState } from "react";
import type { NetSignal } from "./api";
import { Activity } from "./components/Activity";
import { Header } from "./components/Header";
import { SessionContext, usePoll, useRoute, type Session } from "./hooks";
import { Home } from "./screens/Home";
import { JobDetailScreen } from "./screens/JobDetail";
import { Jobs } from "./screens/Jobs";
import { Market } from "./screens/Market";
import { Post } from "./screens/Post";
import { ProviderScreen } from "./screens/Provider";
import { Start } from "./screens/Start";
import type { Account, Status, TaskInfo } from "./types";

export default function App() {
  const status = usePoll<Status>("/api/status", 5000);
  const unlocked = status.data?.unlocked === true;
  const account = usePoll<Account>(unlocked ? "/api/account" : null, 5000);
  const tasks = usePoll<TaskInfo[]>(unlocked ? "/api/tasks" : null, 0);
  const [offline, setOffline] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const route = useRoute();

  useEffect(() => {
    const onNet = (e: Event) => {
      const kind = (e as CustomEvent<NetSignal>).detail;
      if (kind === "locked") status.reload();
      setOffline(kind === "offline");
    };
    window.addEventListener("degpu:net", onNet);
    return () => window.removeEventListener("degpu:net", onNet);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const session = useMemo<Session | null>(
    () =>
      unlocked && status.data
        ? {
            status: status.data,
            account: account.data,
            me: status.data.wallet?.address ?? "",
            tasks: tasks.data ?? [],
            refresh: () => {
              status.reload();
              account.reload();
            },
          }
        : null,
    [unlocked, status.data, account.data, tasks.data], // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (!status.data) {
    return (
      <main className="start">
        <section className="start-intro">
          <h1 className="wordmark">DeGPU</h1>
          {status.error ? (
            <>
              <p className="lede">{status.error.message}</p>
              <p className="muted">This page needs the DeGPU app running on this computer, at http://127.0.0.1:8700.</p>
            </>
          ) : (
            <p className="muted">Connecting to your DeGPU app…</p>
          )}
        </section>
      </main>
    );
  }

  if (!session) return <Start status={status.data} onUnlocked={() => status.reload()} />;

  const [section, ...rest] = route.split("/");
  const screen =
    section === "market" ? <Market /> :
    section === "post" ? <Post /> :
    section === "jobs" && rest.length ? <JobDetailScreen jobRef={rest.join("/")} /> :
    section === "jobs" ? <Jobs /> :
    section === "provider" ? <ProviderScreen /> :
    <Home />;

  return (
    <SessionContext.Provider value={session}>
      <div className={`shell${activityOpen ? " with-activity" : ""}`}>
        <Header activityOpen={activityOpen} onActivity={() => setActivityOpen((o) => !o)} />
        {offline && (
          <div className="banner" role="status">
            Can't reach the network host. Check that the host laptop is running "degpu host" and that you're on the
            same Wi-Fi. This clears by itself once it's back.
          </div>
        )}
        <div className="body">
          <main className="page">{screen}</main>
          <Activity open={activityOpen} onClose={() => setActivityOpen(false)} />
        </div>
        <footer className="footer muted small">
          Connected to {status.data.network?.url ?? "no network"}
          {status.data.network && "chain_id" in status.data.network ? `, chain ${status.data.network.chain_id}` : ""}
        </footer>
      </div>
    </SessionContext.Provider>
  );
}
