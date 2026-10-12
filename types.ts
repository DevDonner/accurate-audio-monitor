// Shared types for the live-sound-capture lab.

export type EngineState = 'idle' | 'listening' | 'recording'

export interface EngineConfig {
  /** dBFS level that arms a clip (with triggerHoldMs of sustain). */
  triggerDb: number
  /** dBFS level a clip must fall below (for stopHoldMs) to stop. Keep below triggerDb. */
  stopDb: number
  /** Noise must stay ≥ triggerDb this long before a clip starts (spike guard). */
  triggerHoldMs: number
  /** Silence must stay ≤ stopDb this long before a clip stops. */
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
  | 'trigger'
  | 'stop'
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
}

export interface Clip {
  id: string
  /** File name the WAV is saved under. */
  name: string
  /** Wall-clock epoch ms when the trigger fired. */
  startTs: number
  /** Wall-clock epoch ms when the clip stopped. */
  endTs: number
  /** Seconds of noise captured trigger→stop (pre-roll excluded). */
  recSec: number
  /** Seconds of audio in the WAV file (includes pre-roll). */
  fileSec: number
  startDb: number
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
