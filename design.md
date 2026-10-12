# Design — live-sound-capture

## Architecture

```
mic ── getUserMedia ──► MediaStreamSource ──► AudioWorkletNode("live-capture")
                                                         │  per 128-sample quantum
                                                         ▼
                       { rms, samples: Float32Array, t: AudioContext time }
                                                         │
                                                         ▼
   ┌────────────────────────── state machine (engine.ts)───────────────────────────┐
   │  a clip is ALWAYS running — recording never pauses between clips              │
   │  END + SAVE  level ≥ triggerDb held triggerHoldMs (armed; re-arms on dip)     │
   │  END         stopOnQuiet: level ≤ stopDb held stopHoldMs, age ≥ minClipSec    │
   │  END         age ≥ maxClipSec                                                 │
   │  keep iff peakDb ≥ triggerDb — else discarded (room tone, logged)             │
   └───────────────────────────────────────────────────────────────────────────────┘
         │ trigger/stop events                │ clip end
         ▼                                    ▼
   append-only event log              WAV encode (wav.ts) ──► Clip { blob, url, saved }
         │                                                │
         ▼                                                ▼
   noise-events.csv + session.json            save folder (File System Access API)
   (File System Access API)                   2026-10-12_02-14-33_noise.wav
```

## The detection state machine

Timers run on the **AudioContext clock** (`dt` between quanta), not the
wall clock — hold times are sample-accurate and survive tab throttling
drift. The wall clock (`Date.now()`) is recorded at each boundary for the
log.

**There is no idle state — a clip is always running.** Monitoring starts a
clip immediately, and the quantum after any clip ends starts the next.
Three boundaries end a clip:

| Condition | Action |
| --- | --- |
| armed, `db ≥ triggerDb` held for `triggerHoldMs` | end ("trigger") → next clip starts **disarmed** |
| `stopOnQuiet`, `age ≥ minClipSec`, `db ≤ stopDb` held for `stopHoldMs` | end ("quiet") → next clip starts armed |
| `age ≥ maxClipSec` | end ("max duration") → next clip armed iff `db < triggerDb` |

An ended clip is **kept** iff `peakDb ≥ triggerDb` — it contains audio at
the evidence level. Kept clips go to the clip list and, with auto-save on,
straight to the save folder; everything else is room tone and gets
discarded (object URL revoked) with one log line. This is what makes
"always recording" cheap: memory and disk hold only the loud moments.

**Re-arm on dip.** A clip that starts while the level is already loud
(the one that begins right after a trigger) starts *disarmed* and only
arms once the level drops back below the trigger. Sustained loud sound
therefore produces `maxClipSec`-long clips, never a flood of
`triggerHoldMs` slivers; a dip below the trigger and a rise again arms the
next episode.

`stopOnQuiet` is **off** by default — clips run the full `maxClipSec`.
Defaults: trigger −20 dBFS / 300 ms, stop −40 dBFS / 2000 ms, max 60 s,
min 1 s, pre-roll 2 s. Stop below trigger (hysteresis) prevents a steady
noise from flapping clip boundaries every loop.

## Pre-roll

A `Float32Array` ring of `preRollSec × sampleRate` samples, written for every
quantum while monitoring. When a new clip starts it is dumped oldest-first and
prepended to the clip's chunks — so every clip carries the seconds before its
boundary. The ring is reallocated when `preRollSec` changes or monitoring
starts.

## Clip assembly

`chunks: Float32Array[]` + running `length` → concatenated once at clip end →
`encodeWav` (44-byte RIFF header, 16-bit little-endian PCM, mono, native
sample rate — typically 44.1 or 48 kHz). Memory: a 60 s clip ≈ 10.5 MB raw /
5.3 MB WAV. In-memory clip cap is 100; the oldest is evicted with an `error`
log entry prompting the user to save. A reviewed clip can also be dropped by
the user (per-clip Delete): spliced from the list, object URL revoked, and a
`delete` event records the removal (noting whether a disk copy exists). The
UI is two-step — Delete arms a pulsing Confirm that auto-cancels after ~4 s
— so evidence can't be lost to a stray click. Delete never touches files
already in the save folder.

## Event log

Fields: `seq`, `ts` (epoch ms), `iso` (local ISO 8601 with offset),
`audioTime` (AudioContext seconds, null if unknown), `type`, `message`,
`db` (raw dBFS at event time), `clipId`, `internal` (optional — present only
on background events).

The live Activity feed renders only non-`internal` events (saves + system
changes). Background events — each clip's `started` line and clip ends that are
discarded as room tone — stay in the log and in `noise-events.csv` but are
hidden from the feed, so a quiet night doesn't scroll it.

`audioTime` note: current Chrome/Edge expose no clock inside the worklet
scope (`AudioWorkletProcessor.currentTime` was removed), so the engine owns
the audio clock on the main thread: anchored to `ctx.currentTime` at monitor
start, advanced exactly 128 samples per quantum. If a browser does report a
context time, it is used directly.

`noise-events.csv` columns: `seq, timestamp_local, timestamp_utc, type,
message, dbfs, clip_id` — message is RFC-4180 quoted when needed.

`session.json`: app id, generation time, IANA timezone, sample rate, mic
label, full config, calibration offset, and plain-language notes about what
the numbers do and don't mean.

## Measurements — the honest part

- `dBFS = 20·log10(rms)`, floored at −100. RMS per 128-sample quantum
  (≈2.9 ms). This is a *level*, not a legal SPL — it depends on the mic.
- Calibration is single-point: `offset = knownSPL − currentDbFS`, stored in
  `localStorage`, applied display-only. CSV/JSON keep raw dBFS + offset.
- Timestamps come from the device clock. The lab says so in `session.json`.

## Persistence

- `localStorage`: `live-sound-capture.config` (mode + thresholds),
  `live-sound-capture.calibration` (offset). Both ignored gracefully when
  storage is unavailable.
- `IndexedDB` (`live-sound-capture` / `handles`): the chosen save-folder
  `FileSystemDirectoryHandle`. On load the engine calls `queryPermission`;
  if still granted the folder is reattached silently, otherwise a
  "Reconnect folder" button re-requests permission on click (the browser
  requires a user gesture for `requestPermission`).

## Auto-save

Opt-in (`autoSave`, default **off**): the folder is only touched when the
user says so. When on, kept clips are written the moment they end — no
manual "Save" click — and the event log CSV/JSON refresh on stop and on
folder (re)connect. When off, the explicit buttons do the writing:
"Save clips", "Event log", and per-clip "Download".

## File map

| File | Role |
| --- | --- |
| `meta.ts` | Portfolio display info (dormant `@/labs/types` import here) |
| `index.tsx` | React instrument panel — the only React file |
| `engine.ts` | Worklet source + `LiveSoundEngine` (detection, clips, log, save) |
| `wav.ts` | 16-bit PCM WAV encoder |
| `types.ts` | Shared types |
| `dev/` | Local-only Vite+React+Tailwind harness, never ported |
