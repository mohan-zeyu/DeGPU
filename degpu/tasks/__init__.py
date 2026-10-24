"""The task registry: every job type installed under ``degpu/tasks/``.

Each sub-package with a ``task.py`` that defines ``TASK`` is a task (see ``base.py``). Drop a new
folder in and ``all_tasks()`` picks it up: deployment registers it on-chain, provider agents
offer it and ``client post --task <name>`` can post it.
"""

from __future__ import annotations

import importlib
import pkgutil
from pathlib import Path

from degpu.tasks.base import CheckedTask, ReplicatedTask, SimilarTask, Task

__all__ = ["Task", "ReplicatedTask", "SimilarTask", "CheckedTask", "all_tasks", "get"]

_TASKS: dict[str, Task] | None = None


def all_tasks() -> dict[str, Task]:
    """name -> Task for every installed task, in folder order."""
    global _TASKS
    if _TASKS is None:
        found: dict[str, Task] = {}
        here = Path(__file__).resolve().parent
        for info in sorted(pkgutil.iter_modules([str(here)]), key=lambda m: m.name):
            if not info.ispkg or not (here / info.name / "task.py").exists():
                continue
            task = importlib.import_module(f"{__name__}.{info.name}.task").TASK
            if not isinstance(task, (ReplicatedTask, CheckedTask)):
                raise TypeError(f"{info.name}/task.py: TASK must be a ReplicatedTask or CheckedTask")
            if not task.name:
                raise ValueError(f"{info.name}/task.py: TASK has no name")
            if task.name in found:
                raise ValueError(f"two tasks are named {task.name!r}")
            task.folder = here / info.name
            found[task.name] = task
        _TASKS = found
    return _TASKS


def get(name: str) -> Task:
    """The installed task called ``name`` (KeyError if there is none)."""
    try:
        return all_tasks()[name]
    except KeyError:
        raise KeyError(f"no task {name!r}; installed: {', '.join(all_tasks())}") from None
