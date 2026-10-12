# Live Sound Capture — Lab

**Lab #2 for the [DevDonner portfolio](https://github.com/DevDonner/portfolioWebsite).**
An always-recording noise witness: pick a mic and it records continuously
from the moment it starts — timestamped 16-bit WAV clips plus a full event
log. The moment the level crosses the trigger (default −20 dBFS) the current
clip is kept and a new one begins; clips that never reach the trigger are
discarded, so what lands in your save folder (opt-in auto-save, or one
click) is the loud moments.

> **Pitch:** "A night-watchman for your microphone. It records all night,
> writes nothing but the evidence — each clip a WAV, every second logged."

## Status
- [x] Repo scaffolded (2026-10-12)
- [x] Engine: detection state machine, pre-roll, WAV encoder
- [x] UI: meter, thresholds, calibration, activity feed, clip list
- [x] Save flow: File System Access folder + event log export (opt-in auto-save, folder persists across reloads)
- [x] Always recording: a clip is always running; the trigger keeps + saves it
- [ ] Verified end-to-end on real hardware (record → save → playback)
- [ ] Hosted at `portfolio.devdonner…/lab/live-sound-capture` (placeholder — see portfolio repo)

## What this repo is

Each portfolio lab lives in its own folder **and** its own repo. This repo is
the source of truth for the lab; the portfolio is the host. The repo root
contains **exactly the files that get copied into `src/labs/live-sound-capture/`**
in the portfolio repo — no build tooling, no extra layers. Porting is a copy,
verified by a production build.

## How it works

- **Always recording.** A mic is selected via `getUserMedia` (device
  picker). An `AudioWorklet` computes RMS per 128-sample quantum and posts it
  to the page. No echo cancellation, noise suppression, or AGC — the sound is
  left exactly as the mic heard it. A clip is **always running**: monitoring
  starts one immediately, and the quantum after any clip ends starts the
  next. Consecutive files overlap by the pre-roll (~2 s) so no second is lost
  at the seams.
- **The trigger saves.** The moment the level stays ≥ *trigger dBFS*
  (default −20) for the *trigger hold* (default 300 ms — so a single creak
  doesn't open a six-minute file), the current clip ends, is **kept** (the
  loud moment sits at its tail, with the pre-roll before it), and a new clip
  begins. The detector re-arms only after the level dips back below the
  trigger, so sustained loud sound yields max-length clips, not a flood of
  slivers. Clips whose peak never reaches the trigger are **discarded** —
  room tone, recorded in the event log but kept out of the live Activity feed, none of it in your folder or memory.
- **Quiet-stop (optional).** Tick "Stop clip when quiet" and a clip also ends
  when the level stays ≤ *stop dBFS* (default −40) for the *stop hold*
  (default 2 s); a minimum clip age (1 s) prevents slivers. Off by default:
  clips run the full max clip length (default 60 s).
- **Pre-roll.** A ring buffer keeps the last N seconds (default 2) of audio,
  so each clip starts *before* the noise — the context is part of the record.
- **WAV, not webm.** Clips are encoded as 16-bit PCM WAV in JS (`wav.ts`,
  zero dependencies) — they play in every player, on every phone.
- **Event log.** Every trigger, stop, config change, and save is appended to
  an in-memory log with wall-clock (local ISO + UTC) and audio-clock
  timestamps, exported as `noise-events.csv` plus a `session.json` that
  snapshots the mic, sample rate, thresholds, and calibration. The live Activity feed shows only saves and
   system changes; the full record — discarded room-tone clips and each clip's
   start — stays in the log and the exported CSV.
- **Auto-save, opt-in.** Tick "Auto-save clips to folder" and kept clips are
  written to the chosen folder (File System Access API) the moment they
  finish — no manual "Save" click. Off by default: clips stay in memory and
  you save with "Save clips" or the per-clip "Download". The folder handle is
  persisted in IndexedDB, so after a reload the app reattaches it
  automatically (or offers a one-click "Reconnect folder" if the browser wants
  to re-ask permission).
- **Review, then prune.** Every clip row has Play and **Delete**: hear the
  clip back, and if it isn't good enough, drop it. Deletion is two-step —
  Delete turns into a pulsing **Confirm** that auto-cancels after a few
  seconds — so evidence is never lost to a stray click. A deleted clip
  leaves memory and the deletion is logged (noting whether a copy was
  already on disk). Files already written to your save folder are never
  touched by Delete.
- **Calibration, honestly.** Browsers measure **dBFS** — relative to the
  mic's own digital ceiling — not calibrated sound pressure (dB SPL). A
  single-point calibration (play a known source at the mic, enter its real dB)
  applies an offset so the meter reads ≈ dB SPL. The CSV and `session.json`
  always record raw dBFS *and* the offset, so the numbers are reproducible
  and not oversold.
- **Privacy.** Audio never leaves the machine. Nothing is uploaded, no
  server, no analytics. Clips live in memory (capped at 100) and in the
  folder you pick.

## The portfolio lab contract

`meta.ts` + `index.tsx` (no-props React component filling its container), no
imports from the portfolio shell, Tailwind utilities are fine, folder is
liftable into any React+Vite+Tailwind app with zero changes. See
[`../README.md`](../README.md) for the full contract.

## Running it here (dev harness)

`dev/` is a local-only Vite+React+Tailwind scaffold (its own `package.json`,
`node_modules` gitignored) that mounts the **identical** `index.tsx` the
portfolio mounts — with HMR, so threshold and detection changes show up on
save:

```
cd dev
npm install        # once
npm run dev        # → http://localhost:5173
```

Note: browsers require a click for mic permission, and device labels stay
hidden until you've allowed access once (the "Name mics" button does that).
The File System Access API (folder auto-save) needs Chrome/Edge.

## Porting to the portfolio

1. Copy the lab files (`meta.ts`, `index.tsx`, `engine.ts`, `wav.ts`,
   `types.ts` — everything at repo root except `dev/`, `README.md`,
   `design.md`, `.git`) into `portfolio/src/labs/live-sound-capture/`.
2. `npm run build` in the portfolio — the registry auto-discovers the lab; it
   appears on the home page and at `/lab/live-sound-capture`. Zero config.
3. Flip `meta.ts` status from `wip` to `live` when it's done.

## Rules

- **Evidence-grade or it doesn't ship.** Timestamps must be accurate and
  reproducible; the measurement model (dBFS + optional offset) must be
  stated, never faked as precision.
- **Light.** Zero runtime dependencies beyond React. Every line readable and
  defensible.
- **Local-only.** No network access, no tracking. The whole lab works offline
  once loaded.
- **Self-contained.** No imports from outside this folder (except React in
  `index.tsx`, which the host provides).
