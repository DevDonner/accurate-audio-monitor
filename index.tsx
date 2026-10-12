// Portfolio entry point: no props, fills its container.
// The heavy lifting lives in engine.ts; this file is the instrument panel.

import { useEffect, useRef, useState } from 'react'
import { HISTORY_LEN, LiveSoundEngine } from './engine'
import type { Clip, LogEvent, MicDevice } from './types'

const METER_MIN = -80
const METER_MAX = 0

export default function LiveSoundCapture() {
  const engRef = useRef<LiveSoundEngine | null>(null)
  if (!engRef.current) engRef.current = new LiveSoundEngine()
  const eng = engRef.current

  const [, setVersion] = useState(0)
  useEffect(() => eng.subscribe(() => setVersion((v) => v + 1)), [eng])

  const [mics, setMics] = useState<MicDevice[]>([])
  const [micId, setMicId] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [knownSpl, setKnownSpl] = useState('60')

  useEffect(() => {
    eng
      .listMics()
      .then(setMics)
      .catch((e) => setErr(micErrMsg(e)))
    // Reattach the save folder from a previous visit, if permission survives.
    void eng.restoreFolder()
    return () => eng.destroy()
  }, [eng])

  // micId '' means "browser default microphone" — always a valid choice.
  const start = async () => {
    setErr(null)
    try {
      await eng.start(micId)
    } catch (e) {
      setErr(micErrMsg(e))
    }
  }

  return (
    <div className="h-full w-full flex flex-col bg-neutral-950 text-neutral-200 text-sm">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800">
        <StatusDot state={eng.state} />
        <h1 className="font-semibold text-neutral-100">Live Sound Capture</h1>
        <span className="text-xs text-neutral-500 truncate">
          {eng.config.gated
            ? `noise witness — clips fire at ${eng.config.triggerDb} dBFS, stop at ${eng.config.stopDb} dBFS`
            : `always recording — one ${eng.config.maxClipSec} s clip at a time, files land in the save folder automatically`}
        </span>
        {eng.state !== 'idle' && eng.micLabel && (
          <span className="ml-auto shrink-0 text-xs text-neutral-400">
            {eng.micLabel} · {eng.sampleRate} Hz
          </span>
        )}
      </header>

      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[1fr_340px] gap-3 p-3">
        <section className="flex flex-col gap-3 min-h-0 overflow-y-auto pr-1">
          <MeterCard
            eng={eng}
            mics={mics}
            micId={micId}
            onMic={setMicId}
            err={err}
            onNameMics={() => eng.revealMicLabels().then(setMics).catch((e) => setErr(micErrMsg(e)))}
            onStart={start}
            onStop={() => eng.stop()}
          />

          <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
            <h2 className="text-xs uppercase tracking-wider text-neutral-500 mb-2">Detection</h2>
            <label className="flex items-center gap-2 text-xs mb-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={eng.config.gated}
                onChange={(e) => eng.setConfig({ gated: e.target.checked })}
                className="accent-amber-500"
              />
              <span className="text-neutral-200">Gate on loud sound</span>
              <span className="text-neutral-500">
                {eng.config.gated
                  ? 'wait for noise above the trigger level'
                  : 'off = record continuously (recommended for evidence)'}
              </span>
            </label>
            <div
              className={`grid grid-cols-2 sm:grid-cols-4 gap-3 ${eng.config.gated ? '' : 'opacity-40 pointer-events-none'}`}
            >
              <Field label="Trigger (dBFS)" value={eng.config.triggerDb} min={-90} max={0} step={1} onChange={(v) => eng.setConfig({ triggerDb: v })} />
              <Field label="Stop (dBFS)" value={eng.config.stopDb} min={-90} max={0} step={1} onChange={(v) => eng.setConfig({ stopDb: v })} />
              <Field label="Trigger hold (ms)" value={eng.config.triggerHoldMs} min={0} max={10000} step={50} onChange={(v) => eng.setConfig({ triggerHoldMs: v })} />
              <Field label="Stop hold (ms)" value={eng.config.stopHoldMs} min={0} max={10000} step={100} onChange={(v) => eng.setConfig({ stopHoldMs: v })} />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
              <Field label="Pre-roll (s)" value={eng.config.preRollSec} min={0} max={10} step={0.5} onChange={(v) => eng.setConfig({ preRollSec: v })} />
              <Field label="Max clip (s)" value={eng.config.maxClipSec} min={5} max={600} step={5} onChange={(v) => eng.setConfig({ maxClipSec: v })} />
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
              <h2 className="text-xs uppercase tracking-wider text-neutral-500 mb-1">Calibration</h2>
              <p className="text-xs text-neutral-500 leading-4">
                dBFS is relative to this mic&rsquo;s ceiling. Play a known source at the mic, enter
                its real dB, and the meter switches to ≈&nbsp;dB&nbsp;SPL.
              </p>
              <div className="flex items-center gap-2 mt-2">
                <input
                  type="number"
                  value={knownSpl}
                  onChange={(e) => setKnownSpl(e.target.value)}
                  className="w-20 rounded bg-neutral-950 border border-neutral-800 px-2 py-1 text-neutral-200 outline-none focus:border-neutral-500"
                />
                <span className="text-xs text-neutral-500">dB at mic</span>
                <button
                  className={BTN + ' text-violet-300 border-violet-800 hover:bg-violet-950'}
                  disabled={eng.state === 'idle'}
                  onClick={() => {
                    const v = Number(knownSpl)
                    if (Number.isFinite(v)) eng.calibrateFrom(v)
                  }}
                >
                  Set
                </button>
                <button
                  className={BTN + ' text-neutral-400 border-neutral-700 hover:bg-neutral-800'}
                  disabled={eng.calibration == null}
                  onClick={() => eng.setCalibration(null)}
                >
                  Clear
                </button>
              </div>
              {eng.calibration != null && (
                <p className="text-xs text-violet-300 mt-2">offset +{eng.calibration.toFixed(1)} dB</p>
              )}
            </div>

            <SaveCard eng={eng} onErr={setErr} />
          </div>
        </section>

        <aside className="rounded-lg border border-neutral-800 bg-neutral-900/60 flex flex-col min-h-[200px]">
          <h2 className="px-3 py-2 text-xs uppercase tracking-wider text-neutral-500 border-b border-neutral-800">
            Activity
          </h2>
          <div className="flex-1 min-h-0 overflow-y-auto font-mono text-[11px] leading-5 p-2">
            {eng.log.length === 0 && (
              <p className="text-neutral-600 font-sans">No events yet — start listening.</p>
            )}
            {[...eng.log].reverse().map((e) => (
              <LogLine key={e.seq} e={e} />
            ))}
          </div>
        </aside>
      </div>

      <ClipsSection eng={eng} onErr={setErr} />
    </div>
  )
}

const BTN =
  'rounded border px-3 py-1.5 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

function StatusDot({ state }: { state: 'idle' | 'listening' | 'recording' }) {
  const cls =
    state === 'recording'
      ? 'bg-red-500 animate-pulse'
      : state === 'listening'
        ? 'bg-emerald-500 animate-pulse'
        : 'bg-neutral-600'
  return (
    <span className="flex items-center gap-2">
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${cls}`} />
      <span className="text-xs uppercase tracking-wider text-neutral-400">{state}</span>
    </span>
  )
}

// ------------------------------------------------------------------ meter

function MeterCard(props: {
  eng: LiveSoundEngine
  mics: MicDevice[]
  micId: string
  onMic: (id: string) => void
  err: string | null
  onNameMics: () => void
  onStart: () => void
  onStop: () => void
}) {
  const { eng, mics, micId, onMic, err, onNameMics, onStart, onStop } = props
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = 640
    canvas.height = 144
    let raf = 0
    const loop = () => {
      drawMeter(canvas, eng)
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [eng])

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-xs uppercase tracking-wider text-neutral-500">Level</h2>
        <span className="text-xs text-neutral-500">
          {eng.calibration != null ? 'calibrated ≈ dB SPL' : 'raw dBFS'} · live readout on the trace
        </span>
      </div>
      <canvas ref={canvasRef} className="w-full h-36 rounded bg-neutral-950" />
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <select
          value={micId}
          onChange={(e) => onMic(e.target.value)}
          disabled={eng.state !== 'idle'}
          className="rounded bg-neutral-950 border border-neutral-800 px-2 py-1.5 text-xs text-neutral-200 outline-none focus:border-neutral-500 disabled:opacity-40 max-w-56"
        >
          <option value="">Default microphone</option>
          {mics.map((m) => (
            <option key={m.deviceId} value={m.deviceId}>
              {m.label}
            </option>
          ))}
        </select>
        <button
          className={BTN + ' text-neutral-400 border-neutral-700 hover:bg-neutral-800'}
          onClick={onNameMics}
          title="Grant mic access once so this browser can show real device names"
        >
          Name mics
        </button>
        {eng.state === 'idle' ? (
          <button className={BTN + ' text-emerald-300 border-emerald-800 hover:bg-emerald-950'} onClick={onStart}>
            Start listening
          </button>
        ) : (
          <button className={BTN + ' text-red-300 border-red-800 hover:bg-red-950'} onClick={onStop}>
            Stop
          </button>
        )}
      </div>
      {mics.length === 0 && (
        <p className="mt-2 text-xs text-neutral-500">
          No named microphones yet — &ldquo;Default microphone&rdquo; still works. Click
          &ldquo;Name mics&rdquo; to let the browser list them by name.
        </p>
      )}
      {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
    </div>
  )
}

function drawMeter(canvas: HTMLCanvasElement, eng: LiveSoundEngine): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  const y = (db: number) => {
    const c = Math.min(METER_MAX, Math.max(METER_MIN, db))
    return h - ((c - METER_MIN) / (METER_MAX - METER_MIN)) * h
  }

  ctx.font = '10px ui-monospace, monospace'
  ctx.textBaseline = 'bottom'
  for (let db = METER_MIN; db <= METER_MAX; db += 10) {
    const yy = y(db)
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'
    ctx.beginPath()
    ctx.moveTo(0, yy)
    ctx.lineTo(w, yy)
    ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.fillText(String(db), 4, yy - 2)
  }

  if (eng.config.gated) {
    markerLine(ctx, w, y(eng.config.stopDb), '#38bdf8', 'stop')
    markerLine(ctx, w, y(eng.config.triggerDb), '#f59e0b', 'trigger')
  }

  const hist = eng.history
  if (hist.length > 1) {
    ctx.strokeStyle = eng.state === 'recording' ? '#f87171' : '#4ade80'
    ctx.fillStyle = ctx.strokeStyle
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < hist.length; i++) {
      const x = (i / (HISTORY_LEN - 1)) * w
      const yy = y(hist[i])
      if (i === 0) ctx.moveTo(x, yy)
      else ctx.lineTo(x, yy)
    }
    ctx.stroke()
    const x = ((hist.length - 1) / (HISTORY_LEN - 1)) * w
    ctx.beginPath()
    ctx.arc(x, y(eng.levelDb), 3, 0, Math.PI * 2)
    ctx.fill()
  }

  // Big live readout — redrawn every frame, so it actually moves.
  ctx.font = '16px ui-monospace, monospace'
  ctx.textBaseline = 'top'
  const unit = eng.calibration != null ? ' dB ≈SPL' : ' dBFS'
  const reading = eng.state === 'idle' ? '—' : eng.displayDb.toFixed(1) + unit
  const tw = ctx.measureText(reading).width
  ctx.fillStyle = 'rgba(10,10,10,0.72)'
  ctx.fillRect(4, 2, tw + 12, 23)
  ctx.fillStyle = '#e5e5e5'
  ctx.fillText(reading, 8, 6)

  if (eng.state !== 'idle') {
    const rec = eng.state === 'recording'
    const badge = rec ? '● REC' : '● LIVE'
    ctx.fillStyle = rec ? '#f87171' : '#4ade80'
    ctx.fillText(badge, w - ctx.measureText(badge).width - 8, 6)
  }

  // If the trace is pinned to the bottom edge, the mic is probably not the
  // one being spoken into (or it's muted). Say so instead of looking dead.
  if (eng.state !== 'idle' && eng.levelDb < METER_MIN) {
    ctx.font = '11px ui-monospace, monospace'
    ctx.fillStyle = '#fbbf24'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(
      'no signal — is the selected mic the one you are speaking into (and not muted)?',
      8,
      h - 8,
    )
  }
}

function markerLine(ctx: CanvasRenderingContext2D, w: number, yy: number, color: string, label: string): void {
  ctx.strokeStyle = color
  ctx.globalAlpha = 0.8
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(0, yy)
  ctx.lineTo(w, yy)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.globalAlpha = 1
  ctx.fillStyle = color
  ctx.fillText(label, w - ctx.measureText(label).width - 4, yy - 2)
}

// ------------------------------------------------------------------ cards

function Field(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <label className="text-xs">
      <span className="block text-neutral-500 mb-1">{props.label}</span>
      <input
        type="number"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) props.onChange(v)
        }}
        className="w-full rounded bg-neutral-950 border border-neutral-800 px-2 py-1 text-neutral-200 outline-none focus:border-neutral-500"
      />
    </label>
  )
}

function SaveCard({ eng, onErr }: { eng: LiveSoundEngine; onErr: (m: string | null) => void }) {
  const unsaved = eng.clips.filter((c) => !c.saved).length
  const run = (fn: () => Promise<void>) =>
    fn().catch((e) => onErr(errMsg(e)))
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
      <h2 className="text-xs uppercase tracking-wider text-neutral-500 mb-1">Save destination</h2>
      {!eng.fsSupported ? (
        <p className="text-xs text-amber-400 leading-4">
          This browser can&rsquo;t write to folders — download clips individually below.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <button className={BTN + ' text-sky-300 border-sky-800 hover:bg-sky-950'} onClick={() => run(() => eng.chooseFolder())}>
              Choose folder…
            </button>
            {!eng.folder && eng.pendingFolderName && (
              <button
                className={BTN + ' text-amber-300 border-amber-800 hover:bg-amber-950'}
                onClick={() => run(() => eng.reconnectFolder())}
                title="This folder was chosen in a previous visit — click to re-allow access"
              >
                Reconnect &ldquo;{eng.pendingFolderName}&rdquo;
              </button>
            )}
            <button
              className={BTN + ' text-neutral-300 border-neutral-700 hover:bg-neutral-800'}
              disabled={!eng.folder || unsaved === 0}
              onClick={() => run(() => eng.saveAllClips())}
            >
              Save clips ({unsaved})
            </button>
            <button
              className={BTN + ' text-neutral-300 border-neutral-700 hover:bg-neutral-800'}
              disabled={!eng.folder || eng.log.length === 0}
              onClick={() => run(() => eng.saveEventLog())}
            >
              Event log
            </button>
          </div>
          {eng.folderName && (
            <p className="text-xs text-emerald-400 mt-2 truncate">
              → {eng.folderName} — clips auto-save here the moment they finish
            </p>
          )}
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------------- log

const BADGE: Record<LogEvent['type'], string> = {
  'monitor-start': 'text-emerald-400',
  'monitor-stop': 'text-neutral-500',
  trigger: 'text-amber-400',
  stop: 'text-sky-400',
  config: 'text-violet-400',
  calibration: 'text-violet-400',
  folder: 'text-blue-400',
  error: 'text-red-400',
}

function LogLine({ e }: { e: LogEvent }) {
  return (
    <div className="whitespace-pre-wrap">
      <span className="text-neutral-600">{timeStr(e.ts)}</span>{' '}
      <span className={`uppercase tracking-wide ${BADGE[e.type]}`}>{e.type}</span>{' '}
      <span className="text-neutral-300">{e.message}</span>
    </div>
  )
}

function timeStr(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

// ------------------------------------------------------------------ clips

function ClipsSection({ eng, onErr }: { eng: LiveSoundEngine; onErr: (m: string | null) => void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [, setTick] = useState(0)

  // The in-progress clip only appears in the list once it finishes (a full
  // 60 s in continuous mode) — tick at 2 Hz while recording so the progress
  // row above it stays honest.
  useEffect(() => {
    if (eng.state !== 'recording') return
    const id = setInterval(() => setTick((t) => t + 1), 500)
    return () => clearInterval(id)
  }, [eng.state])

  useEffect(() => {
    const a = audioRef.current
    if (a) a.onended = () => setPlayingId(null)
  })

  const toggle = (clip: Clip) => {
    let a = audioRef.current
    if (!a) {
      a = new Audio()
      a.onended = () => setPlayingId(null)
      audioRef.current = a
    }
    if (playingId === clip.id) {
      a.pause()
      setPlayingId(null)
      return
    }
    onErr(null)
    a.src = clip.url
    a.play().catch(() => onErr('Playback was blocked by the browser.'))
    setPlayingId(clip.id)
  }

  return (
    <section className="border-t border-neutral-800 max-h-60 overflow-y-auto">
      <h2 className="px-3 py-2 text-xs uppercase tracking-wider text-neutral-500 sticky top-0 bg-neutral-950">
        Clips ({eng.clips.length})
      </h2>
      {eng.clips.length === 0 && !eng.activeClip && (
        <p className="px-3 pb-3 text-xs text-neutral-600">
          {eng.config.gated
            ? 'No clips yet. Loud moments above the trigger level land here, newest first.'
            : 'No finished clips yet — the current one is above (or starts when monitoring begins).'}
        </p>
      )}
      {eng.activeClip && (
        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-neutral-900 text-xs bg-red-950/20">
          <span className="text-red-400 animate-pulse">● REC</span>
          <span className="font-mono text-neutral-200">
            recording — file saves automatically when it finishes
          </span>
          <span className="ml-auto text-neutral-400 tabular-nums whitespace-nowrap">
            {clock(eng.activeClip.ageSec)} / {clock(eng.config.maxClipSec)}
          </span>
        </div>
      )}
      {[...eng.clips].reverse().map((c) => (
        <div key={c.id} className="flex items-center gap-3 px-3 py-1.5 border-b border-neutral-900 text-xs">
          <button
            className={BTN + (playingId === c.id ? ' text-amber-300 border-amber-700' : ' text-neutral-300 border-neutral-700 hover:bg-neutral-800')}
            onClick={() => toggle(c)}
          >
            {playingId === c.id ? 'Pause' : 'Play'}
          </button>
          <span className="font-mono text-neutral-200 truncate">{c.name}</span>
          <span className="text-neutral-500 tabular-nums whitespace-nowrap">
            {timeStr(c.startTs)} · {c.fileSec.toFixed(1)} s · peak {c.peakDb.toFixed(1)} dBFS
          </span>
          <span className="ml-auto flex items-center gap-2">
            {c.saved ? (
              <span className="text-emerald-500" title="Written to the save folder">✓ saved</span>
            ) : (
              <span className="text-neutral-600" title="Still in memory only">in memory</span>
            )}
            <a
              href={c.url}
              download={c.name}
              className={BTN + ' text-sky-300 border-sky-800 hover:bg-sky-950'}
            >
              Download
            </a>
          </span>
        </div>
      ))}
    </section>
  )
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function micErrMsg(e: unknown): string {
  if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
    return 'Microphone access was denied — allow it in the browser bar and retry.'
  }
  if (e instanceof DOMException && e.name === 'NotFoundError') {
    return 'No microphone found for that selection.'
  }
  return e instanceof Error ? e.message : String(e)
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
