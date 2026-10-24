"""Synthesize the soundtrack: a calm ambient bed timed to the video, plus soft cues.

    node video/render.mjs --timeline        # writes timeline.json (scene starts, cues)
    .venv/bin/python video/music.py         # writes soundtrack.wav

Everything is generated here with numpy (no samples): a pad, an electric-piano
arpeggio, a soft bass and a light pulse during the live demo, bells, and cue
sounds for scene changes, slashes and outcomes. Loudness is normalised with
ffmpeg's loudnorm.
"""

import json
import subprocess
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SR = 44100
BPM = 72
BEAT = 60 / BPM
BAR = 4 * BEAT
CHORD = 2 * BAR  # one chord every two bars

# D major: Dmaj9, Bm11, Gmaj9, A6sus (pad voicings) with bass roots
CHORDS = [
    ([50, 57, 61, 64, 66], 38),
    ([54, 57, 62, 64, 66], 35),
    ([55, 59, 62, 66, 69], 43),
    ([57, 61, 64, 66, 71], 45),
]
ARP = [[62, 66, 69, 73, 76], [59, 62, 66, 69, 74], [59, 62, 66, 67, 71], [61, 64, 66, 69, 73]]
BELLS = [86, 88, 90, 93, 95, 98]  # D major pentatonic, high

rng = np.random.default_rng(7)


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def t_axis(n):
    return np.arange(n) / SR


def pad_chord(notes, dur):
    """Warm additive pad for one chord, stereo, with slow swell."""
    n = int(dur * SR)
    t = t_axis(n)
    out = np.zeros((n, 2))
    for k, m in enumerate(notes):
        f = hz(m)
        for side, cents in ((0, -5), (1, 5)):
            ff = f * 2 ** (cents / 1200)
            ph = 2 * np.pi * ff * t + k
            wobble = 1 + 0.06 * np.sin(2 * np.pi * (0.13 + 0.03 * k) * t + side)
            v = (np.sin(ph) + 0.3 * np.sin(2 * ph) + 0.08 * np.sin(3 * ph) + 0.02 * np.sin(4 * ph)) * wobble
            out[:, side] += v / (1 + 0.15 * k)
    env = np.minimum(1, t / 1.8) * np.minimum(1, (dur - t) / 2.2).clip(0)
    env = env ** 1.5
    return out * env[:, None] * 0.05


def ep_note(m, dur=2.6):
    n = int(dur * SR)
    t = t_axis(n)
    f = hz(m)
    ph = 2 * np.pi * f * t
    v = np.sin(ph) * np.exp(-t / 1.1) + 0.22 * np.sin(2 * ph) * np.exp(-t / 0.45) + 0.06 * np.sin(4.01 * ph) * np.exp(-t / 0.12)
    return v * np.minimum(1, t / 0.004)


def bell_note(m, dur=4.0):
    n = int(dur * SR)
    t = t_axis(n)
    f = hz(m)
    v = np.sin(2 * np.pi * f * t) * np.exp(-t / 1.6) + 0.35 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t / 0.6)
    return v * np.minimum(1, t / 0.003)


def bass_note(m, dur):
    n = int(dur * SR)
    t = t_axis(n)
    f = hz(m)
    v = np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t)
    env = np.minimum(1, t / 0.08) * np.minimum(1, (dur - t) / 0.6).clip(0)
    return np.tanh(1.1 * v) * env


def kick(dur=0.45):
    n = int(dur * SR)
    t = t_axis(n)
    f = 46 + 70 * np.exp(-t / 0.035)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t / 0.16)


def shaker(dur=0.09):
    n = int(dur * SR)
    t = t_axis(n)
    x = rng.standard_normal(n)
    x = np.diff(x, prepend=0)  # crude high-pass
    return x * np.exp(-t / 0.025) * np.minimum(1, t / 0.004)


def smooth_noise(n, width):
    x = rng.standard_normal(n + width)
    c = np.cumsum(x)
    return (c[width:] - c[:-width]) / np.sqrt(width)


def whoosh(dur=1.1):
    n = int(dur * SR)
    t = t_axis(n)
    env = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 2.5
    l, r = (smooth_noise(n + 24, 24)[:n] for _ in range(2))
    l, r = (np.convolve(v, np.ones(24) / 24, "same") * 4 for v in (l, r))
    return np.stack([l, r], 1) * env[:, None] * 0.5


def chime():
    a, b = bell_note(83, 3.0), bell_note(90, 3.0)
    b = np.concatenate([np.zeros(int(0.09 * SR)), b])[: len(a)]
    return a * 0.6 + b * 0.5


def thud():
    n = int(0.7 * SR)
    t = t_axis(n)
    f = 38 + 90 * np.exp(-t / 0.05)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.22)
    click = smooth_noise(n, 4) * np.exp(-t / 0.012) * 0.25
    return body + click


def tick():
    n = int(0.25 * SR)
    t = t_axis(n)
    return np.sin(2 * np.pi * 1320 * t) * np.exp(-t / 0.05) * 0.5


def place(buf, x, start, gain=1.0, pan=0.0):
    i = int(start * SR)
    if i < 0:
        x, i = x[-i:], 0
    if i >= len(buf) or len(x) == 0:
        return
    x = x[: len(buf) - i]
    if x.ndim == 1:
        lg, rg = np.sqrt(0.5 * (1 - pan)), np.sqrt(0.5 * (1 + pan))
        buf[i:i + len(x), 0] += x * gain * lg * 1.414
        buf[i:i + len(x), 1] += x * gain * rg * 1.414
    else:
        buf[i:i + len(x)] += x * gain


def automation(points, n):
    """points: [(time, value)] -> smooth curve sampled per audio sample."""
    ts = np.array([p[0] for p in points]) * SR
    vs = np.array([p[1] for p in points])
    return np.interp(np.arange(n), ts, vs)


def reverb(x, seconds=2.8, wet=0.32):
    n_ir = int(seconds * SR)
    t = t_axis(n_ir)
    ir = np.stack([smooth_noise(n_ir, 3), smooth_noise(n_ir, 3)], 1) * np.exp(-t / 0.7)[:, None]
    ir[: int(0.012 * SR)] = 0
    ir /= np.sqrt((ir ** 2).sum(0))
    block = 1 << 18
    nfft = 1 << int(np.ceil(np.log2(block + n_ir)))
    out = np.zeros((len(x) + n_ir, 2))
    for ch in range(2):
        H = np.fft.rfft(ir[:, ch], nfft)
        for s in range(0, len(x), block):
            seg = x[s:s + block, ch]
            y = np.fft.irfft(np.fft.rfft(seg, nfft) * H, nfft)[: len(seg) + n_ir]
            out[s:s + len(y), ch] += y
    return x * (1 - wet * 0.4) + out[: len(x)] * wet


def voice_track(tl, n):
    """The narration lines at their start times, plus a 0..1 'someone is talking' curve."""
    voice, talk = np.zeros(n), np.zeros(n)
    for line in tl.get("narration", []):
        f = HERE / "voice" / f"{line['id']}.wav"
        if not f.exists():
            continue
        with wave.open(str(f)) as w:
            x = np.frombuffer(w.readframes(w.getnframes()), "<i2") / 32768.0
        i = int(line["start"] * SR)
        x = x[: max(0, n - i)]
        voice[i:i + len(x)] += x
        talk[i:i + len(x)] = 1
    win = int(0.5 * SR)
    talk = np.convolve(talk, np.ones(win) / win, "same")  # ramps in ~0.25 s before the voice
    return voice, talk


def main():
    tl = json.loads((HERE / "timeline.json").read_text())
    dur = tl["duration"] + 0.5
    n = int(dur * SR)
    starts = {s["id"]: s["start"] for s in tl["scenes"]}
    demo0, demo1 = starts["demo"], starts["econ"]
    outro = starts["outro"]

    pad = np.zeros((n, 2))
    arp = np.zeros((n, 2))
    bass = np.zeros((n, 2))
    beat = np.zeros((n, 2))
    bells = np.zeros((n, 2))

    pads = [pad_chord(c[0], CHORD + 2.4) for c in CHORDS]
    ep_cache, bell_cache = {}, {}
    k = 0
    t = 0.0
    while t < dur:
        ci = k % 4
        place(pad, pads[ci], t - 1.0)
        place(bass, bass_note(CHORDS[ci][1], CHORD + 0.3), t, 0.11)
        tones = ARP[ci]
        pattern = [0, 2, 1, 3, 2, 4, 3, 1] if (k // 4) % 2 == 0 else [0, 3, 2, 4, 1, 3, 2, 4]
        for j in range(16):  # 8th notes over two bars
            m = tones[pattern[j % 8]] + (12 if j in (7, 15) and k % 3 == 1 else 0)
            if m not in ep_cache:
                ep_cache[m] = ep_note(m)
            vel = 0.55 + 0.45 * rng.random() * (1.0 if j % 2 == 0 else 0.7)
            place(arp, ep_cache[m], t + j * BEAT / 2 + rng.normal(0, 0.006), 0.085 * vel, pan=0.35 if j % 2 else -0.35)
        if k % 2 == 0:
            m = BELLS[rng.integers(len(BELLS))]
            if m not in bell_cache:
                bell_cache[m] = bell_note(m)
            place(bells, bell_cache[m], t + BEAT * rng.integers(0, 6), 0.035, pan=rng.uniform(-0.5, 0.5))
        for b in range(8):  # light pulse: kick on 1 and 3, shaker on 8ths
            if b % 2 == 0:
                place(beat, kick(), t + b * BEAT, 0.08)
        for j in range(16):
            place(beat, shaker(), t + j * BEAT / 2, 0.018 if j % 2 else 0.01, pan=0.25)
        t += CHORD
        k += 1

    # arrangement: who plays when
    a_arp = automation([(0, 0), (8, 0), (12, 0.75), (demo0, 0.85), (demo1, 0.85), (outro - 1, 0.6), (outro + 4, 0), (dur, 0)], n)
    a_bass = automation([(0, 0), (9, 0), (14, 0.7), (demo0, 1), (demo1, 1), (outro - 2, 0.6), (outro + 3, 0), (dur, 0)], n)
    a_beat = automation([(0, 0), (demo0 - 2, 0), (demo0 + 3, 1), (demo1 - 3, 1), (demo1 + 2, 0), (dur, 0)], n)
    a_bell = automation([(0, 1), (12, 1), (16, 0.5), (outro - 4, 0.5), (outro, 1.2), (dur, 1.2)], n)
    music = pad + arp * a_arp[:, None] + bass * a_bass[:, None] + beat * a_beat[:, None] + bells * a_bell[:, None]
    music = reverb(music)

    sfx = np.zeros((n, 2))
    for c in tl["cues"]:
        if c["type"] == "whoosh":
            place(sfx, whoosh(), c["t"] - 0.4, 0.05)
        elif c["type"] == "chime":
            place(sfx, chime(), c["t"], 0.085, pan=0.1)
        elif c["type"] == "slash":
            place(sfx, thud(), c["t"], 0.22)
        elif c["type"] == "tick":
            place(sfx, tick(), c["t"], 0.05, pan=-0.2)
    sfx = reverb(sfx, 1.8, 0.22)

    mix = music + sfx
    fade = np.minimum(1, t_axis(n) / 2.5) * np.clip((dur - 0.5 - t_axis(n)) / 4.5, 0, 1)
    mix *= fade[:, None]
    mix = np.tanh(mix * 1.8) / 1.8
    # music bed at -26 dBFS RMS, dipping about 8 dB under the voice (voice lines sit at -20 dBFS)
    mix *= 10 ** (-26 / 20) / np.sqrt((mix ** 2).mean())
    voice, talk = voice_track(tl, n)
    mix = mix * (1 - 0.6 * talk)[:, None] + voice[:, None]
    mix /= max(1.0, np.abs(mix).max() / 0.98)

    raw = HERE / "soundtrack.raw.wav"
    with wave.open(str(raw), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((mix * 32767).astype("<i2").tobytes())
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-af", "loudnorm=I=-17:TP=-1.5:LRA=11",
                    "-ar", str(SR), str(HERE / "soundtrack.wav")], check=True)
    raw.unlink()
    print(f"wrote soundtrack.wav ({dur:.1f} s, {len(tl['cues'])} cues, {len(tl.get('narration', []))} voice lines)")


if __name__ == "__main__":
    main()
