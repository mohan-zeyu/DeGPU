import { useMemo, useState } from "react";
import { postForm } from "../api";
import { go, usePoll, useSession } from "../hooks";
import { countFrames, formatEth, plural, sameAddress, sentence } from "../format";
import { Addr, ErrorText, Eth } from "../components/ui";
import { MODE_WORDS } from "../words";
import { caught, jobsDone } from "./Market";
import type { JobDetail, Provider, TaskField, TaskInfo } from "../types";

type Values = Record<string, string | boolean>;
type Files = Record<string, File[]>;

function initialValues(task: TaskInfo): Values {
  const v: Values = {};
  for (const f of task.fields) {
    if (f.type === "bool") v[f.name] = Boolean(f.default);
    else if (f.type !== "file" && f.type !== "files") v[f.name] = f.default == null ? "" : String(f.default);
  }
  return v;
}

function label(f: TaskField): string {
  const s = f.name.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function basename(p: unknown): string {
  return String(p ?? "").split(/[\\/]/).pop() ?? "";
}

/** How many items the job will have, from the inputs (null: can't tell before posting). */
function itemCount(task: TaskInfo, values: Values, files: Files): number | null {
  if (task.name === "image-classify-v1") {
    const picked = (files.images ?? []).filter((f) => f.name.endsWith(".jpg")).length;
    return files.images?.length ? Math.min(picked, Number(values.limit) || 0) : null;
  }
  if (task.name === "key-search-v1") return (Number(values.keys) || 0) + (Number(values.impossible) || 0);
  if (task.name === "blender-render-v1") return countFrames(String(values.frames ?? ""));
  return null;
}

export function Post() {
  const { me, tasks, account, refresh } = useSession();
  const providers = usePoll<Provider[]>("/api/providers", 10000);
  const [taskName, setTaskName] = useState<string>("");
  const task = tasks.find((t) => t.name === taskName) ?? tasks.find((t) => t.runs_here) ?? tasks[0];
  const [values, setValues] = useState<Values>({});
  const [files, setFiles] = useState<Files>({});
  const [main, setMain] = useState("");
  const [verify, setVerify] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const vals = useMemo(() => (task ? { ...initialValues(task), ...values } : {}), [task, values]);
  const eligible = useMemo(
    () =>
      task
        ? (providers.data ?? [])
            .filter((p) => p.active && !sameAddress(p.address, me) && (p.prices_wei[task.name] ?? "0") !== "0")
            .sort((a, b) => (BigInt(a.prices_wei[task.name]) < BigInt(b.prices_wei[task.name]) ? -1 : 1))
        : [],
    [providers.data, task, me],
  );
  const chosen = eligible.find((p) => sameAddress(p.address, main)) ?? eligible[0];

  if (!task) return <p className="muted">Loading task types…</p>;

  const replicated = task.mode === "replicated";
  const n = itemCount(task, vals, files);
  const price = chosen ? BigInt(chosen.prices_wei[task.name]) : null;
  const deposit = n != null && price != null ? BigInt(replicated ? 2 : 1) * BigInt(n) * price : null;
  // Images from the default folder: the count is only known on posting, but never above the limit.
  const atMost =
    n == null && price != null && task.name === "image-classify-v1" ? 2n * BigInt(Number(vals.limit) || 0) * price : null;
  const balance = account ? BigInt(account.balance_wei) : null;
  const tooPoor = (deposit ?? atMost) != null && balance != null && (deposit ?? atMost)! > balance;
  const others = chosen ? eligible.length - 1 : eligible.length;
  const posting = progress !== null;

  function pickTask(name: string) {
    setTaskName(name);
    setValues({});
    setFiles({});
    setVerify(false);
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!chosen) return setError("Pick a provider first.");
    const form = new FormData();
    form.append("task", task.name);
    form.append("main", chosen.address);
    form.append("verify", replicated && verify ? "true" : "false");
    for (const f of task.fields) {
      if (f.type === "file" || f.type === "files") {
        for (const file of files[f.name] ?? []) form.append(f.name, file);
      } else if (f.type === "bool") {
        if (vals[f.name]) form.append(f.name, "true");
      } else if (String(vals[f.name] ?? "") !== "") {
        form.append(f.name, String(vals[f.name]));
      }
    }
    setError(null);
    setProgress(0);
    try {
      const job = await postForm<JobDetail>("/api/jobs", form, setProgress);
      refresh();
      go(`jobs/${job.ref}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  }

  return (
    <>
      <h1>Buy compute</h1>
      <p className="lede">Choose what to run, give it your inputs, and pick who runs it. You pay a deposit now; whatever isn't earned comes back when the job closes.</p>

      <form className="post" onSubmit={submit}>
        <fieldset className="step">
          <legend>What to run</legend>
          <div className="task-picks">
            {tasks.map((t) => (
              <label key={t.name} className={`task-pick${t.name === task.name ? " picked" : ""}`}>
                <input type="radio" name="task" checked={t.name === task.name} onChange={() => pickTask(t.name)} />
                <span className="task-pick-name">{t.name}</span>
                <span>{sentence(t.description)}</span>
                <span className="muted small">{MODE_WORDS[t.mode]}</span>
              </label>
            ))}
          </div>
          {task.code_matches === false && (
            <p className="note tone-warn">
              Your DeGPU code for this task differs from the network's version, so providers will refuse the job. Update
              the code first.
            </p>
          )}
        </fieldset>

        <fieldset className="step">
          <legend>Inputs</legend>
          {task.fields.map((f) => (
            <FieldInput
              key={`${task.name}-${f.name}`}
              field={f}
              value={vals[f.name]}
              files={files[f.name]}
              onValue={(v) => setValues((old) => ({ ...old, [f.name]: v }))}
              onFiles={(list) => setFiles((old) => ({ ...old, [f.name]: list }))}
            />
          ))}
        </fieldset>

        <fieldset className="step">
          <legend>Who runs it</legend>
          {!providers.data ? (
            <p className="muted">Loading providers…</p>
          ) : eligible.length === 0 ? (
            <p className="note tone-warn">Nobody else offers {task.name} right now. Ask a classmate to start serving it.</p>
          ) : (
            <div className="table-wrap">
              <table className="table pick">
                <thead>
                  <tr>
                    <th aria-label="Choose" />
                    <th>Provider</th>
                    <th className="right">Price per item</th>
                    <th className="right">Jobs done</th>
                    <th className="right">Caught cheating</th>
                  </tr>
                </thead>
                <tbody>
                  {eligible.map((p) => (
                    <tr key={p.address} className={p === chosen ? "picked" : undefined} onClick={() => setMain(p.address)}>
                      <td>
                        <input
                          type="radio"
                          name="main"
                          aria-label={`Choose ${p.address}`}
                          checked={p === chosen}
                          onChange={() => setMain(p.address)}
                        />
                      </td>
                      <td>
                        <Addr a={p.address} copy={false} />
                      </td>
                      <td className="right">
                        <Eth wei={p.prices_wei[task.name]} />
                      </td>
                      <td className="right num">{jobsDone(p)}</td>
                      <td className={`right num${caught(p) ? " tone-text-bad" : ""}`}>{caught(p)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </fieldset>

        {replicated && (
          <fieldset className="step">
            <legend>Verification</legend>
            <label className="switch">
              <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
              <span>Ask for full verification</span>
            </label>
            <p className="muted">
              It stays secret: providers can't tell which jobs get checked, so they have to do every job honestly. The
              deposit is the same either way. If the job isn't verified, half of it comes back.
            </p>
            {verify && chosen && others < 2 && (
              <p className="note tone-warn">
                Not enough other providers are online ({others} besides the one you picked; 2 are needed). This job will
                run unverified.
              </p>
            )}
            {verify && chosen && others === 2 && (
              <p className="note tone-warn">Only 2 other providers: verification works, but nobody is left to settle a disagreement.</p>
            )}
          </fieldset>
        )}

        <div className="cost" aria-live="polite">
          <div>
            <span className="muted">Deposit</span>
            <strong className="cost-value">
              {deposit != null ? formatEth(deposit) : atMost != null ? `At most ${formatEth(atMost)}` : n == null ? "Depends on the inputs" : "—"}
            </strong>
            <span className="muted small">
              {n != null && price != null
                ? `${replicated ? "2 × " : ""}${plural(n, "item")} × ${formatEth(price)}`
                : task.name === "image-classify-v1" && !files.images?.length
                  ? `Up to ${vals.limit} images from the default folder on this computer`
                  : ""}
            </span>
          </div>
          <div>
            <span className="muted">Your balance</span>
            <strong className="cost-value">{account ? formatEth(account.balance_wei) : "…"}</strong>
            {tooPoor && <span className="small tone-text-bad">Not enough for this deposit</span>}
          </div>
          <div className="cost-action">
            <button type="submit" className="btn primary" disabled={posting || !chosen || tooPoor || n === 0}>
              {posting ? (progress! < 1 ? `Uploading ${Math.round(progress! * 100)}%` : "Encrypting and posting…") : "Post the job"}
            </button>
          </div>
        </div>
        {posting && <progress className="upload" value={progress ?? 0} max={1} aria-label="Upload progress" />}
        <ErrorText error={error} />
      </form>
    </>
  );
}

function FieldInput({
  field: f,
  value,
  files,
  onValue,
  onFiles,
}: {
  field: TaskField;
  value: string | boolean | undefined;
  files: File[] | undefined;
  onValue: (v: string | boolean) => void;
  onFiles: (files: File[]) => void;
}) {
  if (f.type === "bool") {
    return (
      <label className="switch">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onValue(e.target.checked)} />
        <span>{label(f)}</span>
        {f.help && <small>{f.help}</small>}
      </label>
    );
  }
  if (f.type === "file" || f.type === "files") {
    const many = f.type === "files";
    const accept = f.name === "images" ? ".jpg" : f.name === "model" ? ".onnx" : f.name === "scene" ? ".blend" : undefined;
    return (
      <label className="field">
        <span>{label(f)}</span>
        <input type="file" multiple={many} accept={accept} onChange={(e) => onFiles(Array.from(e.target.files ?? []))} />
        <small>
          {f.help ? `${f.help.charAt(0).toUpperCase()}${f.help.slice(1)}. ` : ""}
          {files?.length
            ? `${plural(files.length, "file")} picked.`
            : f.default
              ? `Leave empty to use ${basename(f.default)} on this computer.`
              : "Required."}
        </small>
      </label>
    );
  }
  return (
    <label className="field">
      <span>{label(f)}</span>
      <input
        type={f.type === "str" ? "text" : "number"}
        step={f.type === "float" ? "any" : 1}
        min={f.type === "str" ? undefined : 0}
        value={String(value ?? "")}
        onChange={(e) => onValue(e.target.value)}
      />
      {f.help && <small>{`${f.help.charAt(0).toUpperCase()}${f.help.slice(1)}.`}</small>}
    </label>
  );
}
