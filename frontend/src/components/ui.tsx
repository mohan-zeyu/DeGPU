import { useRef, useState, type ReactNode } from "react";
import { formatEth, sameAddress, sentence, short } from "../format";
import type { Tone } from "../words";

export function Eth({ wei, digits }: { wei: string | bigint; digits?: number }) {
  return <span className="num">{formatEth(wei, digits)}</span>;
}

/** An address: "you" for your own, else short with the full one on hover, plus a copy button. */
export function Addr({ a, me, copy = true }: { a: string | null | undefined; me?: string; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!a) return <span className="muted">—</span>;
  if (me && sameAddress(a, me)) return <span className="you">you</span>;
  return (
    <span className="addr" title={a}>
      {short(a)}
      {copy && (
        <button
          type="button"
          className="copy"
          aria-label={`Copy address ${a}`}
          onClick={() => {
            navigator.clipboard?.writeText(a).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </span>
  );
}

export function Chip({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`chip tone-${tone}`}>{children}</span>;
}

export function ErrorText({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    <p className="error" role="alert">
      {sentence(error)}
    </p>
  );
}

interface Question {
  title: string;
  body: string;
  yes: string;
  no: string;
  danger?: boolean;
}

/** A modal yes/no question. `ask` resolves true on the confirm button. */
export function useConfirm(): [ReactNode, (q: Question) => Promise<boolean>] {
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState<Question | null>(null);
  const answer = useRef<(v: boolean) => void>(() => {});
  const ask = (next: Question) => {
    setQ(next);
    window.setTimeout(() => ref.current?.showModal());
    return new Promise<boolean>((resolve) => (answer.current = resolve));
  };
  const close = (v: boolean) => {
    ref.current?.close();
    answer.current(v);
  };
  const dialog = (
    <dialog ref={ref} className="dialog" onCancel={() => answer.current(false)}>
      {q && (
        <>
          <h2>{q.title}</h2>
          <p>{q.body}</p>
          <div className="row end">
            <button type="button" className="btn ghost" onClick={() => close(false)}>
              {q.no}
            </button>
            <button type="button" className={`btn ${q.danger ? "danger" : "primary"}`} onClick={() => close(true)}>
              {q.yes}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
  return [dialog, ask];
}

/** A button that runs an async action, shows "Working…" and reports the error under it. */
export function ActionButton({
  run,
  children,
  className = "btn primary",
  disabled,
  busyText = "Working…",
}: {
  run: () => Promise<unknown>;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  busyText?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="action">
      <button
        type="button"
        className={className}
        disabled={disabled || busy}
        aria-busy={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await run();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? busyText : children}
      </button>
      <ErrorText error={error} />
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
    </div>
  );
}
