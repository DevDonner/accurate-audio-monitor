// LiveSoundEngine — the whole lab.
//
// Data flow:
//   mic -> MediaStreamSource -> AudioWorklet("live-capture")
//        -> per-quantum message { rms, samples, t } -> state machine
//
// State machine (runs on the audio-clock, so hold timers are sample-accurate):
//   IDLE(listening) --db >= triggerDb for triggerHoldMs--> RECORDING
//   RECORDING --db <= stopDb for stopHoldMs (and clip >= minClipSec)--> IDLE
//   RECORDING --clip age >= maxClipSec--> IDLE
//
// Every clip is a 16-bit WAV (wav.ts) including pre-roll from a ring buffer.
// An append-only event log records everything with wall + audio timestamps.

import { encodeWav } from './wav'
import type { Clip, EngineConfig, EngineState, LogEvent, LogType, MicDevice } from './types'

export const DEFAULT_CONFIG: EngineConfig = {
  triggerDb: -20,
  stopDb: -40,
  triggerHoldMs: 300,
  stopHoldMs: 2000,
  maxClipSec: 60,
  minClipSec: 1,
  preRollSec: 2,
}

const CONFIG_KEY = 'live-sound-capture.config'
const CAL_KEY = 'live-sound-capture.calibration'
const MAX_CLIPS = 100 // in-memory cap; oldest is evicted (and logged) beyond this
const MAX_LOG = 2000
const DB_FLOOR = -100
export const HISTORY_LEN = 3440 // ~10 s of 44.1 kHz / 128-sample quanta

// The worklet, as a string, so the lab stays a flat file set (no separate
// .js asset to wire into the host). Loaded once via a Blob URL.
const WORKLET_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length > 0) {
      let sum = 0;
      for (let i = 0; i < ch.length; i++) {
        const s = ch[i];
        sum += s * s;
      }
      const rms = Math.sqrt(sum / ch.length);
      const copy = new Float32Array(ch);
      this.port.postMessage(
        { rms: rms, t: this.context.currentTime, samples: copy },
        [copy.buffer],
      );
    }
    return true;
  }
}
registerProcessor('live-capture', CaptureProcessor);
`

export function dbFromRms(rms: number): number {
  return rms > 1e-7 ? Math.max(DB_FLOOR, 20 * Math.log10(rms)) : DB_FLOOR
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

/** Local time as ISO 8601 with UTC offset, e.g. 2026-10-12T02:14:33.214-04:00 */
export function localIso(ts: number): string {
  const d = new Date(ts)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  )
}

/** File name for a clip: local date_time of the trigger moment. */
export function clipName(ts: number): string {
  const d = new Date(ts)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}_noise.wav`
  )
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function loadJson<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key)
    return s ? (JSON.parse(s) as T) : null
  } catch {
    return null
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable (private mode) — config just won't persist */
  }
}

let workletUrlCache: string | null = null
function workletUrl(): string {
  if (!workletUrlCache) {
    workletUrlCache = URL.createObjectURL(
      new Blob([WORKLET_SRC], { type: 'application/javascript' }),
    )
  }
  return workletUrlCache
}

interface ActiveClip {
  chunks: Float32Array[]
  length: number
  startTs: number
  /** AudioContext time the trigger fired (pre-roll not included). */
  startAudioTime: number
  startDb: number
  peakDb: number
}

export class LiveSoundEngine {
  config: EngineConfig
  /** One-time calibration offset (dB) added to dBFS to approximate SPL. */
  calibration: number | null
  state: EngineState = 'idle'
  /** Raw level of the latest quantum (dBFS). */
  levelDb = DB_FLOOR
  /** Recent dB per quantum, oldest first — the meter trace. */
  history: number[] = []
  clips: Clip[] = []
  log: LogEvent[] = []
  sampleRate: number | null = null
  micLabel: string | null = null
  folder: FileSystemDirectoryHandle | null = null
  folderName: string | null = null

  /** File System Access API — the auto-save path. If absent, UI falls back to downloads. */
  readonly fsSupported =
    typeof window !== 'undefined' && 'showDirectoryPicker' in window

  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private preRoll = new Float32Array(0)
  private preRollIdx = 0
  private active: ActiveClip | null = null
  private aboveMs = 0
  private belowMs = 0
  private lastAudioTime: number | null = null
  private seq = 0
  private listeners = new Set<() => void>()

  constructor() {
    this.config = { ...DEFAULT_CONFIG, ...(loadJson<Partial<EngineConfig>>(CONFIG_KEY) ?? {}) }
    const cal = loadJson<number>(CAL_KEY)
    this.calibration = typeof cal === 'number' && Number.isFinite(cal) ? cal : null
  }

  // ---------------------------------------------------------------- state

  /** Subscribe to discrete changes (state, clips, log, config). Returns unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  private pushLog(type: LogType, message: string, db: number | null, clipId: string | null): void {
    const ts = Date.now()
    const e: LogEvent = {
      seq: ++this.seq,
      ts,
      iso: localIso(ts),
      audioTime: this.lastAudioTime,
      type,
      message,
      db,
      clipId,
    }
    this.log.push(e)
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG)
    this.emit()
  }

  // ---------------------------------------------------------------- mics

  async listMics(): Promise<MicDevice[]> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label || `Mic ${d.deviceId.slice(0, 8)}`,
      }))
  }

  /**
   * Browsers hide device labels until the page has been granted mic access.
   * This one-shot getUserMedia unlocks the names, then immediately releases
   * the mic (its own light goes off).
   */
  async revealMicLabels(): Promise<MicDevice[]> {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true })
    s.getTracks().forEach((t) => t.stop())
    return this.listMics()
  }

  // ------------------------------------------------------------- monitor

  async start(deviceId: string): Promise<void> {
    if (this.state !== 'idle') throw new Error('Already running — stop it first.')
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        // Evidence, not a call: no processing that would reshape the sound.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
    this.ctx = new AudioContext()
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    await this.ctx.audioWorklet.addModule(workletUrl())
    this.node = new AudioWorkletNode(this.ctx, 'live-capture')
    this.node.port.onmessage = (ev: MessageEvent) => this.onQuantum(ev.data)
    this.ctx.createMediaStreamSource(this.stream).connect(this.node)

    this.sampleRate = this.ctx.sampleRate
    this.micLabel =
      (await this.listMics()).find((d) => d.deviceId === deviceId)?.label ?? 'selected mic'
    this.resetPreRoll()
    this.history = []
    this.aboveMs = 0
    this.belowMs = 0
    this.lastAudioTime = null
    this.state = 'listening'
    this.pushLog(
      'monitor-start',
      `Monitoring on “${this.micLabel}” @ ${this.sampleRate} Hz — trigger ${this.config.triggerDb} dBFS, stop ${this.config.stopDb} dBFS`,
      null,
      null,
    )
    this.emit()
  }

  stop(): void {
    if (this.state === 'idle') return
    if (this.active) this.endClip('monitor stopped', this.lastAudioTime ?? 0, this.levelDb)
    this.node?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close().catch(() => {})
    this.node = null
    this.stream = null
    this.ctx = null
    this.sampleRate = null
    this.micLabel = null
    this.levelDb = DB_FLOOR
    this.history = []
    this.state = 'idle'
    this.pushLog('monitor-stop', 'Monitoring stopped', null, null)
    this.emit()
    if (this.folder) {
      // Keep the evidence folder current with the session record.
      void this.saveEventLog().catch(() => {})
    }
  }

  destroy(): void {
    this.stop()
    this.listeners.clear()
  }

  // ---------------------------------------------------- detection core

  private onQuantum(m: { rms: number; t: number; samples: Float32Array }): void {
    const db = dbFromRms(m.rms)
    const sr = this.sampleRate ?? 48000
    const dtMs =
      this.lastAudioTime == null ? (128000 / sr) : (m.t - this.lastAudioTime) * 1000
    this.lastAudioTime = m.t

    this.levelDb = db
    this.history.push(db)
    if (this.history.length > HISTORY_LEN) {
      this.history.splice(0, this.history.length - HISTORY_LEN)
    }
    this.writePreRoll(m.samples)

    if (this.state !== 'listening' && this.state !== 'recording') return

    if (!this.active) {
      if (db >= this.config.triggerDb) {
        this.aboveMs += dtMs
        if (this.aboveMs >= this.config.triggerHoldMs) this.startClip(m.t, db)
      } else {
        this.aboveMs = 0
      }
    } else {
      this.active.chunks.push(m.samples)
      this.active.length += m.samples.length
      if (db > this.active.peakDb) this.active.peakDb = db
      this.belowMs = db <= this.config.stopDb ? this.belowMs + dtMs : 0

      const ageSec = m.t - this.active.startAudioTime
      if (ageSec >= this.config.minClipSec && this.belowMs >= this.config.stopHoldMs) {
        this.endClip('quiet', m.t, db)
      } else if (ageSec >= this.config.maxClipSec) {
        this.endClip('max duration', m.t, db)
      }
    }
  }

  private writePreRoll(samples: Float32Array): void {
    const n = this.preRoll.length
    if (n === 0) return
    const i = this.preRollIdx
    if (i + samples.length <= n) {
      this.preRoll.set(samples, i)
    } else {
      const head = n - i
      this.preRoll.set(samples.subarray(0, head), i)
      this.preRoll.set(samples.subarray(head), 0)
    }
    this.preRollIdx = (i + samples.length) % n
  }

  private resetPreRoll(): void {
    this.preRoll = new Float32Array(
      Math.round(this.config.preRollSec * (this.sampleRate ?? 48000)),
    )
    this.preRollIdx = 0
  }

  private startClip(t: number, db: number): void {
    const chunks: Float32Array[] = []
    let length = 0
    if (this.preRoll.length > 0) {
      // Ring dump: everything from the write head is the oldest sample.
      const i = this.preRollIdx
      if (i === 0) chunks.push(this.preRoll.slice(0))
      else {
        chunks.push(this.preRoll.slice(i))
        chunks.push(this.preRoll.slice(0, i))
      }
      length = this.preRoll.length
    }
    this.active = {
      chunks,
      length,
      startTs: Date.now(),
      startAudioTime: t,
      startDb: db,
      peakDb: db,
    }
    this.state = 'recording'
    this.pushLog(
      'trigger',
      `Noise ${db.toFixed(1)} dBFS — above ${this.config.triggerDb} dBFS for ${Math.round(this.aboveMs)} ms`,
      db,
      null,
    )
    this.emit()
  }

  private endClip(reason: string, t: number, db: number): void {
    const a = this.active
    if (!a) return
    this.active = null
    const samples = concatChunks(a.chunks, a.length)
    const sr = this.sampleRate ?? 48000
    const blob = encodeWav(samples, sr)
    const clip: Clip = {
      id: String(a.startTs),
      name: clipName(a.startTs),
      startTs: a.startTs,
      endTs: Date.now(),
      recSec: t - a.startAudioTime,
      fileSec: samples.length / sr,
      startDb: a.startDb,
      peakDb: a.peakDb,
      blob,
      url: URL.createObjectURL(blob),
      saved: false,
    }
    this.clips.push(clip)
    while (this.clips.length > MAX_CLIPS) this.evictOldest()
    this.belowMs = 0
    this.state = 'listening'
    this.pushLog(
      'stop',
      `Stopped (${reason}) at ${db.toFixed(1)} dBFS — noise ${clip.recSec.toFixed(1)} s, file ${clip.fileSec.toFixed(1)} s incl. ${this.config.preRollSec} s pre-roll, peak ${clip.peakDb.toFixed(1)} dBFS`,
      db,
      clip.id,
    )
    this.emit()
  }

  private evictOldest(): void {
    const c = this.clips.shift()
    if (!c) return
    URL.revokeObjectURL(c.url)
    this.pushLog(
      'error',
      `Memory cap hit (${MAX_CLIPS} clips) — dropped oldest “${c.name}”. Save it to your folder sooner.`,
      null,
      c.id,
    )
  }

  // ------------------------------------------------------------- config

  setConfig(patch: Partial<EngineConfig>): void {
    const c = this.config
    this.config = {
      triggerDb: clamp(patch.triggerDb ?? c.triggerDb, -90, 0),
      stopDb: clamp(patch.stopDb ?? c.stopDb, -90, 0),
      triggerHoldMs: clamp(patch.triggerHoldMs ?? c.triggerHoldMs, 0, 10000),
      stopHoldMs: clamp(patch.stopHoldMs ?? c.stopHoldMs, 0, 10000),
      maxClipSec: clamp(patch.maxClipSec ?? c.maxClipSec, 5, 600),
      minClipSec: clamp(patch.minClipSec ?? c.minClipSec, 0, 30),
      preRollSec: clamp(patch.preRollSec ?? c.preRollSec, 0, 10),
    }
    saveJson(CONFIG_KEY, this.config)
    if (this.state !== 'idle') this.resetPreRoll()
    this.pushLog(
      'config',
      `trigger ${this.config.triggerDb} dBFS / stop ${this.config.stopDb} dBFS / hold ${this.config.triggerHoldMs}+${this.config.stopHoldMs} ms / pre-roll ${this.config.preRollSec} s / max ${this.config.maxClipSec} s`,
      null,
      null,
    )
    this.emit()
  }

  /**
   * Single-point calibration: the user reports a known SPL at the mic and we
   * store the difference. displayDb = dBFS + offset ≈ SPL. One honest number,
   * not a fake precision.
   */
  calibrateFrom(knownSplDb: number): void {
    this.setCalibration(knownSplDb - this.levelDb)
  }

  setCalibration(offset: number | null): void {
    this.calibration = offset
    if (offset == null) {
      try {
        localStorage.removeItem(CAL_KEY)
      } catch {
        /* ignore */
      }
    } else {
      saveJson(CAL_KEY, offset)
    }
    this.pushLog(
      'calibration',
      offset == null
        ? 'Calibration cleared — showing raw dBFS'
        : `Calibration set: +${offset.toFixed(1)} dB offset (meter ≈ dB SPL)`,
      null,
      null,
    )
    this.emit()
  }

  /** Level as shown to the user (dBFS, or ≈ dB SPL when calibrated). */
  get displayDb(): number {
    return this.levelDb + (this.calibration ?? 0)
  }

  // ---------------------------------------------------------------- save

  async chooseFolder(): Promise<void> {
    if (!this.fsSupported) {
      throw new Error('This browser cannot write to folders — use the per-clip downloads instead.')
    }
    const w = window as Window & {
      showDirectoryPicker?: (opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle>
    }
    const handle = await w.showDirectoryPicker!({ mode: 'readwrite' })
    this.folder = handle
    this.folderName = handle.name
    this.pushLog('folder', `Save folder: “${handle.name}” — auto-saving clips here`, null, null)
    await this.saveAllClips()
    await this.saveEventLog()
    this.emit()
  }

  async saveClip(clip: Clip): Promise<void> {
    if (!this.folder) throw new Error('No save folder chosen.')
    const fh = await this.folder.getFileHandle(clip.name, { create: true })
    const w = await fh.createWritable()
    await w.write(clip.blob)
    await w.close()
    clip.saved = true
    this.pushLog(
      'folder',
      `Saved ${clip.name} (${(clip.blob.size / 1024).toFixed(0)} KB)`,
      null,
      clip.id,
    )
    this.emit()
  }

  async saveAllClips(): Promise<void> {
    for (const c of this.clips) if (!c.saved) await this.saveClip(c)
  }

  async saveEventLog(): Promise<void> {
    if (!this.folder) throw new Error('No save folder chosen.')
    await this.writeFolderFile('noise-events.csv', this.eventsCsv())
    await this.writeFolderFile('session.json', this.sessionJson())
    this.pushLog('folder', `Saved noise-events.csv (${this.log.length} events) + session.json`, null, null)
    this.emit()
  }

  private async writeFolderFile(name: string, text: string): Promise<void> {
    const fh = await this.folder!.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    await w.write(text)
    await w.close()
  }

  private csvField(s: string | number): string {
    const t = String(s)
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
  }

  eventsCsv(): string {
    const head = 'seq,timestamp_local,timestamp_utc,type,message,dbfs,clip_id'
    const rows = this.log.map((e) =>
      [
        e.seq,
        this.csvField(e.iso),
        this.csvField(new Date(e.ts).toISOString()),
        e.type,
        this.csvField(e.message),
        e.db == null ? '' : e.db.toFixed(2),
        e.clipId ?? '',
      ].join(','),
    )
    return [head, ...rows].join('\n')
  }

  sessionJson(): string {
    return JSON.stringify(
      {
        app: 'live-sound-capture',
        generated: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        sampleRateHz: this.sampleRate,
        mic: this.micLabel,
        config: this.config,
        calibrationOffsetDb: this.calibration,
        notes: [
          'dBFS is relative to the mic\u2019s own digital ceiling, not calibrated sound pressure.',
          'When set, calibrated reading \u2248 dBFS + calibrationOffsetDb (single-point calibration).',
          'Timestamps come from the capturing device\u2019s clock.',
        ],
      },
      null,
      2,
    )
  }
}

function concatChunks(chunks: Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}
