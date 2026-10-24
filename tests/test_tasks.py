"""Conformance tests that every installed task must pass (docs/ADDING_A_JOB_TYPE.md).

They run once per task found by ``degpu.tasks.all_tasks()``, so a new task folder is tested
automatically. Replicated tasks are checked for determinism, batch independence, word format,
decoding and the runner hash; checked tasks for solve/check consistency and, on a local anvil,
for agreement between the Python ``check`` and the Solidity checker contract.
"""

import argparse
import random
import shutil

import pytest

from degpu import crypto
from degpu.tasks import CheckedTask, ReplicatedTask, all_tasks, get

TASKS = list(all_tasks().values())
REPLICATED = [t for t in TASKS if isinstance(t, ReplicatedTask)]
CHECKED = [t for t in TASKS if isinstance(t, CheckedTask)]


def ids(tasks):
    return [t.name for t in tasks]


def example(task):
    inputs = task.example_inputs()
    if inputs is None:
        pytest.skip(f"{task.name}: example inputs unavailable (assets missing?)")
    return inputs


# ---------------------------------------------------------------------------
# Every task
# ---------------------------------------------------------------------------

def test_registry_finds_the_built_in_tasks():
    assert {"image-classify-v1", "nonce-search-v1"} <= set(all_tasks())
    assert get("nonce-search-v1").mode == "checked"
    with pytest.raises(KeyError, match="no task"):
        get("no-such-task")


@pytest.mark.parametrize("task", TASKS, ids=ids(TASKS))
def test_metadata(task):
    assert task.name and task.name == task.name.strip() and " " not in task.name
    assert task.mode in ("replicated", "checked")
    assert isinstance(task.default_price, int) and task.default_price > 0
    assert isinstance(task.seconds_per_item, int) and task.seconds_per_item >= 0
    assert task.folder.is_dir() and (task.folder / "task.py").exists()
    assert task.description


@pytest.mark.parametrize("task", TASKS, ids=ids(TASKS))
def test_cli_args_parse(task):
    """The task's flags coexist with the ones ``client post`` adds itself."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--main")
    parser.add_argument("--wait", action="store_true")
    parser.add_argument("--verify", action="store_true")
    task.add_cli_args(parser)
    parser.parse_args([])


# ---------------------------------------------------------------------------
# Replicated tasks
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("task", REPLICATED, ids=ids(REPLICATED))
def test_replicated_words_are_deterministic_and_batch_independent(task):
    inputs = example(task)
    words = task.run(task.load(inputs.shared), inputs.items)
    assert len(words) == len(inputs.items)
    assert all(isinstance(w, bytes) and len(w) == 32 for w in words)
    # a second, separately loaded state gives the same words
    assert task.run(task.load(inputs.shared), inputs.items) == words
    # an item's word doesn't depend on the other items in the batch
    state = task.load(inputs.shared)
    assert [task.run(state, [item])[0] for item in inputs.items] == words
    assert task.run(state, list(reversed(inputs.items))) == list(reversed(words))


@pytest.mark.parametrize("task", REPLICATED, ids=ids(REPLICATED))
def test_replicated_words_decode(task):
    candidates = list(task.candidates())
    assert candidates and len(candidates) <= 10_000, "the client tries every candidate per item"
    assert len(set(candidates)) == len(candidates)
    assert all(len(c) == 32 for c in candidates)
    inputs = example(task)
    words = task.run(task.load(inputs.shared), inputs.items)
    assert set(words) <= set(candidates), "run() returned a word outside candidates()"
    salt = b"\x5a" * 32
    leaves = [crypto.leaf(salt, i, w) for i, w in enumerate(words)]
    assert crypto.decode_leaves(salt, leaves, candidates) == words
    for w in words:
        task.present(w)
    task.present(None)


@pytest.mark.parametrize("task", REPLICATED, ids=ids(REPLICATED))
def test_replicated_demo_outputs(task):
    rng = random.Random(7)
    candidates = set(task.candidates())
    w = next(iter(candidates))
    wrong = task.wrong_output(w, rng)
    assert wrong != w and wrong in candidates
    assert task.random_output(rng) in candidates


@pytest.mark.parametrize("task", REPLICATED, ids=ids(REPLICATED))
def test_runner_hash_pins_the_whole_folder(task, tmp_path):
    h = task.runner_hash()
    assert len(h) == 32 and task.runner_hash() == h
    # any change to any .py file of the folder changes the hash
    copy_dir = tmp_path / task.folder.name
    shutil.copytree(task.folder, copy_dir, ignore=shutil.ignore_patterns("__pycache__"))
    clone = type(task)()
    clone.folder = copy_dir
    assert clone.runner_hash() == h
    for py in sorted(copy_dir.rglob("*.py")):
        original = py.read_bytes()
        py.write_bytes(original + b"\n")
        assert clone.runner_hash() != h, f"{py.name} is not covered by the runner hash"
        py.write_bytes(original)
    assert clone.runner_hash() == h


# ---------------------------------------------------------------------------
# Checked tasks
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("task", CHECKED, ids=ids(CHECKED))
def test_checked_solve_and_check_agree(task):
    items = example(task)
    assert items and all(isinstance(item, bytes) for item in items)
    answers = [task.solve(item) for item in items]
    assert any(a is not None for a in answers), "the example should include solvable items"
    rng = random.Random(3)
    for item, answer in zip(items, answers):
        if answer is not None:
            assert len(answer) == 32
            assert task.check(item, answer), "solve() returned an answer check() rejects"
        task.present(item, answer)
        wrong = task.wrong_answer(item, rng)
        assert len(wrong) == 32 and not task.check(item, wrong)


@pytest.fixture(scope="module")
def anvil_chain():
    if shutil.which("anvil") is None:
        pytest.skip("anvil (Foundry) not installed")
    from degpu.chain import Anvil, Chain

    with Anvil() as anvil:
        yield Chain(anvil.rpc_url)


@pytest.mark.parametrize("task", CHECKED, ids=ids(CHECKED))
def test_checked_python_check_matches_the_contract(task, anvil_chain):
    """The Python port of the checker agrees with the Solidity checker on solved, wrong and
    random answers: the contract is the judge, so the two must never disagree."""
    from degpu.chain import load_artifact

    chain = anvil_chain
    abi, bytecode = load_artifact(task.checker_contract)
    owner = chain.accounts[0]
    address = chain._deploy_contract(abi, bytecode, [], owner)
    checker = chain.w3.eth.contract(address=address, abi=abi)
    rng = random.Random(11)
    for item in example(task):
        answers = [task.wrong_answer(item, rng), rng.randbytes(32)]
        solved = task.solve(item)
        if solved is not None:
            answers.append(solved)
        for answer in answers:
            assert checker.functions.check(item, answer).call() == task.check(item, answer)
