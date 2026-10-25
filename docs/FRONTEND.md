# DeGPU frontend guide

This document is for building the GUI. The GUI is a web page that talks **only** to the user's local DeGPU app, through the HTTP API in [API.md](API.md). That file is the reference for every endpoint. This one says what to build on top of it: the screens, which calls each screen makes, what to show, the rules for buttons, and the TypeScript types.

```
 browser: GUI (React) ──fetch /api/...──▶ DeGPU app on 127.0.0.1:8700 ──▶ network host
                                          (wallet, automatic steps)
```

The GUI never talks to the chain, the host or a wallet extension. The app does all of that, including the automatic steps of every job. The GUI shows state and sends the user's **manual** actions.

**Status: built.** The GUI is in `frontend/`, and its build is committed in `degpu/web/`. `uv run degpu app` serves it at <http://127.0.0.1:8700/>.

| File | What it holds |
|---|---|
| `src/api.ts`, `src/types.ts` | The fetch helper (§2.1) and the API's types (§5) |
| `src/format.ts`, `src/words.ts` | Money and time formatting (§2.2), and the words for every code (§4) |
| `src/hooks.ts` | Polling (§2.3), hash routes, and the session every screen reads |
| `src/screens/` | One file per screen in §3: `Start`, `Home`, `Market`, `Post`, `Jobs`, `JobDetail`, `Provider` |
| `src/components/` | Header, activity drawer, the job's route of stations, the outcome stamp, small UI parts |
| `src/styles.css` | All styles. The design treats every job as a work ticket that gets an outcome stamp; the stamp is the one loud element. |

To change the GUI:

```bash
cd frontend && npm install     # once
npm run dev                    # http://localhost:5173, with a running app on :8700
npm run build                  # type-checks, then writes degpu/web/ (commit it)
```

## 1. Setup

| | |
|---|---|
| Stack | React + Vite + TypeScript, in `frontend/` |
| Dev server | `npm run dev` on port 5173, with Vite proxying `/api` to the app (below). The code calls relative URLs such as `/api/status`. |
| Build | `npm run build` writes to `degpu/web/`, which we commit. The app serves it at <http://127.0.0.1:8700/>, so users need only Python. |
| Routing | Hash routes (`#/market`, `#/jobs/replicated:3`). The app serves plain files, so path routes would 404 on reload. |

```ts
// frontend/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8700" } },
  build: { outDir: "../degpu/web", emptyOutDir: true },
});
```

To try it you need a network and an app:

```bash
uv run degpu host --bind 127.0.0.1                                    # terminal 1
uv run degpu app --network http://127.0.0.1:8600 --locked             # terminal 2: start locked, unlock in the GUI
cd frontend && npm run dev                                            # terminal 3
```

To have providers to buy from, start more apps on other ports with other wallets (`--port 8701 --wallet p1`, and so on), then register and serve them with the CLI (`uv run degpu --app http://127.0.0.1:8701 provider register`). A verified job needs at least 3 providers besides the client, and a tie-break a 4th.

## 2. Talking to the API

### 2.1 One fetch helper

Every POST must send `X-DeGPU: 1`; without it the app answers 403. Errors always come as `{"detail": "..."}`, a sentence you can show to the user as is.

```ts
// frontend/src/api.ts
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-DeGPU", "1");
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const r = await fetch(path, { ...init, headers });
  if (!r.ok) {
    const body = await r.json().catch(() => ({ detail: r.statusText }));
    throw new ApiError(r.status, body.detail ?? r.statusText);
  }
  return r.json();
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
```

| Status | What the GUI does |
|---|---|
| 400 | Show `detail` next to the button that caused it, e.g. "this job needs a deposit of 0.04 ETH; you have 0.01 ETH". |
| 403 | A bug in the GUI (missing header). Log it. |
| 404 | "Not found". |
| 423 | No wallet unlocked: go to the start screen (§3.1). |
| 503 | A banner: "Can't reach the network host. Is the host laptop on the same Wi-Fi?" Keep polling; it clears by itself. |

### 2.2 Money: wei as strings

Amounts are **wei as decimal strings** (`"1000000000000000000"` = 1 ETH). Never turn them into a JavaScript `number`: 1 ETH is bigger than 2^53. Use `BigInt`:

```ts
const WEI = 10n ** 18n;

/** "1500000000000000000" -> "1.5 ETH" (at most `digits` decimals, trailing zeros cut) */
export function formatEth(wei: string, digits = 6): string {
  const v = BigInt(wei), neg = v < 0n, a = neg ? -v : v;
  const frac = (a % WEI).toString().padStart(18, "0").slice(0, digits).replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / WEI}${frac ? "." + frac : ""} ETH`;
}

/** what the user typed ("0.25") -> wei string; throws on bad input */
export function parseEth(text: string): string {
  const m = text.trim().match(/^(\d+)(?:\.(\d{0,18}))?$/);
  if (!m) throw new Error("type an amount like 0.25");
  return (BigInt(m[1]) * WEI + BigInt((m[2] ?? "").padEnd(18, "0"))).toString();
}
```

In results and event arguments, other integers of 2^53 or more are decimal strings too, such as found keys. Show them as text.

### 2.3 Polling

The API has no push. Poll, and only while the screen is visible:

| What | Call | Every |
|---|---|---|
| Header: wallet, balance, serving | `GET /api/status`, `GET /api/account` | 5 s |
| My jobs list | `GET /api/jobs` | 3 s |
| An open job's detail | `GET /api/jobs/{ref}` | 2 s; stop once `closed` is true |
| Activity panel | `GET /api/activity?after=<last seq>` | 2 s |
| Market providers | `GET /api/providers` | 10 s. It reads about 16 values from the chain per provider, so don't poll it faster. |
| Me as provider | `GET /api/provider` | 5 s, on the provider screen only |
| Tasks | `GET /api/tasks` | Once per unlock (it rarely changes) |

## 3. Screens

| Screen | Route | Shown when |
|---|---|---|
| Start (join and unlock) | `#/start` | `status.unlocked` is false, or any call answered 423 |
| Home | `#/` | Unlocked |
| Market | `#/market` | |
| Post a job | `#/post` | |
| My jobs | `#/jobs` | |
| Job detail | `#/jobs/<ref>` | |
| Provide compute | `#/provider` | |
| Activity | A side panel or drawer, on every screen | |

Every unlocked screen has a **header**:
- wallet name and short address (`0x8B72…DD71`) with a copy button;
- the balance;
- a "Serving" badge when `status.serving` is true;
- the network URL;
- a **Lock** button (`POST /api/lock`, then go to Start).

### 3.1 Start: join and unlock

Calls: `GET /api/status` (its `network.url` is the remembered network) and `GET /api/wallets`.

Three forms:

| Form | Fields | Calls |
|---|---|---|
| **Unlock** (default when there are wallets) | Wallet (select from the list), password, network URL (prefilled from `status.network.url`; placeholder `http://192.168.1.20:8600`) | `POST /api/unlock {name, password, network}` |
| **New wallet** | Name, password, repeat password | `POST /api/wallets {name, password}`, then unlock with the same values |
| **Import wallet** | Name, private key (a password-type input), password, repeat | `POST /api/wallets {name, password, private_key}`, then unlock |

Rules:
- A wallet name is 1–32 letters, digits, `-` or `_`. Check it before sending.
- Unlocking takes 1–2 seconds (the key file is decrypted, then the node joins the network). Show a spinner and disable the button.
- **Never** store a password or private key: not in `localStorage`, not in logs. Clear the key field right after the request.
- Say under the Import form: "Your key is saved encrypted on this computer only. Use a test wallet, not one holding real money."

### 3.2 Home

- **Balance** large. If it's `"0"`, show a **Get test ETH** button (`POST /api/faucet`). On success, show `formatEth(amount_wei)` received. On 400 ("already got its test ETH"), show the message and hide the button.
- **Two big choices:** "Buy compute" → Post a job; "Sell compute" → Provide compute.
- **Running jobs:** from `GET /api/jobs`, those with `closed` false, as cards (§3.5).
- **"Keep this app running"** notice while you are the client or a provider of any open job. The automatic steps need the app.

### 3.3 Market

Calls: `GET /api/providers` and `GET /api/tasks`.

**Providers table**, one row per provider:

| Column | From |
|---|---|
| Address | `address`, short. Mark your own row "you". |
| Stake | `formatEth(stake_wei)` |
| State | `active` ? "Active" : "Inactive (stake below minimum)". `open_jobs` jobs in progress. |
| One column per task | `prices_wei[task]` as ETH per item, or "—" when `"0"` |
| Record | Main provider: `record.replicated.verified_completed + unverified_completed` jobs done, `outvoted` caught cheating, `missed` deadlines missed. Checked tasks: `record.checked.completed`. Highlight `outvoted` > 0 in red. |

**Tasks list:** `name`, `description`, the mode in words (§4.1), `default_price_wei` per item, and "can run on this computer" (`runs_here`). If `code_matches` is false, warn: "Your DeGPU code for this task is different from the network's version. Providers will refuse your jobs. Update the code."

### 3.4 Post a job

A form in four parts. Call `GET /api/tasks`, `GET /api/providers`, `GET /api/account`.

**1. Task:** pick one from `/api/tasks`.

**2. Inputs:** one control per entry of the task's `fields`, by `type`:

| `type` | Control | Sent as |
|---|---|---|
| `int`, `float` | Number input, prefilled with `default` | `form.append(name, value)` |
| `str` | Text input, prefilled with `default` | the same |
| `bool` | Checkbox | `"true"` when checked; leave it out otherwise |
| `file` | File picker (one file) | `form.append(name, file)` |
| `files` | File picker with `multiple` (`accept=".jpg"` for `images`) | `form.append(name, file)` once per file |

Show `help` under each control. An upload left empty uses `default`: a path on this computer, used only if it exists. Show it as "Default: mobilenetv2.onnx". If the user picks nothing and the default doesn't exist, the app answers 400 with the reason.

**3. Provider:** the eligible providers are those with `active` true, `prices_wei[task] !== "0"` and an address that isn't yours. List them cheapest first, showing the price per item and their record. Pick one; it becomes `main`.

**4. Verify** (replicated tasks only): a switch, off by default, with this text: "Ask for full verification. It stays secret: providers can't tell which jobs are checked. The deposit is the same either way, and if the job isn't verified, half of it comes back."

**Cost box.** Before sending, work out the number of items N:

| Task | N |
|---|---|
| `image-classify-v1` | min(number of `.jpg` files picked, `limit`) |
| `key-search-v1` | `keys + impossible` |
| `blender-render-v1` | Frames in `frames` (`"1-12"` → 12, `"1,5,9"` → 3, mixes like `"1-4,9"` → 5) |
| Any other task | Not known: show "the deposit depends on the inputs" |

- Deposit = (replicated ? 2 : 1) × N × price. Show it with `formatEth` next to the balance, and disable **Post** if it's higher.
- Without verification, a replicated job's client gets half back. In checked jobs, puzzles with no answer are refunded.

**Verification warning.** Count the eligible providers other than the chosen main. With verify on:
- fewer than 2: "Not enough other providers online: this job will run unverified";
- exactly 2: "No tie-breaker available: disagreements can't be settled".

**Send.**
- Build a `FormData` with `task`, `main`, `verify` and the fields, then `POST /api/jobs`.
- Use `XMLHttpRequest` (or axios) instead of `fetch` to show upload progress, because a model plus 200 images is tens of MB. Remember the `X-DeGPU` header.
- The request also waits while the app encrypts and uploads to the host. Keep a spinner after the upload reaches 100%.
- The answer is the new job: go to its detail screen.

### 3.5 My jobs

Call: `GET /api/jobs`. There are two tabs: **Bought** (`role === "client"`) and **Worked on** (`main`, `verifier` or `tiebreaker`).

Each row shows:
- `ref`, `task` and `num_items` items;
- the role in words (§4.3);
- the status in words (§4.1), or the outcome in words and colour once `closed` (§4.2);
- for an open job, the time left until `deadline`.

The deposit (`deposit_wei`) appears on Bought rows only.

### 3.6 Job detail

Call `GET /api/jobs/{ref}` every 2 s until `closed`.

**Progress.** A step bar, with the current `status` highlighted:
- replicated: open → committing → deciding → checking → check_reveal → publishing → (disputing) → (tie_break) → closed;
- checked: open → working → closed.

Steps the job skipped show grey. For example, an unverified job goes from deciding straight to publishing. Below the bar, show the status sentence from §4.1 and the time left until `deadline`.

**Parties:**
- client and main;
- each of `verifiers`: address, the state in words (§4.4) and its items (`items: [start, end]` means start to end − 1);
- `tiebreaker` with the `mismatched` items.

Mark "you" wherever your address appears. If `verified` is true, show "Verified" as a badge. If `dropped` isn't `"none"`, explain it: `client_no_reveal` is "your app was closed and didn't reveal the decision in time, so the job counts as unverified"; `no_eligible_verifier` is "not enough providers to verify".

**Timeline:** the `timeline` events in order, each with a time (`HH:MM:SS` from `time`) and the event in words (§4.5). For money:
- a `Payout` with `args.to === you` is "You received X";
- a `ProviderSlashed` with `args.provider === you` is "You were slashed X".

`args.amount` may be a number or a string, so use `BigInt(String(args.amount))`.

**Actions**, each behind a confirmation dialog:

| Button | Shown when | Call |
|---|---|---|
| Cancel | `status === "open"` and (you are the client, or `deadline` has passed) | `POST /api/jobs/{ref}/cancel` |
| Move on (expire) | Not `closed`, and the current time is past `deadline` | `POST /api/jobs/{ref}/expire` |

Explain Expire as: "The deadline passed. This settles the job: whoever didn't act in time is slashed." The contract has the final say, so show any 400 `detail` as is.

**Results** (only when you are the client). Call `GET /api/jobs/{ref}/results` once the status is `publishing` or later, or `closed`. Before that, or on 400 "no results yet", show "No results yet".

| `kind` | Show |
|---|---|
| `value` | A table of index → value. **image-classify-v1:** the value is an ImageNet class number from 0 to 999, so show its name from a bundled `imagenet-classes.json` (the standard 1000-name list), with the number in small text. **key-search-v1:** the found key as text, or "not found" for `null`. |
| `file` | A grid of `<img src={item.file}>` (renders are PNG), each with a download link. `file: null` means "missing". |

Items with `mismatched: true` get a badge. What it means depends on the job's `outcome`:

| Outcome | Text for mismatched items |
|---|---|
| `verifier_outvoted` | "Checked twice: this result is right (a verifier was wrong)." |
| `main_outvoted` | "This result is wrong: the provider cheated on it. You were compensated." Show the value struck through. |
| `both_outvoted`, `no_majority` | "Disputed: this result may be wrong." |

### 3.7 Provide compute

Call `GET /api/provider` (it includes `serving`, `behavior`, `min_stake_wei`), plus `GET /api/tasks`.

**Not registered yet** (`registered` false): a form.
- **Stake:** default 1 ETH; at least `formatEth(min_stake_wei)`.
- **Prices:** one per task, prefilled with `default_price_wei`. Tasks with `runs_here` false are disabled with the reason "can't run on this computer (software missing)".
- **Register** → `POST /api/provider/register {stake_wei, prices_wei}`. Then offer **Start serving**.

**Registered:**

| Part | What it does |
|---|---|
| **Serve switch** | `POST /api/provider/serve {on}`. When on: "Your computer accepts and runs jobs by itself while this app is open." When the user switches it off, ask "Also stop offering your tasks?", because verifiers are drawn from everyone who offers a task, and a drawn provider that doesn't answer is slashed. On yes, send `POST /api/provider/prices` with every price `"0"`. Always show the `warning` from the answer if there is one. |
| **Stake** | `stake_wei`, plus "Inactive: stake below minimum" when `active` is false. **Add** → `POST /api/provider/stake {amount_wei}`. **Withdraw** → `POST /api/provider/withdraw {amount_wei}`, disabled while `open_jobs > 0`, with the reason "you're in an open job". |
| **Prices** | An editable price per task, saved with one `POST /api/provider/prices {prices_wei}` for the changed tasks. `"0"` means not offered. |
| **Record** | The `record` counters (names in §4.6). |
| **Presentation mode** | Hidden behind a "Presentation mode" switch: a select for `behavior` (`honest`, `cheat`, `liar`, `offline`), sent with `POST /api/provider/serve {on: true, behavior}`. Show a red banner while it isn't `honest`: "This provider is cheating on purpose, for the demo." |

### 3.8 Activity panel

Poll `GET /api/activity?after=<last seq>`, append the new lines, and keep the last 500. Show the time (`HH:MM:SS`) and `message`. Messages start with `[client]`, `[provider]`, `[wallet]` or `[node]`, which can colour the lines. This is where the user sees the automatic steps happen ("revealed decision", "shared items 0-99 with verifier …").

## 4. Words to show

Use these texts, or your own, but never the raw codes.

### 4.1 Status

| Mode | `status` | Words |
|---|---|---|
| both | `open` | Waiting for the provider to accept |
| replicated | `committing` | The provider is computing |
| replicated | `deciding` | Your app is revealing the secret decision |
| replicated | `checking` | Verifiers are re-running the work |
| replicated | `check_reveal` | Verifiers are showing their results |
| replicated | `publishing` | The provider is publishing the results |
| replicated | `disputing` | Your app is comparing the rendered frames |
| replicated | `tie_break` | A tie-breaker is settling a disagreement |
| checked | `working` | The provider is solving the puzzles |
| both | `closed` | Finished (see the outcome) |

The modes in words: `replicated` is "checked by re-running on other providers"; `checked` is "every answer checked by the contract".

### 4.2 Outcome

Tones: good = green, neutral = grey, warn = orange, bad = red. Write "your money" for the client; providers can be told the same from their side.

| `outcome` | Words | Tone |
|---|---|---|
| `none` | Still running | neutral |
| `cancelled` | Cancelled; the deposit went back | neutral |
| `delivered` | Done (not verified) | good |
| `verified` | Done and verified | good |
| `main_outvoted` | The provider cheated and was slashed; you were compensated | bad |
| `verifier_outvoted` | A verifier was wrong and was slashed; the results are right | warn |
| `both_outvoted` | The provider and a verifier were each wrong on some items | bad |
| `no_majority` | Some items couldn't be settled | warn |
| `main_missed` | The provider missed its deadline and was slashed; you were refunded | bad |
| `tiebreaker_missed` | The tie-breaker missed its deadline | warn |
| `tie_client_no_share` | Your app didn't send the disputed items in time | warn |
| `dispute_rejected` | Your app's dispute was wrong; its bond paid the tie-breaker | warn |

### 4.3 Role

| `role` | Words |
|---|---|
| `client` | You bought this |
| `main` | You did the work |
| `verifier` | You checked the work |
| `tiebreaker` | You settled a disagreement |
| `null` | Not your job |

### 4.4 Verifier state

| `state` | Words |
|---|---|
| `assigned` | Drawn; waiting for your app to send the items |
| `shared` | Re-running |
| `committed` | Finished; result sealed |
| `revealed` | Result shown |
| `no_share` | Your app didn't send the items (the verifier is still paid) |
| `bad_input` | Reported the items as broken |
| `missed` | Missed the deadline (slashed) |
| `outvoted` | Was wrong (slashed) |

### 4.5 Timeline events

| `event` | Words |
|---|---|
| `JobCreated` | Job posted |
| `JobAccepted` | The provider accepted |
| `ResultsCommitted` | The provider sealed its results |
| `DecisionRevealed` | Secret decision revealed: verify (`args.verify`) or not |
| `VerificationDropped` | Verification skipped (`args.reason`: 1 decision not revealed, 2 not enough providers) |
| `VerifiersDrawn` | Verifiers drawn at random |
| `RangeShared` | Items sent to a verifier |
| `CheckCommitted` | A verifier sealed its check |
| `CheckRevealed` | A verifier showed its check |
| `VerifierDropped` | A verifier dropped out |
| `ResultsPublished` | Results published |
| `ResultsSubmitted` | Answers submitted and checked by the contract |
| `ResultsDisputed` | Your app disputed some frames |
| `TiebreakStarted` | A tie-breaker was drawn |
| `TiebreakShared` | Disputed items sent to the tie-breaker |
| `TiebreakSubmitted`, `JudgementSubmitted` | The tie-breaker decided |
| `ProviderSlashed` | A provider lost stake: `args.provider`, `args.amount` |
| `Payout` | Paid out: `args.to`, `args.amount` |
| `JobClosed` | Job closed |

### 4.6 Record counters

| Key | Words |
|---|---|
| `replicated.verified_completed`, `unverified_completed` | Jobs done (verified, not verified) |
| `replicated.missed`, `replicated.outvoted` | Deadlines missed, caught with wrong results (as the main provider) |
| `replicated.checks_completed`, `checks_missed`, `checks_outvoted` | The same, as a verifier or tie-breaker |
| `checked.completed`, `checked.missed` | Puzzle jobs done, deadlines missed |
| `checked.items_solved`, `items_not_found` | Puzzles solved, puzzles with no answer |

## 5. TypeScript types

These match what the app sends (checked against a live run). Keep them in `frontend/src/types.ts`.

```ts
export type Wei = string;      // decimal string, e.g. "1000000000000000000" = 1 ETH
export type Address = string;  // "0x…" checksummed
export type JobRefStr = string; // "replicated:3"
export type Mode = "replicated" | "checked";
export type Behavior = "honest" | "cheat" | "liar" | "offline";
export type BigNum = number | string; // a string from 2^53 up

export interface NetworkInfo {
  url: string; name: string; chain_id: number; registry: Address; faucet_wei: Wei;
}
export interface Status {
  network: NetworkInfo | { url: string } | null; // only {url} while locked
  wallet: { name: string; address: Address } | null;
  unlocked: boolean;
  serving: boolean;
}
export interface WalletEntry { name: string; address: Address }
export interface Account { address: Address; balance_wei: Wei }
export interface FaucetReply { address: Address; amount_wei: Wei; tx: string }
export interface ActivityLine { seq: number; time: number; message: string }

export interface TaskField {
  name: string;          // the form field name to send
  flag: string;          // the CLI flag, e.g. "--limit"
  type: "int" | "float" | "str" | "bool" | "file" | "files";
  default: number | string | boolean | null;
  help: string | null;
}
export interface TaskInfo {
  name: string; mode: Mode; description: string; task_id: number;
  default_price_wei: Wei; runs_here: boolean; result: "value" | "file";
  fields: TaskField[];
  code_matches?: boolean; // replicated tasks only
}

export interface Provider {
  address: Address; registered: boolean; active: boolean;
  stake_wei: Wei; open_jobs: number;
  prices_wei: Record<string, Wei>;           // task name -> wei per item ("0" = not offered)
  record: Partial<Record<Mode, Record<string, number>>>;
}
export interface MeAsProvider extends Provider {
  serving: boolean; behavior: Behavior; min_stake_wei: Wei;
  warning?: string;                          // only in some POST answers
}

export type Role = "client" | "main" | "verifier" | "tiebreaker" | "provider" | null;
export type ReplicatedStatus = "open" | "committing" | "deciding" | "checking" | "check_reveal"
  | "publishing" | "disputing" | "tie_break" | "closed";
export type CheckedStatus = "open" | "working" | "closed";
export type Outcome = "none" | "cancelled" | "delivered" | "verified" | "main_outvoted"
  | "verifier_outvoted" | "both_outvoted" | "no_majority" | "main_missed" | "tiebreaker_missed"
  | "tie_client_no_share" | "dispute_rejected";
export type VerifierState = "none" | "assigned" | "shared" | "committed" | "revealed" | "no_share"
  | "bad_input" | "missed" | "outvoted";

export interface JobSummary {
  ref: JobRefStr; mode: Mode; id: number; task: string; role: Role;
  status: ReplicatedStatus | CheckedStatus; outcome: Outcome; closed: boolean;
  client: Address; main: Address; num_items: number;
  deposit_wei: Wei; deadline: number;        // unix seconds: end of the current phase
}
export interface TimelineEvent {
  event: string; block: number; time: number;
  args: Record<string, unknown>;             // display only; long bytes come as "<N bytes>"
}
export interface JobDetail extends JobSummary {
  timeline: TimelineEvent[];
  // replicated
  verifiers?: { address: Address; state: VerifierState; items: [number, number] }[];
  tiebreaker?: Address | null;
  decided?: boolean; verified?: boolean;
  dropped?: "none" | "client_no_reveal" | "no_eligible_verifier";
  mismatched?: number[]; dispute_bond_wei?: Wei;
  // checked
  solved?: number;
}

export type Results =
  | { ref: JobRefStr; kind: "value";
      items: { index: number; value: BigNum | null; mismatched: boolean }[] }
  | { ref: JobRefStr; kind: "file"; suffix: string;
      items: { index: number; file: string | null; size: number | null; mismatched: boolean }[] };
```

`role` in `/api/jobs` can also be `"provider"` for a provider job whose exact role wasn't recorded. Show it as "You worked on this".

## 6. Checklist

- Every POST sends `X-DeGPU: 1`. All money stays a wei string or a `BigInt`, never a `number`.
- A 423 from any call goes to the Start screen. A 503 shows the "can't reach the host" banner.
- Passwords and private keys are never stored or logged.
- No polling faster than §2.3. Stop polling a job once it's closed.
- Users always see when the app must stay open: while they're the client of an open job, or while serving.
- Cheating behaviours sit behind "Presentation mode", with a visible banner.
- `npm run build` writes to `degpu/web/`. Check that <http://127.0.0.1:8700/> opens the GUI and that a reload on `#/jobs` works.
