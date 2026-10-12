// Minimal 16-bit PCM WAV encoder. No dependencies — the standard 44-byte
// RIFF header plus straight sample packing. WAV (not webm) on purpose:
// it plays everywhere, in every player and on every phone, which is what
// you want when the file is going to a landlord.

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytes = 44 + samples.length * 2
  const buf = new ArrayBuffer(bytes)
  const v = new DataView(buf)

  writeStr(v, 0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  writeStr(v, 8, 'WAVE')
  writeStr(v, 12, 'fmt ')
  v.setUint32(16, 16, true) // fmt chunk size
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true) // byte rate
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  writeStr(v, 36, 'data')
  v.setUint32(40, samples.length * 2, true)

  let o = 44
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }

  return new Blob([buf], { type: 'audio/wav' })
}

function writeStr(v: DataView, off: number, s: string): void {
  for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
}
