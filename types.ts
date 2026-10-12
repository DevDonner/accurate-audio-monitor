// Shared types for the live-sound-capture lab.

export type EngineState = 'idle' | 'listening' | 'recording'

export interface EngineConfig {
  /**
   * Optional quiet-stop. ON = a clip also ends (and saves, if it contains a
   * trigger) as soon as the sound drops below stopDb for stopHoldMs.
   * OFF (default) = clips run the full maxClipSec before ending.
   */
  stopOnQuiet: boolean
  /** dBFS level that ends the current clip and saves it (with triggerHoldMs of sustain). */
  triggerDb: number
  /**
   * Write finished clips to the connected save folder the moment they end.
   * OFF (default) = clips stay in memory; use "Save clips" / Download.
   */
  autoSave: boolean
  /** dBFS level a clip must fall below (for stopHoldMs) to end. Keep below triggerDb. Only used when stopOnQuiet. */
  stopDb: number
  /** Noise must stay ≥ triggerDb this long before a clip ends (spike guard). */
  triggerHoldMs: number
  /** Silence must stay ≤ stopDb this long before a clip ends. Only used when stopOnQuiet. */
  stopHoldMs: number
  /** Hard cap on clip length. */
  maxClipSec: number
  /** A clip never stops before this age (avoids 0.2 s slivers). */
  minClipSec: number
  /** Seconds of audio kept before the trigger and prepended to each clip. */
  preRollSec: number
}

export type LogType =
  | 'monitor-start'
  | 'monitor-stop'
  | 'clip'
  | 'trigger'
  | 'stop'
  | 'delete'
  | 'config'
  | 'calibration'
  | 'folder'
  | 'error'

export interface LogEvent {
  seq: number
  /** Wall-clock epoch ms at the moment the event fired. */
  ts: number
  /** Local time, ISO 8601 with UTC offset (human-readable). */
  iso: string
  /** AudioContext clock at event time (sample clock), null if unavailable. */
  audioTime: number | null
  type: LogType
  message: string
  /** Raw dBFS at event time, when applicable. */
  db: number | null
  clipId: string | null
  /**
   * Background-only event: stays in the log (and in the exported event CSV)
   * as the record, but is hidden from the user-facing Activity feed. Used for
   * per-clip "started" lines and for clip ends that are discarded (room tone).
   */
  internal?: boolean
}

export interface Clip {
  id: string
  /** File name the WAV is saved under. */
  name: string
  /** Wall-clock epoch ms when the clip started. */
  startTs: number
  /** Wall-clock epoch ms when the clip ended. */
  endTs: number
  /** Seconds of audio from clip start to end (pre-roll excluded). */
  recSec: number
  /** Seconds of audio in the WAV file (includes pre-roll). */
  fileSec: number
  startDb: number
  /** Peak level after the clip started (pre-roll excluded). */
  peakDb: number
  /** Encoded 16-bit WAV. */
  blob: Blob
  /** Object URL for playback / download. */
  url: string
  /** True once written to the chosen save folder. */
  saved: boolean
}

export interface MicDevice {
  deviceId: string
  label: string
}
