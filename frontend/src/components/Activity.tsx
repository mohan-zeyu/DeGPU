import { useEffect, useRef, useState } from "react";
import { get } from "../api";
import { clock } from "../format";
import type { ActivityLine } from "../types";

const KEEP = 500;

/** The app's log: manual actions and the automatic steps (reveals, shares, checks...). */
export function Activity({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [lines, setLines] = useState<ActivityLine[]>([]);
  const last = useRef(0);
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let timer: number | undefined;
    const run = async () => {
      try {
        const fresh = await get<ActivityLine[]>(`/api/activity?after=${last.current}`);
        if (!stopped && fresh.length) {
          last.current = fresh[fresh.length - 1].seq;
          setLines((old) => [...old, ...fresh].slice(-KEEP));
        }
      } catch {
        // the header and banners report connection trouble; just try again
      }
      if (!stopped) timer = window.setTimeout(run, 2000);
    };
    run();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: "end" });
  }, [lines]);

  if (!open) return null;
  return (
    <aside className="activity" aria-label="Activity">
      <div className="activity-head">
        <h2>Activity</h2>
        <button type="button" className="btn ghost small" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted small">What your app did, including the steps it takes by itself.</p>
      {lines.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <ol className="activity-list" ref={list}>
          {lines.map((l) => {
            const m = l.message.match(/^\[(\w+)\]\s*(.*)$/);
            return (
              <li key={l.seq} className={`line line-${m?.[1] ?? "node"}`}>
                <time className="num">{clock(l.time)}</time>
                <span>{m ? m[2] : l.message}</span>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
