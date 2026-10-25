"""A user's node: one unlocked wallet on one DeGPU network.

``Node`` is what the local app (``degpu app``, ``degpu/api.py``) runs for the wallet it
unlocked, and the one place every manual action lives. The CLI and the GUI only call the app's
HTTP API, so they can never disagree.

Manual actions (one method each):

* wallet: ``balance``, ``claim_faucet``;
* market: ``tasks``, ``providers``, ``provider``;
* provider: ``register``, ``add_stake``, ``withdraw_stake``, ``set_prices``, ``serve``;
* client: ``post_job``, ``jobs``, ``job``, ``results``, ``cancel``, ``expire``.

Automatic steps run in two background threads, the same ``step()`` calls the demo makes: the
``Client`` (reveal, share ranges, review, dispute...) always, and the ``ProviderAgent`` (accept,
compute, commit, verify...) only while serving. A provider that stops serving should also set
its prices to 0, or it may still be drawn as a verifier and miss the deadline.

Each node has its own ``Chain`` that signs with the wallet, the host's ``HttpStore``, and saved
state in ``<home>/networks/<registry>/`` (the client's job secrets, the agent's jobs, and whether
it was serving).
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import threading
import time
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urljoin

import requests
from eth_account.signers.local import LocalAccount
from web3 import Web3

from degpu import crypto, wallet
from degpu.agent import BEHAVIORS, ProviderAgent
from degpu.chain import ZERO_ADDRESS, CheckedStat, Chain, Drop, JobRef, Stat, TxFailed, VState, load_artifact
from degpu.client import Client
from degpu.storage import HttpStore, Store
from degpu.tasks import Task, all_tasks, get

STATS = {"replicated": Stat, "checked": CheckedStat}


class NodeError(Exception):
    """A manual action can't be done; the message says why, in words for the user."""


# ---------------------------------------------------------------------------
# Joining a network
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Network:
    """What ``<url>/network.json`` says, with every URL made absolute."""

    url: str
    name: str
    chain_id: int
    registry: str
    rpc: str
    store: str | None
    faucet: str | None
    artifacts: str | None
    faucet_wei: int

    @classmethod
    def join(cls, url: str) -> "Network":
        url = url.strip().rstrip("/")
        if "://" not in url:
            url = "http://" + url
        try:
            r = requests.get(url + "/network.json", timeout=10)
            r.raise_for_status()
            d = r.json()
        except (requests.RequestException, ValueError) as e:
            raise NodeError(f"cannot join the network at {url}: {e}") from None

        def resolve(key: str) -> str | None:
            return urljoin(url + "/", d[key]) if d.get(key) else None

        return cls(url=url, name=d.get("name", "DeGPU"), chain_id=int(d["chain_id"]),
                   registry=Web3.to_checksum_address(d["registry"]), rpc=resolve("rpc"),
                   store=resolve("store"), faucet=resolve("faucet"), artifacts=resolve("artifacts"),
                   faucet_wei=int(d.get("faucet_wei", 0)))

    def as_dict(self) -> dict:
        return {"url": self.url, "name": self.name, "chain_id": self.chain_id, "registry": self.registry,
                "faucet_wei": str(self.faucet_wei)}


# ---------------------------------------------------------------------------
# Task forms: a task's own CLI flags, filled in from API fields
# ---------------------------------------------------------------------------

class _FieldParser(argparse.ArgumentParser):
    def error(self, message):  # argparse would exit the process
        raise NodeError(message)


def _task_parser(task: Task) -> _FieldParser:
    parser = _FieldParser(prog=task.name, add_help=False)
    task.add_cli_args(parser)
    return parser


def task_fields(task: Task) -> list[dict]:
    """The inputs a job of ``task`` takes: one entry per flag of its ``add_cli_args``.
    ``type`` is "int", "float", "str", "bool", or for uploads "file" / "files"."""
    fields = []
    for a in _task_parser(task)._actions:
        kind = task.uploads.get(a.dest)
        if kind is None:
            kind = "bool" if a.nargs == 0 else a.type.__name__ if a.type in (int, float) else "str"
        default = a.default if isinstance(a.default, (int, float, str, bool)) or a.default is None else str(a.default)
        fields.append({"name": a.dest, "flag": a.option_strings[0], "type": kind, "default": default,
                       "help": a.help})
    return fields


def parse_task_fields(task: Task, fields: Mapping[str, Any]) -> argparse.Namespace:
    """``fields`` (name -> value; uploads are local paths) as the Namespace ``task.prepare`` takes.
    Fields left out get the flag's default."""
    parser = _task_parser(task)
    by_name = {a.dest: a for a in parser._actions}
    argv: list[str] = []
    for name, value in fields.items():
        a = by_name.get(name)
        if a is None:
            raise NodeError(f"{task.name} has no field {name!r}; its fields: {', '.join(by_name)}")
        if a.nargs == 0:
            if value in (True, "true", "True", "1", "yes", "on"):
                argv.append(a.option_strings[0])
        else:
            argv += [a.option_strings[0], str(value)]
    return parser.parse_args(argv)


# ---------------------------------------------------------------------------
# The node
# ---------------------------------------------------------------------------

class Node:
    """One wallet on one network. Call ``start()`` to run the automatic steps, ``stop()`` to end."""

    def __init__(self, network: Network, account: LocalAccount, *, home: str | os.PathLike | None = None,
                 poll: float = 1.0, echo: Callable[[str], None] | None = None):
        self.network = network
        self.address = account.address
        self.poll = poll
        self._echo = echo
        self._events: deque[dict] = deque(maxlen=1000)
        self._seq = itertools.count(1)
        self._events_lock = threading.Lock()

        folder = Path(home or wallet.home()) / "networks" / network.registry.lower()
        self.chain = Chain(network.rpc, artifacts=self._artifact_loader(folder / "artifacts"))
        if self.chain.w3.eth.chain_id != network.chain_id:
            raise NodeError(f"{network.rpc} is chain {self.chain.w3.eth.chain_id}, not {network.chain_id}")
        self.chain.add_signer(account)
        self.chain.attach(network.registry)
        self.store = HttpStore(network.store) if network.store else Store()

        self.client = Client(self.chain, self.address, store=self.store, name="client",
                             state_path=folder / f"client-{self.address}.json", log=self._log)
        self.agent = ProviderAgent(self.chain, self.address, "honest", name="provider", store=self.store,
                                   keypair=crypto.keypair_from_wallet(account.key),
                                   state_path=folder / f"provider-{self.address}.json", log=self._log)
        self._settings_path = folder / f"node-{self.address}.json"
        settings = json.loads(self._settings_path.read_text()) if self._settings_path.exists() else {}
        self.agent.behavior = settings.get("behavior", "honest")
        self.serving = bool(settings.get("serving")) and self.chain.provider(self.address).registered

        # The client lock guards the client's job table, the agent lock the agent's. They are
        # separate so a long computation (a render) never holds up a reveal or a new job.
        self._client_lock = threading.RLock()
        self._agent_lock = threading.RLock()
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._task_names: dict[tuple[str, int], str] = {}
        self._results: dict[JobRef, list] = {}  # results of closed jobs, decoded once

    def start(self) -> "Node":
        for name, step, lock, enabled in (
            ("client", self.client.step, self._client_lock, lambda: True),
            ("provider", self.agent.step, self._agent_lock, lambda: self.serving),
        ):
            t = threading.Thread(target=self._loop, args=(name, step, lock, enabled), daemon=True,
                                 name=f"degpu-{name}")
            t.start()
            self._threads.append(t)
        self._log(f"[node] {self.address} on {self.network.url}" + ("; serving" if self.serving else ""))
        return self

    def stop(self) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout=30)
        self._threads = []

    def _loop(self, name: str, step, lock, enabled) -> None:
        last_error = None
        while not self._stop.wait(self.poll):
            if not enabled():
                continue
            try:
                with lock:
                    step()
                last_error = None
            except Exception as e:  # e.g. the host is unreachable for a moment: try again next round
                msg = f"{type(e).__name__}: {e}"
                if msg != last_error:
                    self._log(f"[{name}] step failed, will retry: {msg}")
                last_error = msg

    # -- activity log ----------------------------------------------------------------

    def _log(self, message: str) -> None:
        with self._events_lock:
            self._events.append({"seq": next(self._seq), "time": int(time.time()), "message": message})
        if self._echo:
            self._echo(message)

    def activity(self, after: int = 0) -> list[dict]:
        """Log lines from the automatic steps and the manual actions, oldest first."""
        with self._events_lock:
            return [e for e in self._events if e["seq"] > after]

    # -- wallet --------------------------------------------------------------------------

    def balance(self) -> int:
        return self.chain.balance(self.address)

    def claim_faucet(self) -> dict:
        """Ask the host's faucet for this wallet's test ETH (once per wallet)."""
        if not self.network.faucet:
            raise NodeError("this network has no faucet")
        try:
            r = requests.post(self.network.faucet, json={"address": self.address}, timeout=60)
        except requests.RequestException as e:
            raise NodeError(f"cannot reach the faucet: {e}") from None
        if r.status_code != 200:
            raise NodeError(_detail(r))
        self._log(f"[wallet] got {int(r.json()['amount_wei']) / 1e18:g} test ETH from the faucet")
        return r.json()

    # -- market ----------------------------------------------------------------------------

    def tasks(self) -> list[dict]:
        """Every task type on this network that this machine knows."""
        out = []
        for name, (task, task_id) in self._deployed().items():
            info = {
                "name": name,
                "mode": task.mode,
                "description": task.description,
                "task_id": task_id,
                "default_price_wei": str(task.default_price),
                "runs_here": task.available(),
                "result": "file" if getattr(task, "compare", "") == "similar" else "value",
                "fields": task_fields(task),
            }
            if task.mode == "replicated":  # providers refuse jobs if the code differs from the pinned hash
                info["code_matches"] = bytes(self.chain.task_type(task.mode, task_id)[0]) == task.runner_hash()
            out.append(info)
        return out

    def providers(self) -> list[dict]:
        reg = self.chain.registry.functions
        return [self.provider(reg.providerAt(i).call()) for i in range(reg.providerCount().call())]

    def provider(self, address: str) -> dict:
        """A provider's stake, prices and record (counters kept by each market)."""
        address = _address(address)
        p = self.chain.provider(address)
        reg = self.chain.registry.functions
        return {
            "address": address,
            "registered": p.registered,
            "active": reg.isActive(address).call(),
            "stake_wei": str(p.stake),
            "open_jobs": p.locks,
            "prices_wei": {name: str(self.chain.price_of(address, task.mode, task_id))
                           for name, (task, task_id) in self._deployed().items()},
            "record": {mode: {s.name.lower(): self.chain.stat(address, mode, s) for s in STATS[mode]}
                       for mode in self.chain.markets},
        }

    # -- provider ----------------------------------------------------------------------------

    def me_as_provider(self) -> dict:
        info = self.provider(self.address)
        info.update(serving=self.serving, behavior=self.agent.behavior,
                    min_stake_wei=str(self.chain.registry.functions.minStake().call()))
        return info

    def register(self, stake_wei: int, prices_wei: dict[str, int] | None = None) -> dict:
        """Join as a provider with ``stake_wei``, publish the encryption key and offer every task
        that runs here, at ``prices_wei[name]`` or the task's default price."""
        if self.chain.provider(self.address).registered:
            raise NodeError("this wallet is already a provider; change its stake or prices instead")
        min_stake = self.chain.registry.functions.minStake().call()
        if stake_wei < min_stake:
            raise NodeError(f"the stake must be at least {min_stake / 1e18:g} ETH")
        self._check_prices(prices_wei or {})
        with self._agent_lock:
            self.agent.register(stake_wei, prices_wei)
        return self.me_as_provider()

    def add_stake(self, amount_wei: int) -> dict:
        self.chain.send(self.chain.registry.functions.addStake(), self.address, value=amount_wei)
        self._log(f"[provider] added {amount_wei / 1e18:g} ETH of stake")
        return self.me_as_provider()

    def withdraw_stake(self, amount_wei: int) -> dict:
        """Take stake back (only while in no open job). Below the minimum, no new jobs come."""
        self.chain.send(self.chain.registry.functions.withdrawStake(amount_wei), self.address)
        self._log(f"[provider] withdrew {amount_wei / 1e18:g} ETH of stake")
        return self.me_as_provider()

    def set_prices(self, prices_wei: dict[str, int]) -> dict:
        """Offer each named task at its price per item (0 stops offering it)."""
        deployed = self._check_prices(prices_wei)
        for name, price in prices_wei.items():
            task, task_id = deployed[name]
            market = self.chain.markets[task.mode].address
            self.chain.send(self.chain.registry.functions.setPrice(market, task_id, price), self.address)
            self._log(f"[provider] {name}: " + (f"{price / 1e18:g} ETH per item" if price else "no longer offered"))
        return self.me_as_provider()

    def serve(self, on: bool, behavior: str | None = None) -> dict:
        """Start or stop doing the provider's work. ``behavior`` other than "honest" is for
        presentations (see ``degpu/agent.py``)."""
        if behavior is not None:
            if behavior not in BEHAVIORS:
                raise NodeError(f"behavior must be one of {', '.join(BEHAVIORS)}")
            self.agent.behavior = behavior
        if on:
            p = self.chain.provider(self.address)
            if not p.registered:
                raise NodeError("register as a provider first")
            if bytes(p.encPubKey) != self.agent.pub:  # e.g. registered from another tool
                self.chain.send(self.chain.registry.functions.setEncPubKey(self.agent.pub), self.address)
        self.serving = on
        self._save_settings()
        self._log(f"[provider] serving {'on' if on else 'off'}"
                  + (f" ({self.agent.behavior})" if on and self.agent.behavior != "honest" else ""))
        info = self.me_as_provider()
        if not on and any(int(p) for p in info["prices_wei"].values()):
            info["warning"] = ("you still offer tasks, so you can be picked as a verifier while not "
                               "serving; set your prices to 0 to stop")
        return info

    def _check_prices(self, prices_wei: dict[str, int]) -> dict:
        deployed = self._deployed()
        for name, price in prices_wei.items():
            if name not in deployed:
                raise NodeError(f"no task {name!r} on this network")
            if price < 0:
                raise NodeError("a price can't be negative")
            if price and not deployed[name][0].available():
                raise NodeError(f"{name} can't run on this machine (its software is missing), so it can't be offered")
        return deployed

    # -- client --------------------------------------------------------------------------------

    def post_job(self, task_name: str, main: str, fields: Mapping[str, Any], verify: bool = False) -> dict:
        """Post a job of ``task_name`` to provider ``main``. ``fields`` are the task's inputs
        (``task_fields``; uploads as local paths). ``verify`` is the hidden decision of a
        replicated job; checked jobs are always checked."""
        deployed = self._deployed()
        if task_name not in deployed:
            raise NodeError(f"no task {task_name!r} on this network")
        task, task_id = deployed[task_name]
        main = _address(main)
        if main == self.address:
            raise NodeError("you can't be the main provider of your own job")
        price = self.chain.price_of(main, task.mode, task_id)
        if not price:
            raise NodeError(f"{main} doesn't offer {task_name}")
        if not self.chain.registry.functions.isActive(main).call():
            raise NodeError(f"{main} isn't an active provider (not registered, or stake too low)")
        try:
            inputs = task.prepare(parse_task_fields(task, fields))
        except (OSError, ValueError) as e:  # e.g. a missing file, a bad frame list
            raise NodeError(f"bad inputs for {task_name}: {e}") from None
        n = len(inputs.items) if task.mode == "replicated" else len(inputs)
        if n == 0:
            raise NodeError("the job has no items")
        deposit = (2 if task.mode == "replicated" else 1) * n * price
        if deposit > self.balance():
            raise NodeError(f"this job needs a deposit of {deposit / 1e18:g} ETH; "
                            f"you have {self.balance() / 1e18:g} ETH")
        options = {"verify": bool(verify)} if task.mode == "replicated" else {}
        with self._client_lock:
            ref = self.client.post(task, main, inputs, **options)
        return self.job(str(ref))

    def jobs(self) -> list[dict]:
        """Every job this wallet takes part in (as client, main, verifier or tie-breaker), newest first."""
        # dict() copies a table in one step, without waiting for a long step() to finish.
        mine = [(JobRef(mode, jid), "client") for mode, js in self.client.jobs.items() for jid in dict(js)]
        mine += [(JobRef(mode, jid), st.get("role", "provider"))
                 for mode, js in self.agent.jobs.items() for jid, st in dict(js).items()]
        mine.sort(key=lambda x: (x[0].mode, x[0].id), reverse=True)
        return [self._summary(ref, role) for ref, role in mine]

    def job(self, ref: str) -> dict:
        """A job's status, parties and timeline of events."""
        ref = _ref(ref)
        role = "client" if ref.id in self.client.jobs[ref.mode] else \
            self.agent.jobs[ref.mode].get(ref.id, {}).get("role")
        info = self._summary(ref, role)
        job = self.chain.job(ref.mode, ref.id)
        if ref.mode == "replicated":
            verifiers = []
            for slot, (v, state) in enumerate(zip(job.verifiers, job.vstate)):
                start, end = self.chain.range_of(ref.id, slot)
                verifiers.append({"address": v, "state": VState(state).name.lower(), "items": [start, end]})
            info.update(verifiers=verifiers,
                        tiebreaker=None if job.tiebreaker == ZERO_ADDRESS else job.tiebreaker,
                        decided=job.decided, verified=job.decided and job.verify,
                        dropped=Drop(job.drop).name.lower(), mismatched=[int(i) for i in job.mismatched],
                        dispute_bond_wei=str(job.disputeBond))
        else:
            info["solved"] = job.solved
        start = self.client.jobs[ref.mode].get(ref.id, {}).get("block", 0)
        times: dict[int, int] = {}
        timeline = []
        for ev in self.chain.events(ref.mode, start, job_id=ref.id):
            block = ev["blockNumber"]
            if block not in times:
                times[block] = self.chain.w3.eth.get_block(block)["timestamp"]
            args = ev["args"]  # an AttributeDict: an event argument may be called "items"
            args = {k: _plain(args[k]) for k in args if k != "jobId"}
            timeline.append({"event": ev["event"], "block": block, "time": times[block], "args": args})
        info["timeline"] = timeline
        return info

    def results(self, ref: str) -> list:
        """The job's results, one per item: a value (exact and checked tasks; None = not found or
        undecodable) or a file's bytes (similar tasks). Only the job's client can read them."""
        ref = _ref(ref)
        if ref in self._results:
            return self._results[ref]
        st = self.client.jobs[ref.mode].get(ref.id)
        if st is None:
            raise NodeError("only the job's client can read its results (they are encrypted for it)")
        try:
            values = self.client.results(ref)
        except LookupError:
            raise NodeError("no results yet") from None
        if "outcome" in st:  # closed: they won't change
            self._results[ref] = values
        return values

    def mismatched(self, ref: str) -> set[int]:
        """Items of a replicated job that went to the tie-breaker: the main provider and a verifier
        disagreed. The results still show the main provider's value for them, which is wrong
        where the main provider was outvoted."""
        ref = _ref(ref)
        if ref.mode != "replicated":
            return set()
        return {int(i) for i in self.chain.job(ref.mode, ref.id).mismatched}

    def task_of(self, ref: str) -> Task:
        """The task of job ``ref``."""
        ref = _ref(ref)
        job = self.chain.job(ref.mode, ref.id)
        if job.status == 0:
            raise NodeError(f"no job {ref}")
        return get(self._task_name(ref.mode, job.taskType))

    def cancel(self, ref: str) -> dict:
        """Cancel a job nobody accepted yet (the client, or anyone after the deadline)."""
        ref = _ref(ref)
        self.chain.send(self.chain.markets[ref.mode].functions.cancel(ref.id), self.address)
        self._log(f"[client] job {ref}: cancelled")
        return self.job(str(ref))

    def expire(self, ref: str) -> dict:
        """Move a job on whose phase deadline has passed (anyone may call it)."""
        ref = _ref(ref)
        self.chain.send(self.chain.markets[ref.mode].functions.expire(ref.id), self.address)
        self._log(f"[node] job {ref}: called expire()")
        return self.job(str(ref))

    # -- helpers -------------------------------------------------------------------------------

    def _summary(self, ref: JobRef, role: str | None) -> dict:
        job = self.chain.job(ref.mode, ref.id)
        if job.status == 0:
            raise NodeError(f"no job {ref}")
        driver = self.client.drivers[ref.mode]
        deposit = 2 * job.price if ref.mode == "replicated" else job.numItems * job.pricePerItem
        return {
            "ref": str(ref),
            "mode": ref.mode,
            "id": ref.id,
            "task": self._task_name(ref.mode, job.taskType),
            "role": role,
            "status": type(driver.closed_status)(job.status).name.lower(),
            "outcome": driver.outcome_names(job.outcome).name.lower(),
            "closed": job.status == driver.closed_status,
            "client": job.client,
            "main": job.main,
            "num_items": job.numItems,
            "deposit_wei": str(deposit),
            "deadline": job.deadline,
        }

    def _task_name(self, mode: str, task_type: int) -> str:
        key = (mode, int(task_type))
        if key not in self._task_names:
            self._task_names[key] = self.chain.task_type(mode, task_type)[1]
        return self._task_names[key]

    def _deployed(self) -> dict[str, tuple[Task, int]]:
        """name -> (task, on-chain id) for every installed task registered on this network."""
        out = {}
        for name, task in all_tasks().items():
            if task.mode in self.chain.markets and (task_id := self.chain.task_id(name)) is not None:
                out[name] = (task, task_id)
        return out

    def _save_settings(self) -> None:
        self._settings_path.parent.mkdir(parents=True, exist_ok=True)
        self._settings_path.write_text(json.dumps({"serving": self.serving, "behavior": self.agent.behavior}))

    def _artifact_loader(self, cache: Path):
        """Contract ABIs from the host (cached per network), or from contracts/out/ without one."""
        if not self.network.artifacts:
            return load_artifact

        def load(name: str) -> tuple[list, str]:
            path = cache / f"{name}.json"
            if not path.exists():
                try:
                    r = requests.get(f"{self.network.artifacts}/{name}", timeout=30)
                    r.raise_for_status()
                except requests.RequestException as e:
                    raise NodeError(f"cannot fetch the {name} contract from the host: {e}") from None
                path.parent.mkdir(parents=True, exist_ok=True)
                # Write then rename: another app on this machine may be reading the same cache.
                tmp = path.with_suffix(f".tmp{os.getpid()}")
                tmp.write_text(r.text)
                os.replace(tmp, path)
            data = json.loads(path.read_text())
            return data["abi"], data["bytecode"]

        return load


def _address(a: str) -> str:
    if not isinstance(a, str) or not Web3.is_address(a):
        raise NodeError(f"{a!r} is not an Ethereum address")
    return Web3.to_checksum_address(a)


def _ref(s: str) -> JobRef:
    try:
        return JobRef.parse(s)
    except ValueError as e:
        raise NodeError(str(e)) from None


def _detail(r: requests.Response) -> str:
    try:
        return str(r.json().get("detail", r.text))
    except ValueError:
        return r.text or f"HTTP {r.status_code}"


def _plain(v: Any) -> Any:
    """An event argument as JSON: bytes as 0x-hex (long blobs only by size), big ints as strings."""
    if isinstance(v, (bytes, bytearray)):
        return "0x" + bytes(v).hex() if len(v) <= 32 else f"<{len(v)} bytes>"
    if isinstance(v, bool) or v is None or isinstance(v, (str, float)):
        return v
    if isinstance(v, int):
        return v if abs(v) < 2**53 else str(v)
    if isinstance(v, Mapping):
        return {k: _plain(v[k]) for k in v}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    return str(v)


__all__ = ["Network", "Node", "NodeError", "TxFailed", "task_fields", "parse_task_fields"]
