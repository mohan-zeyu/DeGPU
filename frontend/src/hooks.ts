import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ApiError, get } from "./api";
import type { Account, Status, TaskInfo } from "./types";

/** GET `path` now and then every `ms` (0: once), while the page is visible. null: don't. */
export function usePoll<T>(path: string | null, ms: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [tick, setTick] = useState(0);
  const lastPath = useRef(path);

  useEffect(() => {
    if (lastPath.current !== path) {
      lastPath.current = path;
      setData(undefined);
      setError(undefined);
    }
    if (!path) return;
    let stopped = false;
    let first = true; // the first fetch always runs: a page opened in the background still needs its data
    let timer: number | undefined;
    const run = async () => {
      if (first || !document.hidden) {
        first = false;
        try {
          const d = await get<T>(path);
          if (!stopped) {
            setData(d);
            setError(undefined);
          }
        } catch (e) {
          if (!stopped) setError(e instanceof ApiError ? e : new ApiError(0, String(e)));
        }
      }
      if (!stopped && ms > 0) timer = window.setTimeout(run, ms);
    };
    const onVisible = () => {
      if (!document.hidden && ms > 0) {
        window.clearTimeout(timer);
        run();
      }
    };
    run();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path, ms, tick]);

  return { data, error, reload: () => setTick((t) => t + 1) };
}

/** The hash route without "#/", e.g. "jobs/replicated:3". */
export function useRoute(): string {
  const read = () => decodeURIComponent(window.location.hash.replace(/^#\/?/, ""));
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const f = () => {
      setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return route;
}

export function go(to: string) {
  window.location.hash = "/" + to;
}

/** Unix seconds, updated every second (for countdowns). */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/** What every screen of an unlocked app can read. */
export interface Session {
  status: Status;
  account?: Account;
  me: string;
  tasks: TaskInfo[];
  /** Reload status and balance right away (after an action that changes them). */
  refresh: () => void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside an unlocked app");
  return s;
}
