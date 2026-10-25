# DeGPU app API, v1

Every user runs the **DeGPU app** on their own laptop (`uv run degpu app`). The app holds the user's unlocked wallet, does the automatic steps of their jobs in the background, and offers this HTTP API. The `degpu` CLI uses it today; the GUI will use it next. Both do nothing the API can't do.

The running app also serves interactive docs at <http://127.0.0.1:8700/docs> (OpenAPI at `/openapi.json`). Building the GUI on this API (screens, which calls, words to show, TypeScript types): [FRONTEND.md](FRONTEND.md). Once built into `degpu/web/`, the GUI is served at <http://127.0.0.1:8700/>.

```
 GUI / CLI ──HTTP──▶ DeGPU app (127.0.0.1:8700) ──▶ network host (one laptop, port 8600)
                     wallet, automatic steps          chain gateway, file store, faucet
```

## Start

```bash
uv run degpu host                                         # once, on the host laptop: prints the join URL
uv run degpu wallet new alice                             # on each laptop (or: wallet import alice)
uv run degpu app --network http://192.168.1.20:8600 --wallet alice   # asks the password; remembers both
```

`degpu app --locked` starts without a wallet; unlock one later with `POST /api/unlock` (or `degpu unlock NAME`).

## Rules for every request

| Rule | Detail |
|---|---|
| Address | `http://127.0.0.1:8700`. The app answers only requests to `127.0.0.1` or `localhost`, because it holds the key. |
| Header | Every `POST` must send `X-DeGPU: 1`. A web page from another site can't add it without the browser asking first. |
| Bodies | JSON, except `POST /api/jobs`, which is `multipart/form-data` (it uploads files). |
| Amounts | Always in **wei**, as decimal strings: `"1000000000000000000"` is 1 ETH. Requests may also send numbers. |
| Big numbers | In results and event arguments, an integer of 2^53 or more is a decimal string (JavaScript numbers can't hold it). Use `BigInt(x)` for both. |
| Times | Unix seconds. |
| Jobs | Named `<mode>:<id>`, e.g. `replicated:3` or `checked:1`. Ids count per mode. |
| CORS | Allowed from the GUI's dev server, `http://localhost:5173` and `http://127.0.0.1:5173`. |

Errors are `{"detail": "a sentence for the user"}`:

| Code | Meaning |
|---|---|
| 400 | The action was refused: bad input, not enough ETH, or the contract rejected the transaction (`"the transaction was rejected: <reason>"`). |
| 403 | The `X-DeGPU` header is missing, or the request isn't for 127.0.0.1. |
| 404 | No such route or result file. |
| 423 | No wallet is unlocked yet. |
| 503 | The network host can't be reached. |

**Automatic steps need the app running.** A client's app reveals the hidden decision, shares keys with verifiers and reviews render frames. A provider's app accepts, computes and submits. Keep the app open while jobs run. If a client's app is closed, its job still finishes, but the client loses the checks (for example, an unrevealed decision counts as "not verified").

## All endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/api/status` | Network, unlocked wallet, serving or not |
| GET | `/api/wallets` | Wallets on this machine |
| POST | `/api/wallets` | Make a new wallet, or import a private key |
| POST | `/api/unlock` | Unlock a wallet and join the network |
| POST | `/api/lock` | Stop the node and forget the key |
| GET | `/api/account` | Address and balance |
| POST | `/api/faucet` | Get this wallet's test ETH (once per wallet) |
| GET | `/api/activity` | Log of what the app did |
| GET | `/api/tasks` | Task types on the network, with each one's input fields |
| GET | `/api/providers` | Every provider: stake, prices, record |
| GET | `/api/providers/{address}` | One provider |
| GET | `/api/provider` | You as a provider |
| POST | `/api/provider/register` | Become a provider |
| POST | `/api/provider/stake` | Add stake |
| POST | `/api/provider/withdraw` | Take stake back |
| POST | `/api/provider/prices` | Set prices per item (0 = stop offering) |
| POST | `/api/provider/serve` | Start or stop doing provider work |
| GET | `/api/jobs` | Your jobs, in any role |
| POST | `/api/jobs` | Post a job (uploads files) |
| GET | `/api/jobs/{ref}` | A job's status, parties and timeline |
| GET | `/api/jobs/{ref}/results` | A job's results (client only) |
| GET | `/api/jobs/{ref}/results/{index}` | One result file (render jobs) |
| POST | `/api/jobs/{ref}/cancel` | Cancel a job nobody accepted yet |
| POST | `/api/jobs/{ref}/expire` | Move on a job whose deadline passed |

---

## App and wallet

### `GET /api/status`

Works while locked. Before unlocking, `network` holds only the remembered URL, or is `null`.

```json
{
  "network": {"url": "http://192.168.1.20:8600", "name": "DeGPU", "chain_id": 31337,
              "registry": "0x90882e31aed296932b68A36103701434fFfe6345", "faucet_wei": "2000000000000000000"},
  "wallet": {"name": "alice", "address": "0x8B7210649b7b704C61fF351D87ec5AbB26D1DD71"},
  "unlocked": true,
  "serving": false
}
```

### `GET /api/wallets`

`[{"name": "alice", "address": "0x8B72..."}]`

### `POST /api/wallets`

```json
{"name": "alice", "password": "a long password"}
{"name": "bob", "password": "...", "private_key": "0x4c08..."}
```

The first makes a new random key. The second imports a key: 64 hex digits, with or without `0x`. A name is 1–32 letters, digits, `-` or `_`. The wallet is saved encrypted in `~/.degpu/wallets/<name>.json`, in the standard keystore format that MetaMask can import. Answer: `{"name": "alice", "address": "0x..."}`.

### `POST /api/unlock`

`{"name": "alice", "password": "...", "network": "http://192.168.1.20:8600"}`. `network` is optional; the default is the last one used. The answer is the same as `/api/status`. Unlocking another wallet replaces the current one.

### `POST /api/lock`

Stops the background steps and drops the key. The answer is the same as `/api/status`.

### `GET /api/account`

`{"address": "0x8B72...", "balance_wei": "2000000000000000000"}`

### `POST /api/faucet`

No body. It asks the host's faucet for test ETH: 2 ETH by default, once per wallet.

```json
{"address": "0x8B72...", "amount_wei": "2000000000000000000", "tx": "0xf0e4..."}
```

A second claim gives 400, `"this address already got its test ETH"`.

### `GET /api/activity?after=SEQ`

Log lines from the manual actions and the automatic steps, oldest first. To poll, pass the last `seq` you saw. The app keeps the latest 1000 lines.

```json
[
  {"seq": 5, "time": 1792919983, "message": "[client] job replicated:1: posted 5 image-classify-v1 items to 0x99Fa7B2A, deposit 0.001 ETH (secretly: verify)"},
  {"seq": 6, "time": 1792919984, "message": "[client] job replicated:1: main provider committed; revealed decision: verify"}
]
```

---

## Market

### `GET /api/tasks`

The task types deployed on the network that this machine knows.

```json
[
  {
    "name": "image-classify-v1",
    "mode": "replicated",
    "description": "top-1 ImageNet label per image, with your ONNX model",
    "task_id": 2,
    "default_price_wei": "100000000000000",
    "runs_here": true,
    "result": "value",
    "code_matches": true,
    "fields": [
      {"name": "model",  "flag": "--model",  "type": "file",  "default": "/…/assets/mobilenetv2.onnx", "help": "ONNX classifier"},
      {"name": "images", "flag": "--images", "type": "files", "default": "/…/assets/images",           "help": "directory of .jpg files"},
      {"name": "limit",  "flag": "--limit",  "type": "int",   "default": 200,                          "help": "use the first N images"}
    ]
  }
]
```

| Field | Meaning |
|---|---|
| `mode` | `replicated`: checked by re-running it on random providers. `checked`: a contract checks every answer. |
| `runs_here` | This machine has the task's software (Blender for renders), so it can offer the task. |
| `result` | `value`: one value per item. `file`: one file per item (rendered frames). |
| `code_matches` | Replicated only. This machine's task code matches the hash pinned on-chain. If not, providers refuse its jobs, so update the code. |
| `fields` | The inputs of a job, one per CLI flag. `type` is `int`, `float`, `str` or `bool`, or for uploads `file` (one file) or `files` (several files). `default` is used when a field is left out. For uploads it's a path on the app's machine, used only if it exists there. |

The built-in tasks:

| Task | Fields |
|---|---|
| `image-classify-v1` | `model` (file, `.onnx`), `images` (files, `.jpg` only), `limit` (int: use the first N images, sorted by file name) |
| `key-search-v1` | `keys` (int), `bits` (int: each key hides among 2^bits values), `impossible` (int: extra puzzles with no answer, to show the refund) |
| `blender-render-v1` | `scene` (file, `.blend`), `frames` (str, e.g. `1-12` or `1,5,9`) |

### `GET /api/providers` and `GET /api/providers/{address}`

```json
{
  "address": "0xB020c6a25A72097E1F69571535e2A5C3191D47F6",
  "registered": true,
  "active": true,
  "stake_wei": "1000000000000000000",
  "open_jobs": 0,
  "prices_wei": {"blender-render-v1": "0", "image-classify-v1": "100000000000000", "key-search-v1": "100000000000000"},
  "record": {
    "replicated": {"verified_completed": 1, "unverified_completed": 0, "missed": 0, "outvoted": 0,
                   "checks_completed": 2, "checks_missed": 0, "checks_outvoted": 0},
    "checked": {"completed": 1, "missed": 0, "items_solved": 2, "items_not_found": 1}
  }
}
```

- **`active`:** registered with at least the minimum stake (0.8 ETH). Only active providers get jobs.
- **`prices_wei`:** wei per item. `"0"` means the task isn't offered.
- **`record`:** counters kept on-chain by each market. `checks_*` count work as a verifier, `outvoted` counts results that were found wrong, and `missed` counts deadlines missed.

---

## Provider (selling compute)

Every endpoint here answers with **you as a provider**: the provider object above plus these fields:

```json
{"serving": true, "behavior": "honest", "min_stake_wei": "800000000000000000"}
```

### `GET /api/provider`

### `POST /api/provider/register`

`{"stake_wei": "1000000000000000000", "prices_wei": {"key-search-v1": "200000000000000"}}`

- **Stake:** at least `min_stake_wei`.
- **Prices:** optional. A task left out gets its default price, and tasks that can't run here get 0.
- **Encryption key:** published on-chain at the same time. It's derived from the wallet key, so it's the same on every machine.
- **One time only:** if the wallet is already a provider, you get 400.

### `POST /api/provider/stake` and `POST /api/provider/withdraw`

`{"amount_wei": "500000000000000000"}`

Withdrawing is refused while you're in an open job (`"locked"`). Below the minimum stake, you get no new jobs.

### `POST /api/provider/prices`

`{"prices_wei": {"image-classify-v1": "100000000000000", "key-search-v1": "0"}}`

`"0"` stops offering a task. A task that can't run on this machine can't be offered.

### `POST /api/provider/serve`

`{"on": true}` or `{"on": false}`. Add `"behavior": "cheat" | "liar" | "offline" | "honest"` only for presentations:

| Behaviour | What the provider does |
|---|---|
| `cheat` | As main provider, fakes 20% of results (replicated) or makes up answers (checked). |
| `liar` | As a verifier, reports random results. |
| `offline` | Accepts jobs as main provider, then does nothing more. |

Serving is remembered when the app restarts.

**Stop offering before you leave.** Verifiers are drawn from every active provider that offers the task, including ones whose app is closed. A drawn provider that doesn't answer is slashed. So when you stop serving, also set your prices to 0. The answer warns you if you didn't:

```json
{"serving": false, "warning": "you still offer tasks, so you can be picked as a verifier while not serving; set your prices to 0 to stop"}
```

---

## Jobs (buying compute)

### `POST /api/jobs`

`multipart/form-data`:

| Form field | Value |
|---|---|
| `task` | Task name, e.g. `key-search-v1` |
| `main` | The main provider's address. Not your own. |
| `verify` | `true` or `false` (replicated only, default `false`): the **hidden** decision. The deposit is the same either way. |
| each task field | By its `name` from `/api/tasks`, e.g. `keys=10` |
| each upload | A file part named after the field, e.g. `model`. Repeat the part for `files` fields, e.g. one `images` part per photo. |

**Deposit:** 2 × items × price for replicated jobs (half comes back if not verified), and items × price for checked jobs (items with no answer are refunded). The app refuses the job if your balance is too low.

```bash
curl -s -H 'X-DeGPU: 1' http://127.0.0.1:8700/api/jobs \
  -F task=key-search-v1 -F main=0x99Fa7B2Ae6b0cEEBC7E77A6B120D6CcEEB586ec0 -F keys=10 -F impossible=1

curl -s -H 'X-DeGPU: 1' http://127.0.0.1:8700/api/jobs \
  -F task=image-classify-v1 -F main=0x99Fa... -F verify=true \
  -F model=@assets/mobilenetv2.onnx -F images=@cat.jpg -F images=@dog.jpg
```

The answer is the new job, as in `GET /api/jobs/{ref}`.

### `GET /api/jobs`

Your jobs in every role, newest first. Each is a job summary:

```json
{
  "ref": "replicated:1", "mode": "replicated", "id": 1, "task": "image-classify-v1",
  "role": "client", "status": "closed", "outcome": "verified", "closed": true,
  "client": "0x1DBa...", "main": "0x99Fa...", "num_items": 5,
  "deposit_wei": "1000000000000000", "deadline": 1792920285
}
```

| Field | Values |
|---|---|
| `role` | `client`, `main`, `verifier`, `tiebreaker`, or `null` (not your job) |
| `status` (replicated) | `open` (waiting for the main provider to accept), `committing` (it computes), `deciding` (your app reveals the hidden decision), `checking` (verifiers re-run their halves), `check_reveal`, `publishing` (the main provider publishes results), `disputing` (render jobs: your app compares frames), `tie_break`, `closed` |
| `status` (checked) | `open`, `working`, `closed` |
| `outcome` (replicated) | `none` (still open), `cancelled`, `delivered` (not verified), `verified`, `main_outvoted` (main caught cheating, slashed), `verifier_outvoted`, `both_outvoted`, `no_majority`, `main_missed`, `tiebreaker_missed`, `tie_client_no_share`, `dispute_rejected` |
| `outcome` (checked) | `none`, `cancelled`, `delivered`, `main_missed` |
| `deadline` | When the current phase ends. After it, anyone can call `expire`. |

### `GET /api/jobs/{ref}`

The summary plus details and the on-chain timeline.

**Replicated jobs add:**

```json
{
  "verifiers": [{"address": "0x0e1d...", "state": "revealed", "items": [0, 2]},
                {"address": "0xf113...", "state": "revealed", "items": [2, 5]}],
  "tiebreaker": null,
  "decided": true,
  "verified": true,
  "dropped": "none",
  "mismatched": [],
  "dispute_bond_wei": "0"
}
```

| Field | Meaning |
|---|---|
| `items` | The verifier re-runs items `start` up to `end`, not including `end`. |
| `state` | `assigned`, `shared`, `committed`, `revealed`, `no_share`, `bad_input`, `missed`, `outvoted` |
| `decided`, `verified` | Whether the hidden decision is revealed yet, and whether it was "verify". |
| `dropped` | Why a "verify" job ran unverified: `none`, `client_no_reveal`, `no_eligible_verifier`. It needs 3 providers offering the task besides you, plus a 4th for a tie-break. |
| `mismatched` | Items sent to the tie-breaker. |

**Checked jobs add** `"solved"`: the number of items answered.

**Both add `timeline`:** the job's events, in order. Arguments are for display: long byte strings show only their size, and enums are their numbers (`outcome: 3` is the 4th outcome in the list above, `verified`). Shortened here:

```json
"timeline": [
  {"event": "JobCreated",       "block": 26, "time": 1792919983, "args": {"client": "0x1DBa...", "numItems": 5, "sealedForMain": "<126 bytes>", "...": "..."}},
  {"event": "JobAccepted",      "block": 27, "time": 1792919983, "args": {}},
  {"event": "ResultsCommitted", "block": 28, "time": 1792919984, "args": {}},
  {"event": "DecisionRevealed", "block": 29, "time": 1792919984, "args": {"verify": true}},
  {"event": "VerifiersDrawn",   "block": 29, "time": 1792919984, "args": {"verifiers": ["0x0e1d...", "0xf113..."]}},
  "...",
  {"event": "Payout",           "block": 37, "time": 1792919985, "args": {"to": "0x99Fa...", "amount": 500000000000000}},
  {"event": "JobClosed",        "block": 37, "time": 1792919985, "args": {"outcome": 3}}
]
```

### `GET /api/jobs/{ref}/results`

Only the job's client can read the results, because they are encrypted for it. Before any results exist you get 400, `"no results yet"`.

**Values** (image labels as ImageNet class numbers, found keys):

```json
{"ref": "checked:1", "kind": "value", "items": [
  {"index": 0, "value": "51710091667562486550356512692475758814", "mismatched": false},
  {"index": 1, "value": "213279395359094017306272755489186858112", "mismatched": false},
  {"index": 2, "value": null, "mismatched": false}
]}
```

- **`null`** means not found (checked), or a result that matched no known value.
- **`mismatched: true`** (replicated only) means the main provider and a verifier disagreed on this item, so the tie-breaker re-ran it. The value shown is still the **main provider's**. If the job's outcome is `main_outvoted` or `both_outvoted`, treat these values as wrong: the cheater was slashed and you got money back, but not a corrected value.

**Files** (rendered frames):

```json
{"ref": "replicated:4", "kind": "file", "suffix": ".png", "items": [
  {"index": 0, "file": "/api/jobs/replicated:4/results/0", "size": 48213, "mismatched": false},
  {"index": 1, "file": null, "size": null, "mismatched": true}
]}
```

### `GET /api/jobs/{ref}/results/{index}`

The file itself, e.g. `image/png`. Use it directly as an `<img src>`.

### `POST /api/jobs/{ref}/cancel`

No body. A job still `open` can be cancelled by its client, or by anyone after its deadline. The deposit goes back to the client.

### `POST /api/jobs/{ref}/expire`

No body. After a phase's deadline, anyone may move the job on. For example, a main provider that never computed is slashed, and the client is refunded.

The answer to both is the job, as in `GET /api/jobs/{ref}`.

---

## The host's endpoints (for reference)

The app talks to these on the host. The GUI never needs them.

| Method | Path | What it does |
|---|---|---|
| GET | `/network.json` | `chain_id`, `registry`, `faucet_wei`, and the paths below (relative to the join URL) |
| POST | `/rpc` | JSON-RPC gateway to the chain: reads and signed transactions only. It blocks `evm_*`, `anvil_*` and `eth_sendTransaction`, and returns an empty list for `eth_accounts`. |
| PUT, GET | `/blobs/{sha256}` | The encrypted file store. A PUT must match its hash. At most 256 MiB per file. |
| POST | `/faucet` | `{"address": "0x..."}` → test ETH, once per address (409 the second time) |
| GET | `/artifacts/{contract}` | ABI and bytecode of `ProviderRegistry`, `ReplicatedMarket` and `CheckedMarket` |
