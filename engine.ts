// LiveSoundEngine — the whole lab.
//
// Data flow:
//   mic -> MediaStreamSource -> AudioWorklet("live-capture")
//        -> per-quantum message { rms, samples, t? } -> state machine
//   (t = context clock when the worklet exposes it; the engine otherwise
//    owns the clock and advances it one 128-sample quantum per message)
//
// State machine (runs on the audio-clock, so hold timers are sample-accurate):
//   A clip is ALWAYS running — recording never pauses between clips.
//   END when the level stays >= triggerDb for triggerHoldMs (trigger; the
//     detector re-arms only after the level drops back below the trigger)
//   END when stopOnQuiet and the level stays <= stopDb for stopHoldMs (quiet)
//   END when clip age >= maxClipSec (max duration)
//   An ended clip is kept + saved only if it contains audio at/above the
//   trigger level (peakDb >= triggerDb); everything else is room tone and
//   gets discarded (the log keeps the record). Auto-save writes kept clips
//   to the connected folder immediately when config.autoSave is on.
//
// Every clip is a 16-bit WAV (wav.ts) including pre-roll from a ring buffer.
// An append-only event log records everything with wall + audio timestamps.

import { encodeWav } from './wav'
import type { Clip, EngineConfig, EngineState, LogEvent, LogType, MicDevice } from './types'

export const DEFAULT_CONFIG: EngineConfig = {
  stopOnQuiet: false, // clips run the full maxClipSec unless this is on
  autoSave: false, // opt-in: write finished clips to the folder the moment they end
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
      // The engine owns the audio clock (main thread). Include the context
      // clock too when this browser exposes it on the processor — current
      // Chrome/Edge removed currentTime/sampleRate from the worklet scope,
      // so the time field is often absent and the engine estimates it.
      const msg = { rms: rms, samples: copy };
      if (typeof this.currentTime === 'number') msg.t = this.currentTime;
      this.port.postMessage(msg, [copy.buffer]);
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

// ------------------------------------------------- folder persistence (IDB)
// Directory handles can be stored in IndexedDB and re-requested on the next
// visit, so the evidence folder survives page reloads / browser restarts.

const IDB_NAME = 'live-sound-capture'
const IDB_STORE = 'handles'

/** TS's lib.dom doesn't have these File System Access permission methods yet. */
interface FsPermissionMethods {
  queryPermission(desc: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission(desc: { mode: 'readwrite' }): Promise<PermissionState>
}

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idbOpen()
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idbOpen()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
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
  /** AudioContext time the clip started (pre-roll not included). */
  startAudioTime: number
  startDb: number
  peakDb: number
  /**
   * Whether the trigger detector is armed for this clip. A clip that starts
   * while the level is already above the trigger (right after a trigger end)
   * starts disarmed and only re-arms once the level dips back below — this
   * keeps sustained loud sound from flooding 0.3 s clips.
   */
  armed: boolean
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
  private sink: GainNode | null = null
  private preRoll = new Float32Array(0)
  private preRollIdx = 0
  private active: ActiveClip | null = null
  private aboveMs = 0
  private belowMs = 0
  private lastAudioTime: number | null = null
  private seq = 0
  private listeners = new Set<() => void>()
  /** Folder handle from a previous visit, awaiting the one-click reconnect. */
  private pendingFolder: FileSystemDirectoryHandle | null = null

  constructor() {
    const stored = loadJson<Partial<EngineConfig>>(CONFIG_KEY) ?? {}
    // `gated` existed before the always-recording redesign — drop it so it
    // can't linger in the live config object.
    delete (stored as Record<string, unknown>).gated
    this.config = { ...DEFAULT_CONFIG, ...stored }
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

  private pushLog(
    type: LogType,
    message: string,
    db: number | null,
    clipId: string | null,
    internal = false,
  ): void {
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
      // Only present on background events so the exported CSV / JSON stay clean.
      ...(internal ? { internal: true } : {}),
    }
    this.log.push(e)
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG)
    this.emit()
  }

  // ---------------------------------------------------------------- mics

  async listMics(): Promise<MicDevice[]> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      // Browsers hide device IDs until permission is granted; those empty-ID
      // placeholders are useless in the picker, so skip them.
      .filter((d) => d.kind === 'audioinput' && d.deviceId !== '')
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

  /** `deviceId` may be '' — meaning "the browser's default microphone". */
  async start(deviceId: string): Promise<void> {
    if (this.state !== 'idle') throw new Error('Already running — stop it first.')
    const audio: MediaTrackConstraints = {
      // Evidence, not a call: no processing that would reshape the sound.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    }
    if (deviceId !== '') audio.deviceId = { exact: deviceId }
    this.stream = await navigator.mediaDevices.getUserMedia({ audio })
    this.ctx = new AudioContext()
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    await this.ctx.audioWorklet.addModule(workletUrl())
    this.node = new AudioWorkletNode(this.ctx, 'live-capture')
    this.node.port.onmessage = (ev: MessageEvent) => this.onQuantum(ev.data)
    this.ctx.createMediaStreamSource(this.stream).connect(this.node)
    // Chrome/Edge will not run a worklet whose output never reaches the
    // destination — even with a live MediaStreamSource feeding it. Route the
    // output through a zero-gain sink so the graph is pulled (and the mic
    // is never audible).
    this.sink = this.ctx.createGain()
    this.sink.gain.value = 0
    this.node.connect(this.sink)
    this.sink.connect(this.ctx.destination)

    this.sampleRate = this.ctx.sampleRate
    // Permission is granted now, so re-enumeration yields real labels —
    // resolve against the device the track actually came from.
    const usedId = this.stream.getAudioTracks()[0]?.getSettings().deviceId ?? ''
    this.micLabel =
      (await this.listMics()).find((d) => d.deviceId === usedId)?.label ??
      (deviceId === '' ? 'default microphone' : 'selected mic')
    this.resetPreRoll()
    this.history = []
    this.aboveMs = 0
    this.belowMs = 0
    this.lastAudioTime = null
    this.state = 'listening'
    this.pushLog(
      'monitor-start',
      `Monitoring on “${this.micLabel}” @ ${this.sampleRate} Hz — always recording; a clip saves when the level crosses ${this.config.triggerDb} dBFS${
        this.config.stopOnQuiet ? ', or when the sound goes quiet' : ''
      } (max ${this.config.maxClipSec} s)`,
      null,
      null,
    )
    this.startClip(this.ctx.currentTime, this.levelDb, true)
    this.emit()
  }

  stop(): void {
    if (this.state === 'idle') return
    if (this.active) this.endClip('monitor stopped', this.lastAudioTime ?? 0, this.levelDb)
    this.node?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close().catch(() => {})
    this.node = null
    this.sink = null
    this.stream = null
    this.ctx = null
    this.sampleRate = null
    this.micLabel = null
    this.levelDb = DB_FLOOR
    this.history = []
    this.state = 'idle'
    this.pushLog('monitor-stop', 'Monitoring stopped', null, null)
    this.emit()
    if (this.folder && this.config.autoSave) {
      // Keep the evidence folder current with the session record.
      void this.saveEventLog().catch(() => {})
    }
  }

  destroy(): void {
    this.stop()
    this.listeners.clear()
  }

  // ---------------------------------------------------- detection core

  private onQuantum(m: { rms: number; samples: Float32Array; t?: number }): void {
    const db = dbFromRms(m.rms)
    const sr = this.sampleRate ?? 48000
    // The engine owns the audio clock: use the worklet-reported context time
    // when available, otherwise advance exactly one 128-sample quantum per
    // message (anchored to the context clock at monitor start).
    const prev = this.lastAudioTime
    const now: number =
      typeof m.t === 'number'
        ? m.t
        : prev == null
          ? (this.ctx ? this.ctx.currentTime : 0)
          : prev + 128 / sr
    this.lastAudioTime = now
    const dtMs = prev == null ? 128000 / sr : (now - prev) * 1000

    this.levelDb = db
    this.history.push(db)
    if (this.history.length > HISTORY_LEN) {
      this.history.splice(0, this.history.length - HISTORY_LEN)
    }
    this.writePreRoll(m.samples)

    if (this.state !== 'listening' && this.state !== 'recording') return

    if (!this.active) {
      // A clip must always be running — (re)start immediately.
      this.startClip(now, db, true)
    } else {
      this.active.chunks.push(m.samples)
      this.active.length += m.samples.length
      if (db > this.active.peakDb) this.active.peakDb = db

      // Trigger: re-arm when the level dips below the trigger, then end the
      // clip as soon as it is sustained above. A clip that starts loud
      // (right after a trigger) stays disarmed until a dip — no sliver flood.
      if (!this.active.armed && db < this.config.triggerDb) {
        this.active.armed = true
        this.aboveMs = 0
      }
      if (this.active.armed) {
        this.aboveMs = db >= this.config.triggerDb ? this.aboveMs + dtMs : 0
      }
      if (this.config.stopOnQuiet) {
        this.belowMs = db <= this.config.stopDb ? this.belowMs + dtMs : 0
      }

      const ageSec = now - this.active.startAudioTime
      if (this.active.armed && this.aboveMs >= this.config.triggerHoldMs) {
        this.endClip(`trigger (level crossed ${this.config.triggerDb} dBFS)`, now, db)
        this.startClip(now, db, false)
      } else if (
        this.config.stopOnQuiet &&
        ageSec >= this.config.minClipSec &&
        this.belowMs >= this.config.stopHoldMs
      ) {
        this.endClip('quiet', now, db)
        this.startClip(now, db, true)
      } else if (ageSec >= this.config.maxClipSec) {
        this.endClip('max duration', now, db)
        this.startClip(now, db, db < this.config.triggerDb)
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

  /** Age of the in-progress clip, for the UI's "REC 0:37 / 1:00" row. */
  get activeClip(): { startTs: number; ageSec: number } | null {
    const a = this.active
    if (!a) return null
    return { startTs: a.startTs, ageSec: Math.max(0, (this.lastAudioTime ?? 0) - a.startAudioTime) }
  }

  private startClip(t: number, db: number, armed: boolean): void {
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
      // Only samples accumulated after this clip started count — the loud
      // boundary moment belongs to the previous clip's tail, not to the
      // audio this clip will carry.
      peakDb: DB_FLOOR,
      armed,
    }
    this.state = 'recording'
    this.aboveMs = 0
    this.belowMs = 0
    // A clip is always running, so "started" is per-clip chatter — keep it in
    // the log/CSV but out of the user's Activity feed.
    this.pushLog(
      'clip',
      `Clip started — ends on trigger, ${this.config.stopOnQuiet ? 'quiet, ' : ''}or at ${this.config.maxClipSec} s`,
      db,
      null,
      true,
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
    // A clip is evidence only if it contains audio at/above the trigger
    // level. Room tone is discarded — the log keeps the record either way.
    const keep = clip.peakDb >= this.config.triggerDb
    this.aboveMs = 0
    this.belowMs = 0
    this.state = 'listening'
    if (keep) {
      // The moment that matters — surfaced in the user's Activity feed.
      this.pushLog(
        'stop',
        `Saved clip (${reason}) — ${clip.recSec.toFixed(1)} s, peak ${clip.peakDb.toFixed(1)} dBFS, file ${clip.fileSec.toFixed(1)} s incl. ${this.config.preRollSec} s pre-roll`,
        db,
        clip.id,
      )
    } else {
      // Room tone — kept in the log/CSV as the record, hidden from the user.
      this.pushLog(
        'stop',
        `Stopped (${reason}) at ${db.toFixed(1)} dBFS — ${clip.recSec.toFixed(1)} s — discarded, never reached ${this.config.triggerDb} dBFS (peak ${clip.peakDb.toFixed(1)} dBFS)`,
        db,
        null,
        true,
      )
    }
    if (keep) {
      this.clips.push(clip)
      while (this.clips.length > MAX_CLIPS) this.evictOldest()
      // Opt-in: when auto-save is on, the moment a clip exists it goes to
      // the connected folder.
      if (this.folder && this.config.autoSave) {
        void this.saveClip(clip).catch((e) =>
          this.pushLog('error', `Auto-save failed for ${clip.name}: ${errMsgOf(e)}`, null, clip.id),
        )
      }
    } else {
      URL.revokeObjectURL(clip.url)
    }
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

  /**
   * Drop a reviewed clip from the list. Its object URL is revoked; the
   * deletion is logged so the event record stays honest. (The audio itself
   * is gone from memory — only a re-record recovers it.)
   */
  deleteClip(id: string): void {
    const i = this.clips.findIndex((c) => c.id === id)
    if (i === -1) return
    const [clip] = this.clips.splice(i, 1)
    URL.revokeObjectURL(clip.url)
    this.pushLog(
      'delete',
      `Deleted clip “${clip.name}” — reviewed, not kept. ${
        clip.saved ? 'A copy exists in the save folder.' : 'No copy was saved to disk.'
      }`,
      null,
      clip.id,
    )
    this.emit()
  }

  // ------------------------------------------------------------- config

  setConfig(patch: Partial<EngineConfig>): void {
    const c = this.config
    this.config = {
      stopOnQuiet: patch.stopOnQuiet ?? c.stopOnQuiet,
      autoSave: patch.autoSave ?? c.autoSave,
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
      `Trigger ${this.config.triggerDb} dBFS (hold ${this.config.triggerHoldMs} ms)${
        this.config.stopOnQuiet
          ? `, stop ${this.config.stopDb} dBFS (hold ${this.config.stopHoldMs} ms)`
          : ''
      } — clips save on trigger or at ${this.config.maxClipSec} s; auto-save ${
        this.config.autoSave ? 'on' : 'off'
      }`,
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

  /** Previously chosen folder awaiting a click-to-reconnect (see restoreFolder). */
  get pendingFolderName(): string | null {
    return this.pendingFolder?.name ?? null
  }

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
    this.pendingFolder = null
    void idbSet('folder', handle).catch(() => {})
    this.pushLog(
      'folder',
      `Save folder: “${handle.name}”${this.config.autoSave ? ' — auto-saving clips here' : ' (auto-save off — use “Save clips”)'}`,
      null,
      null,
    )
    // Only touch the folder automatically when the user asked for it.
    if (this.config.autoSave) {
      await this.saveAllClips()
      await this.saveEventLog()
    }
    this.emit()
  }

  /**
   * Called on page load: if a folder was chosen before, reattach it.
   * Browsers keep the granted permission in many cases; otherwise the handle
   * is stashed as pendingFolder and the UI offers a one-click reconnect.
   */
  async restoreFolder(): Promise<void> {
    if (!this.fsSupported || this.folder) return
    let handle: FileSystemDirectoryHandle | null = null
    try {
      handle = (await idbGet<FileSystemDirectoryHandle>('folder')) ?? null
    } catch {
      return
    }
    if (!handle) return
    try {
      const perm = await (handle as unknown as FsPermissionMethods).queryPermission({
        mode: 'readwrite',
      })
      if (perm === 'granted') {
        this.folder = handle
        this.folderName = handle.name
        this.pushLog('folder', `Reconnected save folder: “${handle.name}”`, null, null)
      } else {
        this.pendingFolder = handle
        this.pushLog(
          'folder',
          `Save folder “${handle.name}” found — click “Reconnect folder” to re-allow access`,
          null,
          null,
        )
      }
    } catch {
      /* handle no longer usable */
    }
    this.emit()
  }

  /** Must run inside a user gesture — the browser requires one for requestPermission. */
  async reconnectFolder(): Promise<void> {
    const handle = this.pendingFolder
    if (!handle) throw new Error('No saved folder to reconnect.')
    const perm = await (handle as unknown as FsPermissionMethods).requestPermission({
      mode: 'readwrite',
    })
    if (perm !== 'granted') throw new Error('Folder permission was not granted.')
    this.folder = handle
    this.folderName = handle.name
    this.pendingFolder = null
    this.pushLog(
      'folder',
      `Reconnected save folder: “${handle.name}”${this.config.autoSave ? ' — auto-saving clips here' : ''}`,
      null,
      null,
    )
    if (this.config.autoSave) await this.saveAllClips()
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

function errMsgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
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
