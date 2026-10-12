# Design — live-sound-capture

## Architecture

```
mic ── getUserMedia ──► MediaStreamSource ──► AudioWorkletNode("live-capture")
                                                         │  per 128-sample quantum
                                                         ▼
                       { rms, samples: Float32Array, t: AudioContext time }
                                                         │
                                                         ▼
   ┌────────────────────────── state machine (engine.ts) ──────────────────────────┐
   │  pre-roll ring buffer ◄── every sample                                          │
   │  IDLE:      db ≥ triggerDb for triggerHoldMs ──► RECORDING                      │
   │  RECORDING: db ≤ stopDb for stopHoldMs (age ≥ minClipSec) ──► IDLE              │
   │             age ≥ maxClipSec ──► IDLE                                            │
   └────────────────────────────────────────────────────────────────────────────────┘
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

| Condition | Action |
| --- | --- |
| `IDLE`, `db ≥ triggerDb` | accumulate `aboveMs`; at `triggerHoldMs` → start clip |
| `IDLE`, `db < triggerDb` | `aboveMs = 0` |
| `RECORDING`, append samples; track `peakDb` | — |
| `RECORDING`, `age ≥ minClipSec` and `db ≤ stopDb` for `stopHoldMs` | end clip ("quiet") |
| `RECORDING`, `age ≥ maxClipSec` | end clip ("max duration") |

Defaults: trigger −20 dBFS / 300 ms, stop −40 dBFS / 2000 ms, max 60 s,
min 1 s, pre-roll 2 s. Stop below trigger (hysteresis) prevents a steady
noise from flapping start/stop every loop.

## Pre-roll

A `Float32Array` ring of `preRollSec × sampleRate` samples, written for every
quantum while monitoring. On trigger it is dumped oldest-first and prepended
to the clip's chunks. The ring is reallocated when `preRollSec` changes or
monitoring starts.

## Clip assembly

`chunks: Float32Array[]` + running `length` → concatenated once at clip end →
`encodeWav` (44-byte RIFF header, 16-bit little-endian PCM, mono, native
sample rate — typically 44.1 or 48 kHz). Memory: a 60 s clip ≈ 10.5 MB raw /
5.3 MB WAV. In-memory clip cap is 100; the oldest is evicted with an `error`
log entry prompting the user to save.

## Event log

Fields: `seq`, `ts` (epoch ms), `iso` (local ISO 8601 with offset),
`audioTime` (AudioContext seconds, null if unknown), `type`, `message`,
`db` (raw dBFS at event time), `clipId`.

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

`localStorage`: `live-sound-capture.config` (thresholds),
`live-sound-capture.calibration` (offset). Both ignored gracefully when
storage is unavailable.

## File map

| File | Role |
| --- | --- |
| `meta.ts` | Portfolio display info (dormant `@/labs/types` import here) |
| `index.tsx` | React instrument panel — the only React file |
| `engine.ts` | Worklet source + `LiveSoundEngine` (detection, clips, log, save) |
| `wav.ts` | 16-bit PCM WAV encoder |
| `types.ts` | Shared types |
| `dev/` | Local-only Vite+React+Tailwind harness, never ported |
