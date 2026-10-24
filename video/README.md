# DeGPU walkthrough video

A ~7-minute narrated 1080p60 walkthrough of DeGPU for the team: the problem, the
hidden verify decision, the job flow, privacy, the five demo scenarios, tests,
reputation, incentives and known limitations.

The video is an HTML page animated as a pure function of time, rendered frame by
frame with headless Chrome. Every block number, hash, label and balance in the
demo scenes comes from a real `scripts/demo.py` run saved in `capture/`. The
voice is Kokoro (af_heart), generated locally.

## Files

| File | What it is |
|---|---|
| `index.html`, `style.css`, `engine.js`, `scenes.js` | The video itself. `scenes.js` is the storyboard. |
| `narration.js` | The voiceover script: one line per beat, with subtitle text and spoken text. |
| `capture.py` | Re-runs the demo and saves its output and per-job data to `capture/`. |
| `build_data.py` | Turns `capture/` into `data.js`. |
| `narrate.py` | Synthesizes `voice/*.wav` and `narration_durations.js` with Kokoro. |
| `music.py` | Synthesizes the music bed and mixes in the voice: `soundtrack.wav`. |
| `render.mjs` | Renders `DeGPU-walkthrough.mp4`, stills, or the timeline files. |

When a narration line is longer than the animation it describes, the engine
pauses that scene at a moment where nothing is moving (or, if the scene never
rests, slows that stretch down evenly), so voice and picture stay in step.

## Re-render

Needs Google Chrome, ffmpeg, Node 22+, and Kokoro (setup at the top of `narrate.py`).

```bash
uv run python video/capture.py                          # optional: fresh demo run (~30 s)
python3 video/build_data.py                             # capture/ -> data.js
node video/render.mjs --narration                       # narration_lines.json
video/.tts/venv/bin/python video/narrate.py             # voice/*.wav + narration_durations.js
node video/render.mjs --timeline                        # scene times, pauses, cues, voice starts
.venv/bin/python video/music.py                         # soundtrack.wav
taskpolicy -b nice -n 19 node video/render.mjs --workers 1 --threads 1   # gentle, ~3 h
node video/render.mjs --workers 6                       # fast, ~15 min, uses the whole machine
```

Preview in a browser by opening `video/index.html` (space: play/pause, arrows:
±5 s, `[` `]`: previous/next scene, `?t=120` to start at a time). Check single
frames with `node video/render.mjs --still 120,150 --out <dir>`.

If a fresh capture draws different verifiers, the scenes and narration follow
the data, but the script assumes the same five outcomes as `scripts/demo.py`.
