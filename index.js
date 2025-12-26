// straight-to-video - https://github.com/searlsco/straight-to-video

// ----- External imports -----
import {
  Input, ALL_FORMATS, BlobSource, AudioBufferSink,
  Output, Mp4OutputFormat, BufferTarget,
  AudioSampleSource, AudioSample, EncodedVideoPacketSource, EncodedPacket, EncodedPacketSink, VideoSampleSink
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

async function estimateSourceVideoFps (file) {
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
    const tracks = await input.getTracks()
    const video = tracks.find(t => typeof t.isVideoTrack === 'function' && t.isVideoTrack())
    if (!video) return 0
    const sink = new EncodedPacketSink(video)
    const durations = []
    for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
      const dur = Number(packet?.duration)
      if (packet.timestamp >= 0 && Number.isFinite(dur) && dur > 0) durations.push(dur)
      if (durations.length >= 120) break
    }
    if (!durations.length) return 0
    durations.sort((a, b) => a - b)
    const dur = durations[Math.floor(durations.length / 2)]
    return Number.isFinite(dur) && dur > 0 ? (1 / dur) : 0
  } catch (_) {
    return 0
  }
}

async function determineTargetFps (file, { width, height }) {
  const maxFps = Math.max(width, height) <= 1920 ? 30 : 60
  if (maxFps === 30) return 30

  const fps = await estimateSourceVideoFps(file)
  return fps >= 45 ? 60 : 30
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
  if (!(file instanceof File)) return { ok: false, reason: 'not-a-file', message: 'Argument provided is not a File.' }
  const env = typeof window !== 'undefined'
    && 'VideoEncoder' in window
    && 'OfflineAudioContext' in window
    && typeof document?.createElement === 'function'
  if (!env) return { ok: false, reason: 'unsupported-environment', message: 'Browser does not support WebCodecs or OfflineAudioContext.' }
  try {
    const { width, height, duration } = await probeVideo(file)
    const long = Math.max(width, height)
    const scale = Math.min(1, MAX_LONG_SIDE / Math.max(2, long))
    const targetWidth = Math.max(2, Math.round(width * scale))
    const targetHeight = Math.max(2, Math.round(height * scale))
    const fps = await determineTargetFps(file, { width, height })
    const sup = await selectVideoEncoderConfig({ width: targetWidth, height: targetHeight, fps }).then(() => true).catch(() => false)
    if (!sup) return { ok: false, reason: 'unsupported-video-config', message: 'No supported encoder configuration for this resolution on this device.' }

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
      if (!(hasFtyp || hasEbml)) return { ok: false, reason: 'unknown-container', message: 'Unrecognized container; expected MP4/MOV or WebM.' }
    }
    return { ok: true, reason: 'ok', message: 'ok', plan: { width: targetWidth, height: targetHeight, fps } }
  } catch (e) {
    return { ok: false, reason: 'probe-failed', message: String(e?.message || e) }
  }
}

async function optimizeVideo (file, { onProgress } = {}) {
  if (!(file instanceof File)) return { changed: false, file }
  const type = file.type || ''
  if (type && !/^video\//i.test(type)) return { changed: false, file }
  if (typeof window === 'undefined' || !('VideoEncoder' in window)) return { changed: false, file }
  const feas = await canOptimizeVideo(file)
  if (!feas.ok) return { changed: false, file }

  const srcMeta = await probeVideo(file)
  const newFile = await encodeVideo({ file, srcMeta: { w: srcMeta.width, h: srcMeta.height, duration: srcMeta.duration }, plan: feas.plan, onProgress })
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

async function encodeVideo ({ file, srcMeta, plan, onProgress }) {
  const w = srcMeta.w
  const h = srcMeta.h
  const durationCfr = Number(srcMeta.duration)
  const long = Math.max(w, h)
  const scale = Math.min(1, MAX_LONG_SIDE / Math.max(2, long))
  const targetWidth = Math.max(2, Number(plan?.width) || Math.round(w * scale))
  const targetHeight = Math.max(2, Number(plan?.height) || Math.round(h * scale))

  const targetFps = Math.max(1, Number(plan?.fps) || await determineTargetFps(file, { width: w, height: h }))
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

  const canvas = document.createElement('canvas'); canvas.width = targetWidth; canvas.height = targetHeight
  const ctx = canvas.getContext('2d', { alpha: false })

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  const tracks = await input.getTracks()
  const video = tracks.find(t => typeof t.isVideoTrack === 'function' && t.isVideoTrack())
  if (!video || !(await video.canDecode())) throw new Error('video track is not decodable by this browser')
  const sink = new VideoSampleSink(video)
  const draw = (sample) => {
    if (ctx.resetTransform) ctx.resetTransform()
    else ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    sample.drawWithFit(ctx, { fit: 'fill' })
  }

  let i = 0
  let prev = null
  let prevStart = 0

  for await (const sample of sink.samples(0, durationCfr + step)) {
    const ts = Math.max(0, Number(sample.timestamp))
    if (!prev) { prev = sample; prevStart = ts; continue }

    const end = Math.max(prevStart, ts)
    const displayTime = (i + 0.5) * step
    if (displayTime < end) {
      draw(prev)
      while (i < frames) {
        const displayTime = (i + 0.5) * step
        if (displayTime < prevStart || displayTime >= end) break
        const t = i * step
        const vf = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(step * 1e6) })
        ve.encode(vf, { keyFrame: i === 0 })
        vf.close()

        if (typeof onProgress === 'function') {
          try {
            onProgress(Math.min(1, (i + 1) / frames))
          } catch (err) {
            console.warn('straight-to-video: onProgress callback threw; ignoring error', err)
          }
        }

        i++
      }
    }

    if (typeof prev.close === 'function') prev.close()
    prev = sample
    prevStart = ts
    if (i >= frames) break
  }

  if (prev) {
    draw(prev)
    while (i < frames) {
      const t = i * step
      const vf = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(step * 1e6) })
      ve.encode(vf, { keyFrame: i === 0 })
      vf.close()
      i++
    }
    if (typeof prev.close === 'function') prev.close()
  }
  await ve.flush()

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
      if (!this._pendingProcesses) this._pendingProcesses = new WeakMap()
      const existing = this._pendingProcesses.get(fileInput)
      if (existing) return existing

      const job = (async () => {
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
      })()

      this._pendingProcesses.set(fileInput, job)
      job.finally(() => {
        if (this._pendingProcesses?.get(fileInput) === job) this._pendingProcesses.delete(fileInput)
      })
      return job
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
