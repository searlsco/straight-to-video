// straight-to-video@0.0.12 vendored by the straight_to_video gem
// straight-to-video - https://github.com/searlsco/straight-to-video

// ----- External imports -----
import {
  Input, ALL_FORMATS, BlobSource, AudioBufferSink,
  Output, Mp4OutputFormat, BufferTarget,
  AudioSampleSource, AudioSample, EncodedVideoPacketSource, EncodedPacket, EncodedPacketSink, VideoSampleSink,
  EncodedAudioPacketSource
} from 'mediabunny'

// ----- Constants -----
const MAX_LONG_SIDE = 1920
const TARGET_VIDEO_BITRATE = 12_000_000
const TARGET_AUDIO_BITRATE = 96_000
const TARGET_AUDIO_SR = 48_000
const TARGET_AUDIO_CHANNELS = 2
const MAX_VIDEO_ENCODER_QUEUE_SIZE = 4

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

async function estimateSourceVideoStats (file) {
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
    const tracks = await input.getTracks()
    const video = tracks.find(t => typeof t.isVideoTrack === 'function' && t.isVideoTrack())
    if (!video) return { fps: 0, bitrate: 0, codec: null, rotation: 0 }
    const sink = new EncodedPacketSink(video)
    const durations = []
    let firstTimestamp = Infinity
    let lastTimestamp = -Infinity
    let totalBytes = 0
    for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
      const duration = Number(packet?.duration)
      if (packet.timestamp >= 0 && Number.isFinite(duration) && duration > 0) {
        durations.push(duration)
        firstTimestamp = Math.min(firstTimestamp, packet.timestamp)
        lastTimestamp = Math.max(lastTimestamp, packet.timestamp + duration)
        totalBytes += packet.byteLength
      }
      if (durations.length >= 120) break
    }
    if (!durations.length) return { fps: 0, bitrate: 0, codec: video.codec, rotation: video.rotation }
    durations.sort((a, b) => a - b)
    const duration = durations[Math.floor(durations.length / 2)]
    const sampledDuration = lastTimestamp - firstTimestamp
    return {
      fps: Number.isFinite(duration) && duration > 0 ? (1 / duration) : 0,
      bitrate: sampledDuration > 0 ? (totalBytes * 8 / sampledDuration) : 0,
      codec: video.codec,
      rotation: video.rotation
    }
  } catch (_) {
    return { fps: 0, bitrate: 0, codec: null, rotation: 0 }
  }
}

async function determineEncodingPlan (file, { width, height, duration }) {
  const maxFps = Math.max(width, height) <= 1920 ? 30 : 60
  const source = await estimateSourceVideoStats(file)
  const copyVideo = ['avc', 'hevc'].includes(source.codec) &&
    source.rotation === 0 &&
    Math.max(width, height) <= MAX_LONG_SIDE &&
    source.fps >= 23 && source.fps <= 60.1 &&
    Number(duration) > 0 && (file.size * 8 / Number(duration)) <= TARGET_VIDEO_BITRATE
  return {
    fps: copyVideo ? source.fps : (maxFps === 30 ? 30 : (source.fps >= 45 ? 60 : 30)),
    bitrate: source.bitrate > 0 ? Math.min(TARGET_VIDEO_BITRATE, Math.round(source.bitrate)) : TARGET_VIDEO_BITRATE,
    copyVideo
  }
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
    const plan = await determineEncodingPlan(file, { width, height, duration })
    const sup = plan.copyVideo || await selectVideoEncoderConfig({ width: targetWidth, height: targetHeight, ...plan }).then(() => true).catch(() => false)
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
    return { ok: true, reason: 'ok', message: 'ok', plan: { width: targetWidth, height: targetHeight, ...plan } }
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

  if (feas.plan.copyVideo) {
    const fastStarted = await fastStartMp4(file)
    if (fastStarted) {
      if (typeof onProgress === 'function') onProgress(1)
      return { changed: true, file: fastStarted }
    }
  }

  const srcMeta = await probeVideo(file)
  const newFile = await encodeVideo({ file, srcMeta: { w: srcMeta.width, h: srcMeta.height, duration: srcMeta.duration }, plan: feas.plan, onProgress })
  return { changed: true, file: newFile }
}

async function selectVideoEncoderConfig ({ width, height, fps, bitrate = TARGET_VIDEO_BITRATE }) {
  const hevc = { codec: 'hvc1.1.4.L123.B0', width, height, framerate: fps, bitrate, hardwareAcceleration: 'prefer-hardware', hevc: { format: 'hevc' } }
  const supH = await VideoEncoder.isConfigSupported(hevc).catch(() => ({ supported: false }))
  if (supH.supported) return { codecId: 'hevc', config: supH.config }

  const avc = { codec: 'avc1.64002A', width, height, framerate: fps, bitrate, hardwareAcceleration: 'prefer-hardware', avc: { format: 'avc' } }
  const supA = await VideoEncoder.isConfigSupported(avc)
  return { codecId: 'avc', config: supA.config }
}

function shouldDecodeViaVideoElement () {
  return (navigator?.vendor || '').includes('Apple')
}

async function applyVideoEncoderBackpressure (encoder) {
  while (encoder.encodeQueueSize > MAX_VIDEO_ENCODER_QUEUE_SIZE) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

async function waitForFrameReady (video, budgetMs) {
  if (typeof video.requestVideoFrameCallback !== 'function') return false
  return await new Promise((resolve) => {
    let settled = false
    const to = setTimeout(() => { if (!settled) { settled = true; resolve(false) } }, Math.max(1, budgetMs || 17))
    video.requestVideoFrameCallback(() => { if (!settled) { settled = true; clearTimeout(to); resolve(true) } })
  })
}

async function seekOnce (video, time) {
  if (!video) return
  const t = Number.isFinite(time) ? time : 0
  if (Math.abs(video.currentTime - t) < 1e-6) return
  await new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked)
      resolve()
    }
    video.addEventListener('seeked', onSeeked, { once: true })
    video.currentTime = t
  })
}

async function encodeFramesViaVideoElement ({ file, durationCfr, step, frames, canvas, ctx, ve, onProgress }) {
  const url = URL.createObjectURL(file)
  const v = document.createElement('video')
  v.muted = true; v.preload = 'auto'; v.playsInline = true
  await new Promise((resolve, reject) => {
    const onLoaded = () => {
      v.removeEventListener('loadedmetadata', onLoaded)
      v.removeEventListener('error', onError)
      resolve()
    }
    const onError = () => {
      v.removeEventListener('loadedmetadata', onLoaded)
      v.removeEventListener('error', onError)
      reject(new Error('video load failed'))
    }
    v.addEventListener('loadedmetadata', onLoaded)
    v.addEventListener('error', onError)
    v.src = url
    try {
      v.load()
    } catch (err) {
      console.warn('straight-to-video: video.load() threw; continuing without explicit load()', err)
    }
  })

  for (let i = 0; i < frames; i++) {
    const t = i * step
    const drawTime = Math.min(Math.max(0, t + (step * 0.5)), Math.max(0.000001, durationCfr - 0.000001))
    await seekOnce(v, drawTime)
    const budgetMs = Math.min(34, Math.max(17, Math.round(step * 1000)))
    const presented = await waitForFrameReady(v, budgetMs)
    if (!presented && i === 0) {
      const nudge = Math.min(step * 0.25, 0.004)
      const target = Math.min(drawTime + nudge, Math.max(0.000001, durationCfr - 0.000001))
      await seekOnce(v, target)
    }

    ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
    const vf = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(step * 1e6) })
    ve.encode(vf, { keyFrame: i === 0 })
    vf.close()
    await applyVideoEncoderBackpressure(ve)

    if (typeof onProgress === 'function') {
      try {
        onProgress(Math.min(1, (i + 1) / frames))
      } catch (err) {
        console.warn('straight-to-video: onProgress callback threw; ignoring error', err)
      }
    }
  }

  URL.revokeObjectURL(url)
}

async function encodeFramesViaVideoSampleSink ({ file, durationCfr, step, frames, canvas, ctx, ve, onProgress }) {
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
        await applyVideoEncoderBackpressure(ve)

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
      await applyVideoEncoderBackpressure(ve)

      if (typeof onProgress === 'function') {
        try {
          onProgress(Math.min(1, (i + 1) / frames))
        } catch (err) {
          console.warn('straight-to-video: onProgress callback threw; ignoring error', err)
        }
      }

      i++
    }
    if (typeof prev.close === 'function') prev.close()
  }
}

// ----- MP4 moov rewriter -----
// Rebuilds the moov atom to match ffmpeg's conventions, fixing the Safari
// Tahoe controls auto-hide bug caused by mediabunny's non-standard moov.

function _concat (...parts) {
  let n = 0
  for (const p of parts) n += p.byteLength
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.byteLength }
  return out
}

function _u32 (v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); return b }
function _u16 (v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); return b }
function _ascii (s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b }

function _box (type, ...parts) {
  let n = 8; for (const p of parts) n += p.byteLength
  return _concat(_u32(n), _ascii(type), ...parts)
}

function _full (type, ver, flags, ...parts) {
  return _box(type, new Uint8Array([ver, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...parts)
}

function _matrix () {
  const m = new Uint8Array(36); const d = new DataView(m.buffer)
  d.setUint32(0, 0x00010000); d.setUint32(16, 0x00010000); d.setUint32(32, 0x40000000)
  return m
}

function _scanBoxes (u8, start, end) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const out = []; let pos = start
  while (pos + 8 <= end) {
    let sz = dv.getUint32(pos)
    const t = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7])
    if (sz === 1 && pos + 16 <= end) sz = dv.getUint32(pos + 8) * 0x100000000 + dv.getUint32(pos + 12)
    if (sz === 0) sz = end - pos
    if (sz < 8 || pos + sz > end) break
    out.push({ type: t, offset: pos, size: sz })
    pos += sz
  }
  return out
}

async function fastStartMp4 (file) {
  const u8 = new Uint8Array(await file.arrayBuffer())
  const boxes = _scanBoxes(u8, 0, u8.byteLength)
  const ftyp = boxes.find(b => b.type === 'ftyp')
  const mdat = boxes.find(b => b.type === 'mdat')
  const moov = boxes.find(b => b.type === 'moov')
  if (!ftyp || !mdat || !moov || ftyp.offset !== 0 || moov.offset < mdat.offset) return null

  const relocatedMoov = u8.slice(moov.offset, moov.offset + moov.size)
  const dv = new DataView(relocatedMoov.buffer, relocatedMoov.byteOffset, relocatedMoov.byteLength)
  for (let i = 0; i < relocatedMoov.byteLength - 16; i++) {
    if (relocatedMoov[i + 4] !== 0x73 || relocatedMoov[i + 5] !== 0x74 || relocatedMoov[i + 6] !== 0x63 || relocatedMoov[i + 7] !== 0x6f) continue
    const count = dv.getUint32(i + 12)
    if (i + 16 + count * 4 > relocatedMoov.byteLength) return null
    for (let j = 0; j < count; j++) {
      const offset = i + 16 + j * 4
      dv.setUint32(offset, dv.getUint32(offset) + moov.size)
    }
  }

  const payload = _concat(
    u8.slice(ftyp.offset, ftyp.offset + ftyp.size),
    relocatedMoov,
    ...boxes.filter(box => box !== ftyp && box !== moov).map(box => u8.slice(box.offset, box.offset + box.size))
  )
  const dot = file.name.lastIndexOf('.')
  return new File([payload], `${file.name.substring(0, dot)}-optimized.mp4`, { type: 'video/mp4', lastModified: Date.now() })
}

function _esdTag (tag, payload) {
  return _concat(new Uint8Array([tag, 0x80, 0x80, 0x80, payload.byteLength]), payload)
}

function _findAudioSpecificConfig (esdsBody) {
  for (let i = 0; i < esdsBody.length - 3; i++) {
    if (esdsBody[i] === 0x05) {
      let j = i + 1; while (j < esdsBody.length && esdsBody[j] === 0x80) j++
      if (j < esdsBody.length) {
        const len = esdsBody[j]; j++
        if (len >= 2 && j + len <= esdsBody.length) return esdsBody.slice(j, j + len)
      }
    }
  }
  return new Uint8Array([0x11, 0x90])
}

function _extractTrack (u8, dv, trakBox) {
  const kids = _scanBoxes(u8, trakBox.offset + 8, trakBox.offset + trakBox.size)
  const tkhdBox = kids.find(b => b.type === 'tkhd')
  const mdiaBox = kids.find(b => b.type === 'mdia')
  if (!tkhdBox || !mdiaBox) return null

  const to = tkhdBox.offset + 12
  const trackId = dv.getUint32(to + 8)
  const tkDur = dv.getUint32(to + 16)
  const tkW = dv.getUint32(to + 72)
  const tkH = dv.getUint32(to + 76)

  const mdiaKids = _scanBoxes(u8, mdiaBox.offset + 8, mdiaBox.offset + mdiaBox.size)
  const mdhdBox = mdiaKids.find(b => b.type === 'mdhd')
  const hdlrBox = mdiaKids.find(b => b.type === 'hdlr')
  const minfBox = mdiaKids.find(b => b.type === 'minf')
  if (!mdhdBox || !hdlrBox || !minfBox) return null

  const mo = mdhdBox.offset + 12
  const mdTs = dv.getUint32(mo + 8)
  const mdDur = dv.getUint32(mo + 12)
  const mdLang = dv.getUint16(mo + 16)

  const ho = hdlrBox.offset + 12
  const ht = String.fromCharCode(u8[ho + 4], u8[ho + 5], u8[ho + 6], u8[ho + 7])
  const isVideo = ht === 'vide'
  const isAudio = ht === 'soun'

  const minfKids = _scanBoxes(u8, minfBox.offset + 8, minfBox.offset + minfBox.size)
  const stblBox = minfKids.find(b => b.type === 'stbl')
  if (!stblBox) return null

  const stblKids = _scanBoxes(u8, stblBox.offset + 8, stblBox.offset + stblBox.size)
  const stsdBox = stblKids.find(b => b.type === 'stsd')
  const sttsBox = stblKids.find(b => b.type === 'stts')
  const stscBox = stblKids.find(b => b.type === 'stsc')
  const stszBox = stblKids.find(b => b.type === 'stsz')
  const stcoBox = stblKids.find(b => b.type === 'stco')
  const stssBox = stblKids.find(b => b.type === 'stss')
  if (!stsdBox || !sttsBox || !stscBox || !stszBox || !stcoBox) return null

  const sampleCount = dv.getUint32(stszBox.offset + 16)
  const stcoCount = dv.getUint32(stcoBox.offset + 12)
  const stcoEntries = []
  for (let i = 0; i < stcoCount; i++) stcoEntries.push(dv.getUint32(stcoBox.offset + 16 + i * 4))

  const sttsBody = u8.slice(sttsBox.offset + 12, sttsBox.offset + sttsBox.size)
  const stscBody = u8.slice(stscBox.offset + 12, stscBox.offset + stscBox.size)
  const stszBody = u8.slice(stszBox.offset + 12, stszBox.offset + stszBox.size)
  const stssBody = stssBox ? u8.slice(stssBox.offset + 12, stssBox.offset + stssBox.size) : null

  const entryOff = stsdBox.offset + 16
  const entrySize = dv.getUint32(entryOff)
  const codecTag = String.fromCharCode(u8[entryOff + 4], u8[entryOff + 5], u8[entryOff + 6], u8[entryOff + 7])

  let videoCodecConfig = null
  let audioSpecificConfig = null
  let audioChannels = 0, audioSampleSize = 0, audioSampleRate = 0

  if (isVideo) {
    const subs = _scanBoxes(u8, entryOff + 86, entryOff + entrySize)
    const cfg = subs.find(b => b.type === 'hvcC' || b.type === 'avcC')
    if (cfg) videoCodecConfig = u8.slice(cfg.offset, cfg.offset + cfg.size)
  }

  if (isAudio) {
    audioChannels = dv.getUint16(entryOff + 24)
    audioSampleSize = dv.getUint16(entryOff + 26)
    audioSampleRate = dv.getUint16(entryOff + 32)
    const subs = _scanBoxes(u8, entryOff + 36, entryOff + entrySize)
    const esdsBox = subs.find(b => b.type === 'esds')
    if (esdsBox) audioSpecificConfig = _findAudioSpecificConfig(u8.slice(esdsBox.offset + 12, esdsBox.offset + esdsBox.size))
  }

  let bitrate = 0
  const defSz = dv.getUint32(stszBox.offset + 12)
  let totalBytes = 0
  if (defSz > 0) { totalBytes = defSz * sampleCount }
  else { for (let i = 0; i < sampleCount; i++) totalBytes += dv.getUint32(stszBox.offset + 16 + i * 4) }
  const durSec = mdTs > 0 ? mdDur / mdTs : 0
  if (durSec > 0) bitrate = Math.round((totalBytes * 8) / durSec)

  return {
    isVideo, isAudio, trackId, codecTag,
    tkDur, tkW, tkH, mdTs, mdDur, mdLang,
    videoCodecConfig, audioSpecificConfig,
    audioChannels, audioSampleSize, audioSampleRate,
    sttsBody, stscBody, stszBody, stssBody,
    stcoEntries, sampleCount, bitrate
  }
}

function _buildStsd (t) {
  if (t.isVideo && t.videoCodecConfig) {
    const entry = _concat(
      new Uint8Array(6), _u16(1),
      new Uint8Array(16),
      _u16(t.tkW >>> 16), _u16(t.tkH >>> 16),
      _u32(0x00480000), _u32(0x00480000),
      _u32(0), _u16(1),
      new Uint8Array(32), _u16(0x0018), _u16(0xFFFF),
      t.videoCodecConfig,
      _box('btrt', _u32(0), _u32(t.bitrate), _u32(t.bitrate)))
    return _full('stsd', 0, 0, _u32(1), _box(t.codecTag, entry))
  }
  if (t.isAudio && t.audioSpecificConfig) {
    const decSpecInfo = _esdTag(0x05, t.audioSpecificConfig)
    const decConfig = _esdTag(0x04, _concat(
      new Uint8Array([0x40, 0x15, 0x00, 0x00, 0x00]),
      _u32(t.bitrate), _u32(t.bitrate), decSpecInfo))
    const slConfig = _esdTag(0x06, new Uint8Array([0x02]))
    const esDesc = _esdTag(0x03, _concat(_u16(t.trackId), new Uint8Array([0x00]), decConfig, slConfig))
    const esds = _full('esds', 0, 0, esDesc)
    const btrt = _box('btrt', _u32(0), _u32(t.bitrate), _u32(t.bitrate))
    const entry = _concat(
      new Uint8Array(6), _u16(1),
      new Uint8Array(8),
      _u16(t.audioChannels), _u16(t.audioSampleSize),
      _u16(0), _u16(0),
      _u16(t.audioSampleRate), _u16(0),
      esds, btrt)
    return _full('stsd', 0, 0, _u32(1), _box(t.codecTag, entry))
  }
  return _full('stsd', 0, 0, _u32(0))
}

function _buildTrak (t) {
  const tkhd = _full('tkhd', 0, 3,
    _u32(0), _u32(0), _u32(t.trackId), _u32(0), _u32(t.tkDur),
    new Uint8Array(8), _u16(0), _u16(0),
    _u16(t.isAudio ? 0x0100 : 0), _u16(0),
    _matrix(), _u32(t.isVideo ? t.tkW : 0), _u32(t.isVideo ? t.tkH : 0))
  const elst = _full('elst', 0, 0, _u32(1), _u32(t.tkDur), _u32(0), _u16(1), _u16(0))
  const edts = _box('edts', elst)
  const mdhd = _full('mdhd', 0, 0,
    _u32(0), _u32(0), _u32(t.mdTs), _u32(t.mdDur),
    _u16(t.mdLang || 0x55c4), _u16(0))
  const name = t.isVideo ? 'VideoHandler' : t.isAudio ? 'SoundHandler' : 'Handler'
  const hdlr = _full('hdlr', 0, 0,
    _u32(0), _ascii(t.isVideo ? 'vide' : 'soun'),
    new Uint8Array(12), _ascii(name + '\0'))

  const stsd = _buildStsd(t)
  const stts = _full('stts', 0, 0, t.sttsBody)
  const stsc = _full('stsc', 0, 0, t.stscBody)
  const stsz = _full('stsz', 0, 0, t.stszBody)

  const stcoPayload = new Uint8Array(4 + t.stcoEntries.length * 4)
  const stcoDv = new DataView(stcoPayload.buffer)
  stcoDv.setUint32(0, t.stcoEntries.length)
  for (let i = 0; i < t.stcoEntries.length; i++) stcoDv.setUint32(4 + i * 4, t.stcoEntries[i])
  const stco = _full('stco', 0, 0, stcoPayload)

  const stss = t.stssBody ? _full('stss', 0, 0, t.stssBody) : null

  const stblParts = [stsd, stts]
  if (stss) stblParts.push(stss)
  stblParts.push(stsc, stsz, stco)
  if (t.isAudio) {
    stblParts.push(
      _full('sgpd', 1, 0, _ascii('roll'), _u32(2), _u32(1), _u16(0xFFFF)),
      _full('sbgp', 0, 0, _ascii('roll'), _u32(1), _u32(t.sampleCount), _u32(1)))
  }
  const stbl = _box('stbl', ...stblParts)

  const mediaHdr = t.isVideo
    ? _full('vmhd', 0, 1, new Uint8Array(8))
    : _full('smhd', 0, 0, new Uint8Array(4))
  const dref = _full('dref', 0, 0, _u32(1), _full('url ', 0, 1))
  const dinf = _box('dinf', dref)
  const minf = _box('minf', mediaHdr, dinf, stbl)
  const mdia = _box('mdia', mdhd, hdlr, minf)

  return _box('trak', tkhd, edts, mdia)
}

async function normalizeMp4Container (buffer) {
  const u8 = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)

  const top = _scanBoxes(u8, 0, u8.byteLength)
  const moovBox = top.find(b => b.type === 'moov')
  const mdatBox = top.find(b => b.type === 'mdat')
  if (!moovBox || !mdatBox) return buffer

  const moovKids = _scanBoxes(u8, moovBox.offset + 8, moovBox.offset + moovBox.size)
  const mvhdBox = moovKids.find(b => b.type === 'mvhd')
  const trakBoxes = moovKids.filter(b => b.type === 'trak')
  if (!mvhdBox || !trakBoxes.length) return buffer

  const mvo = mvhdBox.offset + 12
  const mvTs = dv.getUint32(mvo + 8)
  const mvDur = dv.getUint32(mvo + 12)

  const tracks = []
  for (const tb of trakBoxes) {
    const t = _extractTrack(u8, dv, tb)
    if (t) tracks.push(t)
  }
  if (!tracks.length) return buffer

  const ftyp = _box('ftyp', _ascii('isom'), _u32(0x200), _ascii('isom'), _ascii('iso2'), _ascii('mp41'))

  const mvhd = _full('mvhd', 0, 0,
    _u32(0), _u32(0), _u32(mvTs), _u32(mvDur),
    _u32(0x00010000), _u16(0x0100), new Uint8Array(10),
    _matrix(), new Uint8Array(24), _u32(tracks.length + 1))
  const newTraks = tracks.map(t => _buildTrak(t))
  const moov = _box('moov', mvhd, ...newTraks)

  // Patch stco offsets: delta = new mdat position - original mdat position
  const delta = ftyp.byteLength + moov.byteLength - mdatBox.offset
  const mdv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength)
  for (let i = 0; i < moov.byteLength - 8; i++) {
    if (moov[i + 4] === 0x73 && moov[i + 5] === 0x74 && moov[i + 6] === 0x63 && moov[i + 7] === 0x6f) {
      const cnt = mdv.getUint32(i + 12)
      for (let j = 0; j < cnt; j++) {
        const p = i + 16 + j * 4
        mdv.setUint32(p, mdv.getUint32(p) + delta)
      }
    }
  }

  const mdatBytes = u8.slice(mdatBox.offset, mdatBox.offset + mdatBox.size)
  return _concat(ftyp, moov, mdatBytes).buffer
}

async function encodeVideo ({ file, srcMeta, plan, onProgress }) {
  const w = srcMeta.w
  const h = srcMeta.h
  const durationCfr = Number(srcMeta.duration)
  const long = Math.max(w, h)
  const scale = Math.min(1, MAX_LONG_SIDE / Math.max(2, long))
  const targetWidth = Math.max(2, Number(plan?.width) || Math.round(w * scale))
  const targetHeight = Math.max(2, Number(plan?.height) || Math.round(h * scale))

  const fallbackPlan = plan || await determineEncodingPlan(file, { width: w, height: h, duration: durationCfr })
  const targetFps = Math.max(1, Number(fallbackPlan.fps))
  const step = 1 / Math.max(1, targetFps)
  const frames = Math.max(1, Math.floor(durationCfr / step))

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })
  const passthroughInput = fallbackPlan.copyVideo ? new Input({ source: new BlobSource(file), formats: ALL_FORMATS }) : null
  const passthroughTracks = passthroughInput ? await passthroughInput.getTracks() : []
  const passthroughTrack = passthroughTracks.find(t => typeof t.isVideoTrack === 'function' && t.isVideoTrack())
  const passthroughAudioTrack = passthroughTrack && passthroughTracks.find(t =>
    typeof t.isAudioTrack === 'function' && t.isAudioTrack() &&
    t.codec === 'aac' && [1, 2].includes(t.numberOfChannels) && [44_100, 48_000].includes(t.sampleRate)
  )
  const encoder = passthroughTrack ? null : await selectVideoEncoderConfig({ width: targetWidth, height: targetHeight, fps: targetFps, bitrate: fallbackPlan.bitrate })
  const videoTrack = new EncodedVideoPacketSource(passthroughTrack?.codec || encoder.codecId)
  output.addVideoTrack(videoTrack, passthroughTrack ? { rotation: passthroughTrack.rotation } : { frameRate: targetFps })

  let audioBuffer = null
  if (!passthroughAudioTrack) {
    const _warn = console.warn
    console.warn = (...args) => {
      const m = args && args[0]
      if (typeof m === 'string' && m.includes('Unsupported audio codec') && m.includes('apac')) return
      _warn.apply(console, args)
    }
    audioBuffer = await decodeAudioPCM(file, { duration: durationCfr })
    console.warn = _warn
  }

  const audioSource = passthroughAudioTrack
    ? new EncodedAudioPacketSource('aac')
    : new AudioSampleSource({
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
  const passthroughAudioPromise = passthroughAudioTrack && (async () => {
    const sink = new EncodedPacketSink(passthroughAudioTrack)
    const decoderConfig = await passthroughAudioTrack.getDecoderConfig()
    const firstTimestamp = await passthroughAudioTrack.getFirstTimestamp()
    for await (const packet of sink.packets()) {
      await audioSource.add(packet.clone({ timestamp: Math.max(0, packet.timestamp - firstTimestamp) }), { decoderConfig: decoderConfig || undefined })
    }
    audioSource.close()
  })()

  let videoDuration = durationCfr
  if (passthroughTrack) {
    const sink = new EncodedPacketSink(passthroughTrack)
    const decoderConfig = await passthroughTrack.getDecoderConfig()
    const firstTimestamp = await passthroughTrack.getFirstTimestamp()
    videoDuration = 0
    for await (const packet of sink.packets(undefined, undefined, { verifyKeyPackets: true })) {
      const normalizedPacket = packet.clone({ timestamp: Math.max(0, packet.timestamp - firstTimestamp) })
      await videoTrack.add(normalizedPacket, { decoderConfig: decoderConfig || undefined })
      videoDuration = Math.max(videoDuration, normalizedPacket.timestamp + normalizedPacket.duration)
      if (typeof onProgress === 'function') {
        try {
          onProgress(Math.min(1, videoDuration / durationCfr))
        } catch (err) {
          console.warn('straight-to-video: onProgress callback threw; ignoring error', err)
        }
      }
    }
    videoTrack.close()
  } else {
    let codecDesc = null
    const pendingPackets = []
    const ve = new VideoEncoder({
      output: (chunk, meta) => {
        if (!codecDesc && meta?.decoderConfig?.description) codecDesc = meta.decoderConfig.description
        pendingPackets.push({ chunk })
      },
      error: () => {}
    })
    ve.configure(encoder.config)

    const canvas = document.createElement('canvas'); canvas.width = targetWidth; canvas.height = targetHeight
    const ctx = canvas.getContext('2d', { alpha: false })

    await (shouldDecodeViaVideoElement()
      ? encodeFramesViaVideoElement({ file, durationCfr, step, frames, canvas, ctx, ve, onProgress })
      : encodeFramesViaVideoSampleSink({ file, durationCfr, step, frames, canvas, ctx, ve, onProgress }))
    await ve.flush()

    const muxCount = Math.min(frames, pendingPackets.length)
    videoDuration = muxCount * step
    for (let i = 0; i < muxCount; i++) {
      const { chunk } = pendingPackets[i]
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data)
      const ts = i * step; const dur = step
      const pkt = new EncodedPacket(data, i === 0 || chunk.type === 'key' ? 'key' : 'delta', ts, dur)
      await videoTrack.add(pkt, { decoderConfig: { codec: encoder.config.codec, codedWidth: targetWidth, codedHeight: targetHeight, description: codecDesc } })
    }
  }

  if (passthroughAudioPromise) {
    await passthroughAudioPromise
  } else {
    const totalVideoSamples = videoDuration * TARGET_AUDIO_SR
    const targetSamples = Math.max(1024, Math.floor(totalVideoSamples / 1024) * 1024 - 2048)
    const audioExact = await renderStereo48kExact(audioBuffer, targetSamples)
    const interleaved = interleaveStereoF32(audioExact)
    const sample = new AudioSample({ format: 'f32', sampleRate: TARGET_AUDIO_SR, numberOfChannels: TARGET_AUDIO_CHANNELS, timestamp: 0, data: interleaved })
    await audioSource.add(sample)
    audioSource.close()
  }
  await output.finalize()
  const normalized = await normalizeMp4Container(output.target.buffer)
  const payload = new Uint8Array(normalized)
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
