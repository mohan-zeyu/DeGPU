"""Shared fixtures."""

from pathlib import Path

import pytest

FAKE_RENDER_DIR = Path(__file__).resolve().parent / "fake_render"


def load_fake_render():
    """The test-only similar task (tests/fake_render/), with its folder set like the registry does."""
    from fake_render.task import TASK

    TASK.folder = FAKE_RENDER_DIR
    return TASK


@pytest.fixture(scope="module")
def fake_render():
    """Install the fake render task in the task registry for one test module, so deployment, the
    agents and the client pick it up like any installed task."""
    import degpu.tasks as tasks

    task = load_fake_render()
    tasks.all_tasks()[task.name] = task
    yield task
    tasks.all_tasks().pop(task.name, None)
