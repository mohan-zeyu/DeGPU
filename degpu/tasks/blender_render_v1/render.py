"""Running Blender for task ``blender-render-v1`` (pinned with the task folder).

* ``find_blender`` looks for the binary: ``$DEGPU_BLENDER``, then ``blender`` on the PATH, then
  the macOS app bundle. Every provider must run the pinned major.minor version.
* ``Scene`` holds a job's ``.blend`` file and renders frames of it in one Blender process:

      blender -b --factory-startup --disable-autoexec scene.blend --python-expr <SETTINGS>
              -o <dir>/frame_##### -F PNG -f 1,2,3

  ``--disable-autoexec`` keeps scripts embedded in the client's file from running;
  ``--factory-startup`` ignores the provider's own preferences and add-ons.
* ``SETTINGS`` forces what every provider must render the same way: Cycles, a fixed seed, no
  denoiser, 8-bit RGB PNG, no metadata. The device is the provider's choice
  (``DEGPU_BLENDER_DEVICE=GPU`` for Metal / OptiX / CUDA...): the similarity check tolerates the
  small differences between devices. ``DEGPU_BLENDER_SEED`` and ``DEGPU_BLENDER_SAMPLE_SCALE``
  exist only for scripts/calibrate_render.py, to measure how far other renders drift.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

BLENDER_VERSION = (5, 2)  # the major.minor version every provider runs
MACOS_APP = "/Applications/Blender.app/Contents/MacOS/Blender"

SETTINGS = """
import os
import bpy

scene = bpy.context.scene
scene.render.engine = "CYCLES"
cycles = scene.cycles
cycles.seed = int(os.environ.get("DEGPU_BLENDER_SEED", "0"))
cycles.use_animated_seed = False
cycles.use_denoising = False
scale = float(os.environ.get("DEGPU_BLENDER_SAMPLE_SCALE", "1"))
if scale != 1:
    cycles.samples = max(1, int(cycles.samples * scale))

if os.environ.get("DEGPU_BLENDER_DEVICE", "CPU").upper() == "GPU":
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for backend in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
        try:
            prefs.compute_device_type = backend
        except TypeError:
            continue
        prefs.get_devices()
        if any(d.type != "CPU" for d in prefs.devices):
            break
    for device in prefs.devices:
        device.use = True
    cycles.device = "GPU"
else:
    cycles.device = "CPU"

render = scene.render
for attr in dir(render):  # no burned-in stamps and no metadata in the files
    if attr.startswith("use_stamp"):
        try:
            setattr(render, attr, False)
        except (AttributeError, TypeError):
            pass
settings = render.image_settings
settings.file_format = "PNG"
settings.color_mode = "RGB"
settings.color_depth = "8"
settings.compression = 15
"""


class BlenderError(RuntimeError):
    """Blender is missing, the wrong version, or a render failed."""


def find_blender() -> str | None:
    """Path of the Blender binary, or None."""
    env = os.environ.get("DEGPU_BLENDER")
    if env:
        return env if Path(env).exists() else None
    return shutil.which("blender") or (MACOS_APP if Path(MACOS_APP).exists() else None)


def blender_version(binary: str) -> tuple[int, int] | None:
    try:
        out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=120).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"Blender (\d+)\.(\d+)", out)
    return (int(m.group(1)), int(m.group(2))) if m else None


def require_blender() -> str:
    """The Blender binary; BlenderError if it's missing or not the pinned version."""
    binary = find_blender()
    if binary is None:
        raise BlenderError("Blender not found: install Blender "
                           f"{'.'.join(map(str, BLENDER_VERSION))} or set DEGPU_BLENDER")
    version = blender_version(binary)
    if version != BLENDER_VERSION:
        raise BlenderError(f"{binary} is Blender {version}, the task needs {BLENDER_VERSION}")
    return binary


class Scene:
    """A job's .blend file on disk, rendered with the pinned settings."""

    def __init__(self, blend: bytes):
        self.binary = require_blender()
        self._dir = tempfile.TemporaryDirectory(prefix="degpu-blend-")
        self.path = Path(self._dir.name) / "scene.blend"
        self.path.write_bytes(blend)

    def render(self, frames: list[int], env: dict[str, str] | None = None) -> list[bytes]:
        """PNG bytes of each frame, in order, rendered in one Blender run."""
        unique = sorted(set(frames))
        out_dir = Path(tempfile.mkdtemp(dir=self._dir.name))
        cmd = [
            self.binary, "-b", "--factory-startup", "--disable-autoexec", str(self.path),
            "--python-expr", SETTINGS,
            "-o", str(out_dir / "frame_#####"), "-F", "PNG",
            "-f", ",".join(str(f) for f in unique),
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, env={**os.environ, **(env or {})},
                                  timeout=600 + 120 * len(unique))
        except subprocess.SubprocessError as e:
            raise BlenderError(f"render failed: {e}") from None
        files = {f: out_dir / f"frame_{f:05d}.png" for f in unique}
        missing = [f for f, path in files.items() if not path.exists()]
        if proc.returncode or missing:
            tail = (proc.stdout + proc.stderr).strip().splitlines()[-5:]
            raise BlenderError(f"render failed (exit {proc.returncode}, missing frames {missing}): "
                               + " | ".join(tail))
        rendered = {f: path.read_bytes() for f, path in files.items()}
        shutil.rmtree(out_dir, ignore_errors=True)
        return [rendered[f] for f in frames]
