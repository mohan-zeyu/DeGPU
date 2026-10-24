# Adding a job type

DeGPU separates two ideas:

- **Job type (task):** what a provider computes, for example classifying images or finding a hidden key.
  Adding one is routine, and this guide is about that.
- **Verification mode:** how the platform knows an answer is right. Each mode is one market contract plus an off-chain driver. There are two today:

  | Mode | Market contract | How an answer is judged |
  |---|---|---|
  | `replicated` | `ReplicatedMarket` | Random verifiers re-run the items; a tie-breaker settles mismatches. The task picks the comparison: **exact** (the contract compares result hashes) or **similar** (the client compares result files with the task's metric and disputes the ones that differ) |
  | `checked` | `CheckedMarket` | A checker contract tests each answer on-chain |

A new job type for an existing mode is one folder under `degpu/tasks/`. A checked task also needs one small checker contract. Nothing else changes, because deployment, the provider agents, the client CLI and the conformance tests all find tasks through `degpu.tasks.all_tasks()`. To show a task in `scripts/demo.py`, add a scenario there; the demo's helpers already work for any task.

## 1. Pick the mode

Answer these in order:

1. **Can a cheap on-chain check tell whether an answer is right?** A few hashes or a little arithmetic per item is cheap. If yes, use **checked**. Examples:
   - key search: find the key in a range that hashes to a given value;
   - factoring a number, or a sudoku solution.

   A checked task must also pass two tests:
   - **The answer must be worth nothing outside the job.** Otherwise the provider keeps it instead of handing it in. This is why mining was dropped: a valid nonce is worth more to the provider spent on a real chain than delivered for the job's fee.
   - **The answer may become public.** Answers are submitted on-chain in the clear, so anyone can read them.
2. **Otherwise: is each item's result deterministic, and is the set of possible results small?** Deterministic means bit-identical on every honest machine. Small means about 10,000 possible values or fewer. If both hold, use **replicated, exact** (`ReplicatedTask`, [section 4](#4-a-replicated-task-step-by-step)). Examples:
   - image or text classification;
   - any "pick one of K labels" model.
3. **Otherwise: can the work be re-run, with honest results that come out only approximately alike, or too large to enumerate?** If so, and you can write a deterministic test of "close enough", use **replicated, similar** (`SimilarTask`, [section 4b](#4b-a-similar-task-step-by-step)). Examples:
   - rendering (`blender-render-v1`), where GPU and CPU renders differ slightly;
   - embeddings or other numeric outputs compared with a tolerance.
4. **None of these?** Then no mode fits yet; see [section 6](#6-when-no-mode-fits). Examples:
   - bandwidth, storage or live services;
   - sampled text generation, where honest outputs differ completely.

Rule of thumb: **checked is always simpler and cheaper.** It needs no verifiers, no secrets and no 2× deposit. Use it whenever a checker exists.

## 2. What you add

| Mode | Files |
|---|---|
| checked | `degpu/tasks/<task>/__init__.py` (empty), `degpu/tasks/<task>/task.py`, `contracts/src/checkers/<Name>Checker.sol`, `tests/test_<task>.py` (a golden vector) |
| replicated (exact or similar) | `degpu/tasks/<task>/__init__.py` (empty), `degpu/tasks/<task>/task.py`, optionally more modules in the same folder (for example `runner.py`, or `render.py` and `similarity.py`) |

Name the folder in snake_case (`key_search_v1`) and the task in kebab-case (`key-search-v1`). The name is what goes on-chain and what `client post` takes. For an incompatible change, bump the suffix and add a new folder.

Working examples to copy:
- checked: `degpu/tasks/key_search_v1/` with `contracts/src/checkers/KeySearchChecker.sol` (find a key hidden in a range). It was added by following this guide step by step, and it touched exactly the four files listed above for checked tasks;
- replicated, exact: `degpu/tasks/image_classify_v1/`;
- replicated, similar: `degpu/tasks/blender_render_v1/` (and the test-only `tests/fake_render/`, which needs no Blender).

## 3. A checked task, step by step

### 3.1 Define the item and answer formats

- **Item:** `bytes` that the checker decodes, almost always `abi.encode(...)` of a few fields.
- **Answer:** exactly 32 bytes (`bytes32`).

Write both formats in the module docstring of `task.py` and in a comment on the checker contract. Items are **public**: they are posted on-chain with the job.

### 3.2 The checker contract

`contracts/src/checkers/MyPuzzleChecker.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IChecker} from "../IChecker.sol";

/// @notice Checker for task type `my-puzzle-v1`.
///         item   = abi.encode(bytes32 seed, uint256 n)
///         answer = ...
contract MyPuzzleChecker is IChecker {
    function check(bytes calldata item, bytes32 answer) external pure returns (bool) {
        (bytes32 seed, uint256 n) = abi.decode(item, (bytes32, uint256));
        return /* true only for a real solution */;
    }
}
```

Rules for the checker:
- **It is the judge.** It must reject everything that isn't a real solution, including malformed answers.
- **Keep it `pure` (or `view`) and deterministic**, with no calls to other contracts.
- **Keep it cheap.** The market calls it once per solved item, all in one transaction, for up to 1,000 items. Stay well under about 20k gas per call.

Build it with:

```bash
cd contracts && forge build
```

The Python side finds the contract by name in `contracts/out/`.

### 3.3 `task.py`

```python
"""Task type ``my-puzzle-v1``: <one line>.

Mode: checked. Checker contract: contracts/src/checkers/MyPuzzleChecker.sol.

* item   = abi.encode(bytes32 seed, uint256 n)
* answer = ...
"""

import os

from eth_abi import decode as abi_decode
from eth_abi import encode as abi_encode

from degpu.tasks.base import ETHER, CheckedTask


class MyPuzzle(CheckedTask):
    name = "my-puzzle-v1"
    description = "one line for `client post --help`"
    checker_contract = "MyPuzzleChecker"
    default_price = ETHER // 10_000  # wei per item that agents offer by default
    seconds_per_item = 2             # extra deadline time per item

    def add_cli_args(self, parser):  # flags for `client post my-puzzle-v1`
        parser.add_argument("--count", type=int, default=10)

    def prepare(self, args) -> list[bytes]:  # CLI flags -> items
        return [abi_encode(["bytes32", "uint256"], [os.urandom(32), 1000]) for _ in range(args.count)]

    def example_inputs(self) -> list[bytes]:  # small items for the conformance tests
        return [...]  # include at least one solvable item

    def solve(self, item: bytes) -> bytes | None:  # 32-byte answer, or None if not found
        ...

    def check(self, item: bytes, answer: bytes) -> bool:  # the same rule as the contract
        ...

    def present(self, item: bytes, answer: bytes | None):  # what `client results` prints
        ...


TASK = MyPuzzle()
```

Things to get right:
- **`solve` must never return an answer `check` rejects.** A wrong answer makes the whole submission revert, so the provider wouldn't be paid for any item.
- **Returning None ("not found")** is allowed and is never slashed; the provider just isn't paid for that item.
- **Give `solve` a budget**, as `KeySearch.max_tries` does, so an unsolvable item can't hang the agent.
- **Make `check` fast in Python.** Build preimages by hand (static `abi.encode` fields are 32-byte words, concatenated), as `key_search_v1` does.
- **`wrong_answer` (used by the demo's `cheat` behaviour)** defaults to random 32-byte answers until it finds one `check` rejects. Override it if random answers usually pass.

### 3.4 Golden vector

Pin one concrete item and answer on both sides, so the formats can't drift. Copy:
- `tests/test_key_search.py`;
- `contracts/test/KeySearchChecker.t.sol`.

Foundry's `cast` computes the expected values without any code:

```bash
cast abi-encode "f(bytes32,uint256,uint256)" 0x<keyHash> 0 100     # an item
cast keccak $(cast abi-encode "f(uint256)" 42)                      # keccak256(abi.encode(uint256(42)))
```

The conformance tests also deploy your checker on a local anvil node and check that it agrees with your Python `check`.

## 4. A replicated task, step by step

```python
"""Task type ``my-model-v1``: <one line>.

Mode: replicated. Shared blob: <the model / config>. Items: <what one item is>.
Word: <what the 32-byte result means>.
"""

from degpu.tasks.base import ETHER, ReplicatedInputs, ReplicatedTask


class MyModel(ReplicatedTask):
    name = "my-model-v1"
    description = "one line"
    default_price = ETHER // 10_000
    seconds_per_item = 1

    def add_cli_args(self, parser): ...
    def prepare(self, args) -> ReplicatedInputs:      # shared blob (or None) + item blobs
        ...
    def example_inputs(self) -> ReplicatedInputs | None:  # None if assets are missing
        ...

    def load(self, shared):            # once per job: e.g. build an inference session
        ...
    def run(self, state, items):       # one 32-byte word per item, in order
        ...
    def candidates(self):              # every word run() can return (at most about 10,000)
        return [label.to_bytes(32, "big") for label in range(NUM_CLASSES)]
    def present(self, word):           # word (or None) -> what `client results` prints
        ...


TASK = MyModel()
```

What the platform does with your task:
- It encrypts the shared blob and every item, and only the job's providers get the keys.
- Each word becomes the salted leaf `keccak256(abi.encode(jobSalt, i, word))`.
- The contract compares leaves between the main provider and the verifiers.
- The client decodes each leaf by trying every word in `candidates()`.

Determinism rules. **Breaking one gets honest providers slashed for disagreeing.**
- **One item per call:** an item's word depends only on the shared blob and that item, never on the batch.
- **Run the same way everywhere:** CPU, one thread, fixed preprocessing (see `image_classify_v1/runner.py`).
- **Pin library versions** in `pyproject.toml`/`uv.lock`; the runner hash covers your code, not your libraries.
- **No randomness, clocks, network access or float formatting** in results. Use integer outputs such as class indices.

The **runner hash** covers every `.py` file in your folder. On-chain it is registered as the task type's `runnerHash`, and an agent whose copy differs refuses the job. So any edit, even whitespace, needs a fresh deployment. Restarting `python -m degpu.chain` deploys a fresh chain.

## 4b. A similar task, step by step

A similar task is a replicated task whose results are **files** that honest providers produce only approximately alike. Subclass `SimilarTask`:

```python
"""Task type ``my-render-v1``: <one line>.

Mode: replicated, compared by similarity. Shared blob: <the scene>. Items: <frame numbers>.
Output: <one PNG per item>; similar if <your rule>.
"""

from degpu.tasks.base import ETHER, ReplicatedInputs, SimilarTask
from degpu.tasks.my_render_v1 import similarity


class MyRender(SimilarTask):
    name = "my-render-v1"
    description = "one line"
    default_price = ETHER // 1000
    seconds_per_item = 30
    output_suffix = ".png"                 # for `client results --out DIR`

    def available(self) -> bool:           # False if this machine lacks the software
        ...
    def prepare(self, args) -> ReplicatedInputs: ...
    def example_inputs(self): ...          # None if unavailable here (the tests then skip)
    def load(self, shared): ...            # once per job
    def run(self, state, items):           # one output file (bytes) per item
        ...
    def similar(self, a: bytes, b: bytes) -> bool:
        return similarity.similar(a, b)
    def wrong_output(self, output, rng):   # demo `cheat`: a plausible but wrong output
        ...


TASK = MyRender()
```

What the platform does with your task:
- **Uploads:** the main provider and each verifier upload their output files, encrypted for the client, to the store. Each leaf pins `keccak256(file)`.
- **The client's review:** after `publishResults` the job is in the **Disputing** phase. The client's software loads the main provider's files and each verifier's files, and calls `similar` on every pair. It then calls `dispute` (with a bond) for the items that differ or whose file is missing; otherwise it calls `acceptResults`.
- **Judgement:** a random tie-breaker re-runs the disputed items and compares its own outputs with both sides' files, again through `similar`. It submits one verdict per item, and the contract outvotes whichever side disagrees.

Rules for `similar`. **It is the judge, and it must give the same answer everywhere:**
- **Deterministic:** integer arithmetic, no randomness and no clocks. Floats are fine only if the comparison can't flip, so prefer integers (see `blender_render_v1/similarity.py`).
- **Reflexive and symmetric,** and **false for anything it can't decode.**
- **Local, not global.** A whole-image average hides a wrong region, so the Blender rule tests every tile of an 8×8 grid.
- **Calibrated.** If it is too strict, honest GPU and CPU renders get disputed; if it is too loose, a cheap low-quality render passes. Measure honest re-runs against cheats (see `scripts/calibrate_render.py`) and pick a threshold inside the gap.
- **Pinned.** Put the rule in your task folder, so the runner hash pins it together with the rest of the code.

Your runner may vary across devices, which is the point of a similar task, but keep everything else fixed: seeds, sample counts, output format and metadata. The more alike honest outputs are, the tighter the threshold can be, and the harder it is to cheat with a cheaper computation.

## 5. Try it

```bash
cd contracts && forge build && cd ..                  # checked tasks: compile the checker
uv run pytest tests/test_tasks.py                     # conformance tests, now including your task
uv run python -m degpu.chain                          # deploys and registers every task; prints the registry
uv run python -m degpu.agent --index 2 --registry 0x5FbDB2315678afecb367f032d93F642f64180aa3
uv run python -m degpu.client --registry 0x5FbDB2315678afecb367f032d93F642f64180aa3 post my-puzzle-v1 --main A --wait
```

Run each command in its own terminal. Agents offer every installed task by default; `--tasks a,b` limits them. The registry address shown is the one every fresh anvil gets.

**What the conformance tests (`tests/test_tasks.py`) check:**

| Mode | Checks |
|---|---|
| every task | metadata is complete; the CLI flags parse alongside `--main`, `--wait` and `--verify` |
| replicated, exact | `run` is deterministic and independent of the batch; words are 32 bytes and in `candidates()`; leaves decode back; `wrong_output` and `random_output` stay in `candidates()`; every `.py` file is covered by the runner hash |
| replicated, similar | `similar` accepts an output and itself, two independent honest runs, and a batched vs a single run; it is symmetric; it rejects `wrong_output`, `random_output` and garbage; every `.py` file is covered by the runner hash |
| checked | every solved answer passes `check`; `wrong_answer` fails it; the deployed checker contract agrees with `check` |

**Pitfalls:**
- **`contracts/script/Deploy.s.sol` registers only the built-in tasks.** `Chain.deploy` (used by `python -m degpu.chain`, the demo and the tests) registers every installed task.
- **Price and timing are only defaults.** `default_price` is what agents offer unless told otherwise. `seconds_per_item` is fixed at registration and is added to each work deadline: compute, checking, tie-break, or the checked mode's work window.
- **The task registry is cached per process,** so restart long-running agents and clients after adding a task.
- **Software the task needs** (Blender, a GPU driver...): make `available()` return False without it. Agents then don't offer the task, and are never drawn to verify it.

## 6. When no mode fits

Bandwidth, storage and services sold on-chain can't be re-run or checked by a contract, so they need a **new verification mode**. Possible ingredients include:
- escrow released per period;
- client acceptance;
- random probes by other providers;
- reputation.

That design is still open. Whatever it ends up being, the code layout is fixed:

1. **A market contract** that inherits `contracts/src/MarketBase.sol`, which provides:
   - the registry link;
   - the task table with `secondsPerItem`;
   - price pinning from the registry;
   - `_slash`, `_pay` and `mode()`.

   The market adds its own job state machine and settlement. The registry owner allows it with `ProviderRegistry.addMarket`.
2. **Off-chain drivers:** a module in `degpu/modes/` with a `ProviderDriver` and a `ClientDriver` (see `degpu/modes/base.py`).
3. **Wiring:**
   - one entry each in `PROVIDER_DRIVERS` and `CLIENT_DRIVERS` (`degpu/modes/__init__.py`);
   - one entry in `MARKET_CONTRACTS` in `degpu/chain.py`, plus the market's demo params in `Chain.deploy`;
   - a task base class for the mode in `degpu/tasks/base.py`.

Tasks for the new mode then plug in exactly like the ones above.
