"""The ``degpu`` command.

Two kinds of commands:

* commands that run something: ``degpu host`` (the network host, on one laptop) and ``degpu app``
  (each user's local app: the unlocked wallet, the automatic steps, and the HTTP API);
* everything else is a manual action. ``degpu wallet ...`` works on this machine's wallet files;
  the rest asks the running app over its API (docs/API.md), so the CLI and the GUI do exactly
  the same thing. ``--app`` (or ``DEGPU_APP``) points at it; default http://127.0.0.1:8700.

Amounts are typed in ETH (``--stake 1``, ``price key-search-v1 0.0001``).

    uv run degpu host                                    # laptop 1: prints the join URL
    uv run degpu wallet new alice                        # every laptop
    uv run degpu app --network http://HOST:8600 --wallet alice
    uv run degpu faucet
    uv run degpu provider register --stake 1 && uv run degpu provider serve on
    uv run degpu market providers
    uv run degpu client post key-search-v1 --main 0x70997970 --keys 5 --wait
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from decimal import Decimal, InvalidOperation
from getpass import getpass
from pathlib import Path

import requests

from degpu.chain import ETHER
from degpu.tasks import all_tasks, get

DEFAULT_APP = "http://127.0.0.1:8700"


# ---------------------------------------------------------------------------
# Talking to the app
# ---------------------------------------------------------------------------

class Api:
    def __init__(self, url: str):
        self.url = url.rstrip("/")
        self.http = requests.Session()
        self.http.headers["X-DeGPU"] = "1"

    def get(self, path: str, **params):
        return self._call("GET", path, params=params)

    def post(self, path: str, body: dict | None = None, **kw):
        return self._call("POST", path, json=body, **kw)

    def raw(self, path: str) -> bytes:
        return self._call("GET", path, raw=True)

    def _call(self, method: str, path: str, raw: bool = False, **kw):
        try:
            r = self.http.request(method, self.url + path, timeout=600, **kw)
        except requests.ConnectionError:
            sys.exit(f"error: the DeGPU app is not running at {self.url}\n"
                     f"start it with: uv run degpu app --network http://HOST:8600 --wallet NAME")
        if r.status_code >= 400:
            try:
                detail = r.json().get("detail", r.text)
            except ValueError:
                detail = r.text
            sys.exit(f"error: {detail}")
        return r.content if raw else r.json()


def eth(wei) -> str:
    """Wei (int or decimal string) as "1.5 ETH"."""
    d = (Decimal(int(wei)) / ETHER).normalize()
    return f"{d:f} ETH"


def wei(text: str) -> int:
    """An ETH amount typed by the user, in wei."""
    try:
        d = Decimal(text)
    except InvalidOperation:
        raise argparse.ArgumentTypeError(f"{text!r} is not an amount of ETH") from None
    if d < 0 or d * ETHER != int(d * ETHER):
        raise argparse.ArgumentTypeError(f"{text!r}: amounts are >= 0 with at most 18 decimals")
    return int(d * ETHER)


def short(addr: str | None) -> str:
    return addr[:10] if addr else "-"


def show(args, data, human) -> None:
    """Print ``data`` as JSON with --json, else with ``human(data)``."""
    if args.json:
        print(json.dumps(data, indent=2))
    else:
        human(data)


# ---------------------------------------------------------------------------
# Commands that run something
# ---------------------------------------------------------------------------

def cmd_host(args) -> None:
    from degpu import host

    host.run(args.dir, port=args.port, bind=args.bind, faucet_wei=args.faucet_eth, fresh=args.fresh)


def cmd_app(args) -> None:
    from degpu import api, wallet
    from degpu.node import NodeError

    state = api.App(args.network)
    config_wallet = None
    if (state.home / "app.json").exists():
        config_wallet = json.loads((state.home / "app.json").read_text()).get("wallet")
    name = args.wallet or config_wallet
    if name and not args.locked:
        try:
            state.unlock(name, getpass(f"password for wallet {name}: "))
        except (wallet.WalletError, NodeError) as e:
            sys.exit(f"error: {e}")
        print(f"wallet {name} ({state.node.address}) unlocked on {state.network_url}")
    else:
        print("no wallet unlocked yet: run `uv run degpu unlock NAME`")
    api.run(state, args.port)


# ---------------------------------------------------------------------------
# Wallet files (local, no app needed)
# ---------------------------------------------------------------------------

def _new_password() -> str:
    password = getpass("choose a password: ")
    if password != getpass("repeat the password: "):
        sys.exit("error: the passwords differ")
    return password


def cmd_wallet(args) -> None:
    from degpu import wallet

    try:
        if args.action == "new":
            address = wallet.create(args.name, _new_password())
            print(f"wallet {args.name}: {address}")
        elif args.action == "import":
            key = getpass("private key (hidden): ")
            address = wallet.import_key(args.name, key, _new_password())
            print(f"wallet {args.name}: {address}")
        else:
            for w in wallet.list_wallets():
                print(f"{w['name']:<16} {w['address']}")
    except wallet.WalletError as e:
        sys.exit(f"error: {e}")


# ---------------------------------------------------------------------------
# Manual actions through the app
# ---------------------------------------------------------------------------

def cmd_unlock(args, api: Api) -> None:
    body = {"name": args.name, "password": getpass(f"password for wallet {args.name}: ")}
    if args.network:
        body["network"] = args.network
    show(args, api.post("/api/unlock", body), _print_status)


def cmd_status(args, api: Api) -> None:
    data = api.get("/api/status")
    if data["unlocked"]:
        data["balance_wei"] = api.get("/api/account")["balance_wei"]
    show(args, data, _print_status)


def _print_status(s) -> None:
    print(f"network  {s['network']['url'] if s['network'] else '-'}")
    if s["wallet"]:
        print(f"wallet   {s['wallet']['name']} {s['wallet']['address']}")
        if "balance_wei" in s:
            print(f"balance  {eth(s['balance_wei'])}")
        print(f"serving  {'yes' if s['serving'] else 'no'}")
    else:
        print("wallet   locked")


def cmd_faucet(args, api: Api) -> None:
    show(args, api.post("/api/faucet"), lambda r: print(f"received {eth(r['amount_wei'])} (tx {r['tx']})"))


def cmd_market(args, api: Api) -> None:
    if args.what == "tasks":
        def human(tasks):
            for t in tasks:
                where = "runs here" if t["runs_here"] else "can't run here"
                print(f"{t['name']:<20} {t['mode']:<10} default {eth(t['default_price_wei'])}/item, {where}"
                      f"  - {t['description']}")
        show(args, api.get("/api/tasks"), human)
    else:
        def human(providers):
            if not providers:
                print("no providers yet")
            for p in providers:
                offers = ", ".join(f"{n} {eth(w)}" for n, w in p["prices_wei"].items() if int(w)) or "nothing"
                state = "active" if p["active"] else "inactive"
                print(f"{p['address']}  stake {eth(p['stake_wei'])}, {state}, {p['open_jobs']} open jobs; offers {offers}")
        show(args, api.get("/api/providers"), human)


def _print_provider(p) -> None:
    if not p["registered"]:
        print(f"not a provider yet (minimum stake {eth(p['min_stake_wei'])})")
        return
    print(f"provider  {p['address']}  ({'active' if p['active'] else 'inactive: stake below minimum'})")
    print(f"stake     {eth(p['stake_wei'])}, in {p['open_jobs']} open jobs")
    print(f"serving   {'yes' if p['serving'] else 'no'}" + (f" ({p['behavior']})" if p["behavior"] != "honest" else ""))
    for name, w in p["prices_wei"].items():
        print(f"price     {name}: {eth(w) + '/item' if int(w) else 'not offered'}")
    for mode, record in p["record"].items():
        print(f"record    {mode}: " + ", ".join(f"{k} {v}" for k, v in record.items()))
    if p.get("warning"):
        print(f"warning   {p['warning']}")


def cmd_provider(args, api: Api) -> None:
    a = args.action
    if a == "show":
        data = api.get("/api/provider")
    elif a == "register":
        prices = dict(_task_price(s) for s in args.price or [])
        data = api.post("/api/provider/register", {"stake_wei": str(args.stake), "prices_wei": prices or None})
    elif a == "stake":
        data = api.post("/api/provider/stake", {"amount_wei": str(args.amount)})
    elif a == "withdraw":
        data = api.post("/api/provider/withdraw", {"amount_wei": str(args.amount)})
    elif a == "price":
        data = api.post("/api/provider/prices", {"prices_wei": {args.task: str(args.amount)}})
    else:  # serve
        data = api.post("/api/provider/serve", {"on": args.state == "on", "behavior": args.behavior})
    show(args, data, _print_provider)


def _task_price(text: str) -> tuple[str, str]:
    task, sep, amount = text.partition("=")
    if not sep:
        sys.exit(f"error: --price takes TASK=ETH, got {text!r}")
    return task, str(wei(amount))


def cmd_client(args, api: Api) -> None:
    a = args.action
    if a == "post":
        _post(args, api)
    elif a == "jobs":
        def human(jobs):
            if not jobs:
                print("no jobs yet")
            for j in jobs:
                print(f"{j['ref']:<15} {j['role'] or '-':<11} {j['task']:<18} {j['num_items']:>4} items  "
                      f"{j['status']:<12} {j['outcome'] if j['closed'] else ''}")
        show(args, api.get("/api/jobs"), human)
    elif a == "status":
        show(args, api.get(f"/api/jobs/{args.job}"), _print_job)
    elif a == "results":
        _results(args, api, args.job)
    else:  # cancel, expire
        show(args, api.post(f"/api/jobs/{args.job}/{a}"), _print_job)


def _print_job(j) -> None:
    print(f"job       {j['ref']}  {j['task']}, {j['num_items']} items, deposit {eth(j['deposit_wei'])}")
    print(f"you are   {j['role'] or 'not part of it'}")
    print(f"status    {j['status']}" + (f", outcome {j['outcome']}" if j["closed"] else
                                         f", phase deadline {time.strftime('%H:%M:%S', time.localtime(j['deadline']))}"))
    print(f"client    {j['client']}\nmain      {j['main']}")
    for v in j.get("verifiers", []):
        print(f"verifier  {v['address']}  items {v['items'][0]}-{v['items'][1] - 1}: {v['state']}")
    if j.get("tiebreaker"):
        print(f"tiebreak  {j['tiebreaker']}  items {j['mismatched']}")
    for ev in j.get("timeline", []):
        print(f"  {time.strftime('%H:%M:%S', time.localtime(ev['time']))}  {ev['event']}")


def _post(args, api: Api) -> None:
    from degpu.node import task_fields

    task = get(args.task)
    providers = api.get("/api/providers")
    matches = [p["address"] for p in providers if p["address"].lower().startswith(args.main.lower())]
    if len(matches) != 1:
        sys.exit(f"error: {args.main!r} matches {len(matches)} providers; give more of the address "
                 f"(see `uv run degpu market providers`)")
    form = {"task": task.name, "main": matches[0], "verify": "true" if getattr(args, "verify", False) else "false"}
    files = []
    for f in task_fields(task):
        value = getattr(args, f["name"])
        if f["type"] in ("file", "files"):
            path = Path(value)
            paths = sorted(p for p in path.iterdir() if p.is_file()) if path.is_dir() else [path]
            for p in paths:
                if not p.is_file():
                    sys.exit(f"error: {f['flag']}: no file {p}")
                files.append((f["name"], (p.name, p.read_bytes())))
        elif f["type"] == "bool":
            if value:
                form[f["name"]] = "true"
        elif value is not None:
            form[f["name"]] = str(value)
    job = api.post("/api/jobs", data=form, files=files or None)
    print(f"posted {job['ref']}: {job['num_items']} items to {short(job['main'])}, deposit {eth(job['deposit_wei'])}")
    if not args.wait:
        print(f"follow it with: uv run degpu client status {job['ref']}")
        return
    last = None
    while not job["closed"]:
        if job["status"] != last:
            print(f"  {time.strftime('%H:%M:%S')}  {job['status']}")
            last = job["status"]
        time.sleep(2)
        job = api.get(f"/api/jobs/{job['ref']}")
    print(f"  {time.strftime('%H:%M:%S')}  closed: {job['outcome']}")
    _results(args, api, job["ref"])


def _results(args, api: Api, ref: str) -> None:
    res = api.get(f"/api/jobs/{ref}/results")
    if args.json:
        print(json.dumps(res, indent=2))
    elif res["kind"] == "value":
        for item in res["items"]:
            flag = "   (disputed: went to the tie-breaker)" if item["mismatched"] else ""
            print(f"item {item['index']:>4}: {item['value'] if item['value'] is not None else 'not found'}{flag}")
    if res["kind"] == "file":
        out = Path(args.out or f"results/{ref.replace(':', '-')}")
        out.mkdir(parents=True, exist_ok=True)
        missing = []
        for item in res["items"]:
            if item["file"] is None:
                missing.append(item["index"])
                continue
            (out / f"item-{item['index']:04d}{res['suffix']}").write_bytes(api.raw(item["file"]))
        print(f"wrote {len(res['items']) - len(missing)} files to {out}" + (f"; missing: {missing}" if missing else ""))


def cmd_log(args, api: Api) -> None:
    after = 0
    while True:
        for e in api.get("/api/activity", after=after):
            print(f"{time.strftime('%H:%M:%S', time.localtime(e['time']))}  {e['message']}", flush=True)
            after = e["seq"]
        if not args.follow:
            return
        time.sleep(1)


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    from degpu.agent import BEHAVIORS

    ap = argparse.ArgumentParser(prog="degpu", description="DeGPU: rent out compute, or buy it.")
    ap.add_argument("--app", default=os.environ.get("DEGPU_APP", DEFAULT_APP),
                    help=f"the local app's URL (default {DEFAULT_APP})")
    ap.add_argument("--json", action="store_true", help="print the API's JSON answer")
    sub = ap.add_subparsers(dest="cmd", required=True, metavar="COMMAND")

    p = sub.add_parser("host", help="run the network host (chain, file store, faucet) on this laptop")
    p.add_argument("--port", type=int, default=8600)
    p.add_argument("--bind", default="0.0.0.0", help="address to listen on (default: every network)")
    p.add_argument("--dir", help="where the host keeps its data (default ~/.degpu/host)")
    p.add_argument("--faucet-eth", type=wei, default=2 * ETHER, help="test ETH per new wallet (default 2)")
    p.add_argument("--fresh", action="store_true", help="start a new chain, forgetting the old one")

    p = sub.add_parser("app", help="run your local app: unlocks a wallet and serves the API")
    p.add_argument("--network", help="the host's URL, e.g. http://192.168.1.20:8600 (remembered)")
    p.add_argument("--wallet", help="wallet to unlock (asks its password; remembered)")
    p.add_argument("--locked", action="store_true", help="start without unlocking a wallet")
    p.add_argument("--port", type=int, default=8700)

    p = sub.add_parser("wallet", help="make, import or list wallets on this machine")
    w = p.add_subparsers(dest="action", required=True)
    w.add_parser("new", help="make a wallet with a new key").add_argument("name")
    w.add_parser("import", help="make a wallet from your private key").add_argument("name")
    w.add_parser("list", help="list this machine's wallets")

    p = sub.add_parser("unlock", help="unlock a wallet in the running app")
    p.add_argument("name")
    p.add_argument("--network", help="join this network instead of the last one")
    sub.add_parser("status", help="network, wallet, balance")
    sub.add_parser("faucet", help="get this wallet's test ETH (once per wallet)")
    p = sub.add_parser("log", help="what the app did (automatic steps included)")
    p.add_argument("-f", "--follow", action="store_true", help="keep printing new lines")

    p = sub.add_parser("market", help="what is on offer")
    p.add_argument("what", choices=["tasks", "providers"])

    p = sub.add_parser("provider", help="sell compute")
    pa = p.add_subparsers(dest="action", required=True)
    pa.add_parser("show", help="your stake, prices, record and serving state")
    r = pa.add_parser("register", help="become a provider: stake and offer every task that runs here")
    r.add_argument("--stake", type=wei, default=ETHER, help="ETH to stake (default 1)")
    r.add_argument("--price", action="append", metavar="TASK=ETH", help="price per item (default: the task's)")
    pa.add_parser("stake", help="add stake").add_argument("amount", type=wei, metavar="ETH")
    pa.add_parser("withdraw", help="take stake back (no open jobs)").add_argument("amount", type=wei, metavar="ETH")
    r = pa.add_parser("price", help="set a task's price per item (0 = stop offering it)")
    r.add_argument("task", choices=list(all_tasks()))
    r.add_argument("amount", type=wei, metavar="ETH")
    r = pa.add_parser("serve", help="start or stop doing provider work")
    r.add_argument("state", choices=["on", "off"])
    r.add_argument("--behavior", choices=BEHAVIORS, help="for presentations: cheat, liar or offline")

    p = sub.add_parser("client", help="buy compute")
    ca = p.add_subparsers(dest="action", required=True)
    post = ca.add_parser("post", help="post a job").add_subparsers(dest="task", required=True, metavar="TASK")
    for name, task in all_tasks().items():
        t = post.add_parser(name, help=f"{task.description} ({task.mode})")
        t.add_argument("--main", required=True, help="the provider's address (the first characters are enough)")
        if task.mode == "replicated":
            t.add_argument("--verify", action="store_true", help="secretly ask for full verification")
        t.add_argument("--wait", action="store_true", help="follow the job until it closes, then show the results")
        t.add_argument("--out", help="with --wait: where to write result files")
        task.add_cli_args(t)
    ca.add_parser("jobs", help="your jobs, as client or provider")
    ca.add_parser("status", help="a job's status and timeline").add_argument("job", metavar="MODE:ID")
    r = ca.add_parser("results", help="a job's results")
    r.add_argument("job", metavar="MODE:ID")
    r.add_argument("--out", help="where to write result files (default results/<job>)")
    ca.add_parser("cancel", help="cancel a job nobody accepted yet").add_argument("job", metavar="MODE:ID")
    ca.add_parser("expire", help="move on a job whose deadline passed").add_argument("job", metavar="MODE:ID")
    return ap


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    if args.cmd == "host":
        return cmd_host(args)
    if args.cmd == "app":
        return cmd_app(args)
    if args.cmd == "wallet":
        return cmd_wallet(args)
    handler = {"unlock": cmd_unlock, "status": cmd_status, "faucet": cmd_faucet, "log": cmd_log,
               "market": cmd_market, "provider": cmd_provider, "client": cmd_client}[args.cmd]
    try:
        handler(args, Api(args.app))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
