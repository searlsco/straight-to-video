// Single‑file ESM entry for importmap users.
// Pulls in all internal modules so apps can pin just `straight-to-video`.

// External deps remain peer/regular deps and should be pinned/available separately
// in importmap environments: `@hotwired/stimulus` and `mediabunny`.

// ----- External imports -----
import {
  Input, ALL_FORMATS, BlobSource, AudioBufferSink,
  Output, Mp4OutputFormat, BufferTarget,
  AudioSampleSource, AudioSample, EncodedVideoPacketSource, EncodedPacket
} from 'mediabunny'

// ----- Constants -----
const MAX_LONG_SIDE = 1920
const TARGET_AUDIO_BITRATE = 96_000
const TARGET_AUDIO_SR = 48_000
const TARGET_AUDIO_CHANNELS = 2

// ----- Video metadata probe -----
async function probeVideo (file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.muted = true
    v.src = url
    v.onloadedmetadata = () => {
      const width = v.videoWidth
      const height = v.videoHeight
      const duration = v.duration
      URL.revokeObjectURL(url)
      resolve({ width, height, duration })
    }
    v.onerror = () => { URL.revokeObjectURL(url); reject(v.error || new Error('failed to load metadata')) }
  })
}

// ----- Audio helpers -----
async function decodeAudioPCM (file, { duration }) {
  const totalFrames = Math.max(1, Math.ceil(Number(duration) * TARGET_AUDIO_SR))
  const tracks = await (async () => {
    try {
      const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
      return await input.getTracks()
    } catch (_) {
      return []
    }
  })()
  const audio = tracks.find(t => typeof t.isAudioTrack === 'function' && t.isAudioTrack())
  if (!audio) return new AudioBuffer({ length: totalFrames, sampleRate: TARGET_AUDIO_SR, numberOfChannels: TARGET_AUDIO_CHANNELS })

  const ctx = new OfflineAudioContext({ numberOfChannels: TARGET_AUDIO_CHANNELS, length: totalFrames, sampleRate: TARGET_AUDIO_SR })
  const sink = new AudioBufferSink(audio)
  for await (const { buffer, timestamp } of sink.buffers(0, Number(duration))) {
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    src.start(Math.max(0, Number(timestamp)))
  }
  return await ctx.startRendering()
}

async function renderStereo48kExact (buffer, exactFrames) {
  const frames = Math.max(1024, Number(exactFrames))
  const ctx = new OfflineAudioContext({ numberOfChannels: TARGET_AUDIO_CHANNELS, length: frames, sampleRate: TARGET_AUDIO_SR })
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.connect(ctx.destination)
  src.start(0)
  return await ctx.startRendering()
}

function interleaveStereoF32 (buffer) {
  const len = buffer.length
  const out = new Float32Array(len * TARGET_AUDIO_CHANNELS)
  const ch0 = buffer.getChannelData(0)
  const ch1 = buffer.getChannelData(1)
  for (let i = 0, j = 0; i < len; i++, j += 2) {
    out[j] = ch0[i]
    out[j + 1] = ch1[i]
  }
  return out
}

// ----- Video pipeline -----
async function canOptimizeVideo (file) {
  if (!(file instanceof File)) return { ok: false, reason: 'not-a-file', details: {} }
  const env = typeof window !== 'undefined'
    && 'VideoEncoder' in window
    && 'OfflineAudioContext' in window
    && typeof document?.createElement === 'function'
  if (!env) return { ok: false, reason: 'unsupported-environment', details: {} }
  try {
    const { width, height, duration } = await probeVideo(file)
    const long = Math.max(width, height)
    const scale = Math.min(1, MAX_LONG_SIDE / Math.max(2, long))
    const targetWidth = Math.max(2, Math.round(width * scale))
    const targetHeight = Math.max(2, Math.round(height * scale))
    const fps = Math.max(width, height) <= 1920 ? 30 : 60
    const sup = await selectVideoEncoderConfig({ width: targetWidth, height: targetHeight, fps }).then(() => true).catch(() => false)
    if (!sup) return { ok: false, reason: 'unsupported-video-config', details: { width, height } }

    // Header sniffing when file.type is empty/incorrect
    const type = String(file.type || '').toLowerCase()
    if (!type) {
      const blob = file.slice(0, 4096)
      const buf = new Uint8Array(await blob.arrayBuffer())
      const asAscii = (u8) => String.fromCharCode(...u8)
      // MP4/MOV ftyp signature typically at offset 4..
      const ascii = asAscii(buf)
      const hasFtyp = ascii.includes('ftyp')
      // WebM/Matroska: EBML header 1A 45 DF A3
      const hasEbml = buf.length >= 4 && buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3
      if (!(hasFtyp || hasEbml)) return { ok: false, reason: 'unknown-container', details: {} }
    }
    const mbPerSec = 0.366
    if ((duration * mbPerSec) > 300 /* ~300MB budget */) return { ok: false, reason: 'too-long', details: { duration } }
    return { ok: true, reason: 'ok', details: { width, height, duration } }
  } catch (e) {
    return { ok: false, reason: 'probe-failed', details: { error: String(e?.message || e) } }
  }
}

async function optimizeVideo (file, { onProgress } = {}) {
  if (!(file instanceof File)) return { changed: false, file }
  const type = file.type || ''
  if (!/^video\//i.test(type)) return { changed: false, file }
  if (typeof window === 'undefined' || !('VideoEncoder' in window)) return { changed: false, file }
  const feas = await canOptimizeVideo(file)
  if (!feas.ok) return { changed: false, file }

  const srcMeta = await probeVideo(file)
  const newFile = await encodeVideo({ file, srcMeta: { w: srcMeta.width, h: srcMeta.height, duration: srcMeta.duration }, onProgress })
  return { changed: true, file: newFile }
}

async function selectVideoEncoderConfig ({ width, height, fps }) {
  const hevc = { codec: 'hvc1.1.4.L123.B0', width, height, framerate: fps, hardwareAcceleration: 'prefer-hardware', hevc: { format: 'hevc' } }
  const supH = await VideoEncoder.isConfigSupported(hevc).catch(() => ({ supported: false }))
  if (supH.supported) return { codecId: 'hevc', config: supH.config }

  const avc = { codec: 'avc1.64002A', width, height, framerate: fps, hardwareAcceleration: 'prefer-hardware', avc: { format: 'avc' } }
  const supA = await VideoEncoder.isConfigSupported(avc)
  return { codecId: 'avc', config: supA.config }
}

async function waitForFrameReady (video, budgetMs) {
  if (typeof video.requestVideoFrameCallback !== 'function') return false
  return await new Promise((resolve) => {
    let settled = false
    const to = setTimeout(() => { if (!settled) { settled = true; resolve(false) } }, Math.max(1, budgetMs || 17))
    video.requestVideoFrameCallback(() => { if (!settled) { settled = true; clearTimeout(to); resolve(true) } })
  })
}

async function encodeVideo ({ file, srcMeta, onProgress }) {
  const w = srcMeta.w
  const h = srcMeta.h
  const durationCfr = Number(srcMeta.duration)
  const long = Math.max(w, h)
  const scale = Math.min(1, MAX_LONG_SIDE / Math.max(2, long))
  const targetWidth = Math.max(2, Math.round(w * scale))
  const targetHeight = Math.max(2, Math.round(h * scale))

  const targetFps = Math.max(w, h) <= 1920 ? 30 : 60
  const step = 1 / Math.max(1, targetFps)
  const frames = Math.max(1, Math.floor(durationCfr / step))

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })
  const { codecId, config: usedCfg } = await selectVideoEncoderConfig({ width: targetWidth, height: targetHeight, fps: targetFps })
  const videoTrack = new EncodedVideoPacketSource(codecId)
  output.addVideoTrack(videoTrack, { frameRate: targetFps })

  const _warn = console.warn
  console.warn = (...args) => {
    const m = args && args[0]
    if (typeof m === 'string' && m.includes('Unsupported audio codec') && m.includes('apac')) return
    _warn.apply(console, args)
  }
  const audioBuffer = await decodeAudioPCM(file, { duration: durationCfr })
  console.warn = _warn

  const audioSource = new AudioSampleSource({
    codec: 'aac',
    bitrate: TARGET_AUDIO_BITRATE,
    bitrateMode: 'constant',
    numberOfChannels: TARGET_AUDIO_CHANNELS,
    sampleRate: TARGET_AUDIO_SR,
    onEncodedPacket: (_packet, meta) => {
      const aot = 2; const idx = 3; const b0 = (aot << 3) | (idx >> 1); const b1 = ((idx & 1) << 7) | (TARGET_AUDIO_CHANNELS << 3)
      meta.decoderConfig = { codec: 'mp4a.40.2', numberOfChannels: TARGET_AUDIO_CHANNELS, sampleRate: TARGET_AUDIO_SR, description: new Uint8Array([b0, b1]) }
    }
  })
  output.addAudioTrack(audioSource)

  await output.start()

  let codecDesc = null
  const pendingPackets = []
  const ve = new VideoEncoder({
    output: (chunk, meta) => {
      if (!codecDesc && meta?.decoderConfig?.description) codecDesc = meta.decoderConfig.description
      pendingPackets.push({ chunk })
    },
    error: () => {}
  })
  ve.configure(usedCfg)

  const url = URL.createObjectURL(file)
  const v = document.createElement('video')
  v.muted = true; v.preload = 'auto'; v.playsInline = true
  v.src = url
  await new Promise((resolve, reject) => { v.onloadedmetadata = resolve; v.onerror = () => reject(new Error('video load failed')) })
  const canvas = document.createElement('canvas'); canvas.width = targetWidth; canvas.height = targetHeight
  const ctx = canvas.getContext('2d', { alpha: false })

  for (let i = 0; i < frames; i++) {
    const t = i * step
    const targetTime = Math.min(Math.max(0, t), Math.max(0.000001, durationCfr - 0.000001))
    const drawTime = i === 0
      ? Math.min(Math.max(0, t + (step * 0.5)), Math.max(0.000001, durationCfr - 0.000001))
      : targetTime

    await new Promise((resolve) => { v.currentTime = drawTime; v.onseeked = () => resolve() })
    const budgetMs = Math.min(34, Math.max(17, Math.round(step * 1000)))
    const presented = await waitForFrameReady(v, budgetMs)
    if (!presented && i === 0) {
      const nudge = Math.min(step * 0.25, 0.004)
      await new Promise((resolve) => { v.currentTime = Math.min(drawTime + nudge, Math.max(0.000001, durationCfr - 0.000001)); v.onseeked = () => resolve() })
    }

    ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
    const vf = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(step * 1e6) })
    ve.encode(vf, { keyFrame: i === 0 })
    vf.close()

    if (typeof onProgress === 'function') {
      try { onProgress(Math.min(1, (i + 1) / frames)) } catch (_) {}
    }
  }
  await ve.flush()
  URL.revokeObjectURL(url)

  const muxCount = Math.min(frames, pendingPackets.length)

  for (let i = 0; i < muxCount; i++) {
    const { chunk } = pendingPackets[i]
    const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data)
    const ts = i * step; const dur = step
    const pkt = new EncodedPacket(data, chunk.type === 'key' ? 'key' : 'delta', ts, dur)
    await videoTrack.add(pkt, { decoderConfig: { codec: usedCfg.codec, codedWidth: targetWidth, codedHeight: targetHeight, description: codecDesc } })
  }

  const samplesPerVideoFrame = TARGET_AUDIO_SR / targetFps
  const totalVideoSamples = muxCount * samplesPerVideoFrame
  const targetSamples = Math.max(1024, Math.floor(totalVideoSamples / 1024) * 1024 - 2048)
  const audioExact = await renderStereo48kExact(audioBuffer, targetSamples)
  const interleaved = interleaveStereoF32(audioExact)
  const sample = new AudioSample({ format: 'f32', sampleRate: TARGET_AUDIO_SR, numberOfChannels: TARGET_AUDIO_CHANNELS, timestamp: 0, data: interleaved })
  await audioSource.add(sample)
  audioSource.close()

  await output.finalize()
  const { buffer } = output.target
  const payload = new Uint8Array(buffer)
  const nm = file.name; const dot = nm.lastIndexOf('.')
  const newName = `${nm.substring(0, dot)}-optimized.mp4`
  return new File([payload], newName, { type: 'video/mp4', lastModified: Date.now() })
}

// ----- Controller registration (optional) -----
function registerStraightToVideoController (app, opts = {}) {
  const { Controller, name = 'straight-to-video' } = opts || {}
  if (!Controller) {
    throw new Error('registerStraightToVideoController requires a Controller class from @hotwired/stimulus. Call as registerStraightToVideoController(app, { Controller, name? }).')
  }

  class StraightToVideoController extends Controller {
    static get targets () { return ['fileInput'] }
    static get values () { return { submitting: Boolean } }

    connect () {
      this._onWindowSubmitCapture = (e) => this._onWindowSubmitCaptureHandler(e)
      window.addEventListener('submit', this._onWindowSubmitCapture, { capture: true })
    }

    disconnect () {
      if (this._onWindowSubmitCapture) window.removeEventListener('submit', this._onWindowSubmitCapture, { capture: true })
    }

    async change (e) {
      const fileInput = e.target
      if (!fileInput?.files?.length || this.submittingValue || this._hasFlag(fileInput, 'processing')) return
      this._unmarkFlag(fileInput, 'processed')
      delete fileInput.dataset.summary
      await this._processFileInput(fileInput)
    }

    async _onWindowSubmitCaptureHandler (e) {
      if (e.target !== this.element) return
      const toProcess = this.fileInputTargets.filter((fi) => fi?.files?.length && !this._hasFlag(fi, 'processed'))
      if (toProcess.length === 0) return

      e.preventDefault()
      e.stopPropagation()
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation()

      this.submittingValue = true
      await Promise.allSettled(toProcess.map((fi) => this._processFileInput(fi)))
      this.submittingValue = false
      this._resubmit(e.submitter)
    }

    _swapFile (input, newFile) {
      const dt = new DataTransfer()
      dt.items.add(newFile)
      input.files = dt.files
    }

    _hasFlag (input, flag) { return input.dataset[flag] === '1' }
    _markFlag (input, flag) { input.dataset[flag] = '1' }
    _unmarkFlag (input, flag) { delete input.dataset[flag] }

    submittingValueChanged () {
      const controls = this.element.querySelectorAll('input, select, textarea, button')
      controls.forEach(el => { el.disabled = this.submittingValue })
    }

    async _processFileInput (fileInput) {
      this._markFlag(fileInput, 'processing')
      fileInput.disabled = true
      try {
        const original = fileInput.files[0]
        const { changed, file } = await optimizeVideo(original, {
          onProgress: (ratio) => this._fire(fileInput, 'progress', { progress: Math.round(ratio * 100) })
        })
        if (changed) this._swapFile(fileInput, file)
        this._markFlag(fileInput, 'processed')
        this._fire(fileInput, 'done', { changed })
      } catch (err) {
        console.error(err)
        this._markFlag(fileInput, 'processed')
        this._fire(fileInput, 'error', { error: err })
      } finally {
        fileInput.disabled = false
        this._unmarkFlag(fileInput, 'processing')
      }
    }

    _fire (el, name, detail = {}) {
      el.dispatchEvent(new CustomEvent(`straight-to-video:${name}`, { bubbles: true, cancelable: true, detail }))
    }

    _resubmit (submitter) {
      setTimeout(() => { submitter ? this.element.requestSubmit(submitter) : this.element.requestSubmit() }, 0)
    }
  }

  app.register(name, StraightToVideoController)
  return StraightToVideoController
}

// Public API
export { canOptimizeVideo, optimizeVideo, registerStraightToVideoController}
