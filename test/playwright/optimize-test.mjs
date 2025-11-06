import { test, expect } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { assertInstagramStrict } from '../helpers/media-assertions.mjs'

test.setTimeout(120_000)

function run(cmd, args) { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
function runErr(cmd, args) { const { stderr } = spawnSync(cmd, args, { encoding: 'utf8' }); return stderr || '' }
function videoDuration(path) {
  const s = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]).trim()
  const v = parseFloat(s); return Number.isFinite(v) ? v : 0
}
function firstFrameBlack(path, { maxFirstMs = 40, lumaTh = 0.10, ratioTh = 0.98 } = {}) {
  const vf = `scale=360:640:flags=bicubic,blackdetect=d=0.01:pix_th=${lumaTh}:picture_black_ratio_th=${ratioTh}`
  const err = runErr('ffmpeg', ['-v', 'info', '-hide_banner', '-i', path, '-vf', vf, '-f', 'null', '-'])
  const m = err.match(/black_start:([0-9.]+).*?black_end:([0-9.]+).*?black_duration:([0-9.]+)/)
  if (!m) return false; return parseFloat(m[1]) <= (maxFirstMs / 1000.0)
}
function videoAvgFps(path) {
  const s = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'default=nw=1:nk=1', path]).trim()
  if (!s || s === '0/0') return 0; if (!s.includes('/')) return parseFloat(s) || 0
  const [a, b] = s.split('/'); const num = parseFloat(a); const den = parseFloat(b || '1'); return den === 0 ? 0 : (num / den)
}
function effectiveFpsViaMpdecimate(path, { hi = '64*5', lo = '64*1', frac = 0.33 } = {}) {
  const vf = `scale=360:640:flags=bicubic,mpdecimate=hi=${hi}:lo=${lo}:frac=${frac},showinfo`
  const err = runErr('ffmpeg', ['-loglevel', 'info', '-i', path, '-vf', vf, '-an', '-f', 'null', '-'])
  const unique = (err.match(/Parsed_showinfo_\d+.*\bn:\s*\d+\b/g) || []).length
  const dur = videoDuration(path); return dur > 0 ? (unique / dur) : 0
}
function freezeTotalSeconds(path, { minFreezeD = 0.12, noise = 0.003 } = {}) {
  const vf = `scale=360:640:flags=bicubic,freezedetect=n=${noise}:d=${minFreezeD}`
  const err = runErr('ffmpeg', ['-v', 'info', '-i', path, '-vf', vf, '-f', 'null', '-'])
  let total = 0; for (const m of err.matchAll(/freeze_duration:([0-9.]+)/g)) total += parseFloat(m[1])
  if (total > 0) return total
  const eff = effectiveFpsViaMpdecimate(path), fps = videoAvgFps(path), dur = videoDuration(path)
  if (fps <= 0 || dur <= 0) return 0; return dur * Math.max(1 - (eff / fps), 0)
}
function visualSSIM(a, b) {
  const filter = '[0:v]scale=360:640:flags=bicubic,format=yuv420p[ra];[1:v]scale=360:640:flags=bicubic,format=yuv420p[rb];[ra][rb]ssim'
  const err = runErr('ffmpeg', ['-v', 'info', '-i', a, '-i', b, '-lavfi', filter, '-f', 'null', '-']); const m = err.match(/All:([0-9.]+)/)
  return m ? parseFloat(m[1]) : NaN
}
function blackTotalSeconds(path, { lumaTh = 0.10, ratioTh = 0.98, minD = 0.25 } = {}) {
  const vf = `scale=360:640:flags=bicubic,blackdetect=d=${minD}:pix_th=${lumaTh}:picture_black_ratio_th=${ratioTh}`
  const err = runErr('ffmpeg', ['-v', 'info', '-hide_banner', '-i', path, '-vf', vf, '-f', 'null', '-'])
  let total = 0; for (const m of err.matchAll(/black_duration:([0-9.]+)/g)) total += parseFloat(m[1])
  return total
}
function frameColorMetrics(path, { at = 0.10, downscale = [96, 96] } = {}) {
  const [w, h] = downscale
  const out = execFileSync('ffmpeg', ['-v', 'error', '-hide_banner', '-ss', String(at), '-i', path, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=bicubic`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
  const data = new Uint8Array(out)
  const total = Math.floor(data.length / 3)
  let sumR = 0, sumG = 0, sumB = 0, sumSat = 0
  for (let i = 0, j = 0; i < total; i++, j += 3) {
    const r = data[j] / 255, g = data[j + 1] / 255, b = data[j + 2] / 255
    sumR += r; sumG += g; sumB += b
    const maxv = Math.max(r, g, b), minv = Math.min(r, g, b)
    const sat = maxv > 0 ? ((maxv - minv) / maxv) : 0
    sumSat += sat
  }
  const avgR = sumR / total, avgG = sumG / total, avgB = sumB / total
  const y = 0.2126 * avgR + 0.7152 * avgG + 0.0722 * avgB
  return { y, sat: (sumSat / total), r: avgR, g: avgG, b: avgB }
}
function assertFrameColorPreserved(srcPath, outPath, { at = 0.10, satRatio = 0.85, yDelta = 0.10 } = {}) {
  const src = frameColorMetrics(srcPath, { at })
  const out = frameColorMetrics(outPath, { at })
  expect(out.sat).toBeGreaterThanOrEqual(src.sat * satRatio)
  expect(Math.abs(src.y - out.y)).toBeLessThanOrEqual(yDelta)
}
function readPCMFloat32(path, sr, seconds) {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-hide_banner', '-i', path, '-map', 'a:0?', '-ac', '1', '-ar', String(sr), '-t', String(seconds), '-f', 'f32le', 'pipe:1'])
  const buf = Buffer.from(out); const arr = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)); return Array.from(arr)
}
function audioSimilarity(a, b, { sampleRate = 16000, seconds = 3.2, maxLagMs = 250 } = {}) {
  const A = readPCMFloat32(a, sampleRate, seconds), B = readPCMFloat32(b, sampleRate, seconds)
  if (!A.length || !B.length) return NaN
  const nlag = Math.floor(sampleRate * (maxLagMs / 1000)), mean = (t) => t.reduce((s, x) => s + x, 0) / t.length
  const a0 = A.map(x => x - mean(A)), b0 = B.map(x => x - mean(B))
  const aden = Math.hypot(...a0), bden = Math.hypot(...b0); if (aden === 0 || bden === 0) return NaN
  let best = -1
  for (let lag = -nlag; lag <= nlag; lag++) {
    let dot = 0, len = 0
    if (lag >= 0) { len = Math.min(a0.length - lag, b0.length); for (let i = 0; i < len; i++) dot += a0[i + lag] * b0[i] }
    else { const pos = -lag; len = Math.min(a0.length, b0.length - pos); for (let i = 0; i < len; i++) dot += a0[i] * b0[i + pos] }
    const corr = dot / (aden * bden); if (corr > best) best = corr
  }
  return best
}
function detectVolume(path) {
  const err = runErr('ffmpeg', ['-v', 'info', '-hide_banner', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'])
  const max = parseFloat((err.match(/max_volume:\s*([-\d.]+)\s*dB/) || [])[1])
  const mean = parseFloat((err.match(/mean_volume:\s*([-\d.]+)\s*dB/) || [])[1])
  return { max, mean }
}
function sha256(path) { const h = createHash('sha256'); h.update(fs.readFileSync(path)); return h.digest('hex') }
// Instagram delivery checks live in ../helpers/media-assertions.mjs
async function submitViaForm(page, localPath, { useNoContentTypeFixture = false } = {}) {
  if (!useNoContentTypeFixture) {
    await page.getByLabel(/Video file/i).setInputFiles(localPath)
  } else {
    await page.getByLabel(/Use fixture with missing Content-Type/i).check()
  }
  await page.getByRole('button', { name: /Optimize \+ upload/i }).click()
  const pre = page.locator('pre#out')
  await expect(pre).not.toHaveText(/^$/, { timeout: 90_000 })
  const text = await pre.textContent()
  const json = JSON.parse(text || '{}')
  return json
}

test('4K 16:9 optimizes to spec and quality holds', async ({ page }) => {
  const input = 'test/fixtures/4k_16_9.mp4'
  await page.goto('/test/pages/optimize.html')
  const json = await submitViaForm(page, input)
  const s = json.summary
  expect(String(s.format_name)).toBe('mov,mp4,m4a,3gp,3g2,mj2')
  expect(String(s.vcodec)).toMatch(/^(hevc|h264)$/)
  expect(String(s.pix_fmt)).toMatch(/yuv420p/i)
  expect(Number(s.width)).toBe(1920)
  expect(Number(s.height)).toBe(1080)
  expect(Number(s.fps)).toBeGreaterThanOrEqual(50)
  expect(Number(s.fps)).toBeLessThanOrEqual(60)
  expect(Boolean(s.has_audio)).toBe(true)
  expect(String(s.audio_codec)).toBe('aac')
  expect([1, 2]).toContain(Number(s.audio_channels))
  expect(Number(s.sample_rate)).toBe(48000)
  expect(Boolean(s.moov_front)).toBe(true)
  expect(String(json.file?.name)).toMatch(/-optimized\.mp4$/)
  expect(String(json.file?.content_type)).toContain('video/mp4')
  const outPath = json.file.path, inPath = input
  expect(firstFrameBlack(outPath)).toBe(false)
  expect(freezeTotalSeconds(outPath, { minFreezeD: 0.12 })).toBeLessThanOrEqual(0.6)
  const eff = effectiveFpsViaMpdecimate(outPath)
  expect(eff).toBeGreaterThanOrEqual(20)
  const durIn = videoDuration(inPath), durOut = videoDuration(outPath)
  expect(Math.abs(durIn - durOut)).toBeLessThanOrEqual(0.05)
  expect(visualSSIM(outPath, inPath)).toBeGreaterThan(0.65)
  expect(audioSimilarity(outPath, inPath)).toBeGreaterThan(0.75)
  const vol = detectVolume(outPath)
  expect(Number.isFinite(vol.max)).toBe(true); expect(Number.isFinite(vol.mean)).toBe(true)
  expect(vol.max).toBeGreaterThan(-19.0)
  assertInstagramStrict(s, outPath)
  expect(blackTotalSeconds(outPath)).toBe(0)
  assertFrameColorPreserved(inPath, outPath, { at: 0.10, satRatio: 0.85, yDelta: 0.10 })
})

test('MOV with moov-at-end is remuxed with moov front', async ({ page }) => {
  const input = 'test/fixtures/2k_bad_moov.mov'
  await page.goto('/test/pages/optimize.html')
  const json = await submitViaForm(page, input)
  const s = json.summary
  expect(Boolean(s.moov_front)).toBe(true)
  expect(String(json.file?.content_type)).toContain('video/mp4')
  expect(String(json.file?.name)).toMatch(/-optimized\.mp4$/)
  const outPath = json.file.path
  assertInstagramStrict(s, outPath)
})

test('4K square silent → 1920×1920 with silent AAC', async ({ page }) => {
  const input = 'test/fixtures/4k_square_silent.mp4'
  await page.goto('/test/pages/optimize.html')
  const json = await submitViaForm(page, input)
  const s = json.summary
  expect(String(s.vcodec)).toMatch(/^(hevc|h264)$/)
  expect(String(s.pix_fmt)).toMatch(/yuv420p/i)
  expect(Number(s.width)).toBe(1920)
  expect(Number(s.height)).toBe(1920)
  expect(Number(s.fps)).toBeGreaterThanOrEqual(50)
  expect(Number(s.fps)).toBeLessThanOrEqual(60)
  expect(Boolean(s.has_audio)).toBe(true)
  expect(String(s.audio_codec)).toBe('aac')
  expect(Number(s.sample_rate)).toBe(48000)
  expect(Boolean(s.moov_front)).toBe(true)
  const outPath = json.file.path
  const samples = readPCMFloat32(outPath, 16000, 0.2)
  const rms = Math.sqrt(samples.reduce((acc, x) => acc + x * x, 0) / Math.max(1, samples.length))
  expect(rms).toBeLessThanOrEqual(1e-4)
  assertInstagramStrict(s, outPath)
})

test('non-video passthrough (PNG) is byte-identical', async ({ page }) => {
  await page.goto('/test/pages/optimize.html')
  const json = await submitViaForm(page, 'test/fixtures/image.png')
  const src = 'test/fixtures/image.png'
  expect(fs.existsSync(json.file.path)).toBe(true)
  expect(sha256(json.file.path)).toBe(sha256(src))
})

test('canOptimize header sniff + feasibility path', async ({ page }) => {
  await page.goto('/test/pages/optimize.html')
  await page.getByLabel(/Use fixture with missing Content-Type/i).check()
  await page.getByRole('button', { name: /Feasibility \(no upload\)/i }).click()
  const pre = page.locator('pre#out')
  await expect(pre).not.toHaveText(/^$/, { timeout: 30_000 })
  const feas = JSON.parse((await pre.textContent()) || '{}')
  expect(feas).toHaveProperty('ok')
  expect(feas.reason).not.toBe('unknown-container')
})

test('1080p portrait MP4 optimizes to spec (2k_9_16.mp4)', async ({ page }) => {
  const input = 'test/fixtures/2k_9_16.mp4'
  await page.goto('/test/pages/optimize.html')
  const json = await submitViaForm(page, input)
  const s = json.summary
  expect(String(s.format_name)).toBe('mov,mp4,m4a,3gp,3g2,mj2')
  expect(String(s.vcodec)).toMatch(/^(hevc|h264)$/)
  expect(String(s.pix_fmt)).toMatch(/yuv420p/i)
  expect(Number(s.width)).toBe(1080)
  expect(Number(s.height)).toBe(1920)
  expect(Number(s.fps)).toBeGreaterThanOrEqual(25)
  expect(Number(s.fps)).toBeLessThanOrEqual(30)
  expect(Boolean(s.has_audio)).toBe(true)
  expect(String(s.audio_codec)).toBe('aac')
  expect([1, 2]).toContain(Number(s.audio_channels))
  expect(Number(s.sample_rate)).toBe(48000)
  expect(Boolean(s.moov_front)).toBe(true)
  expect(String(json.file?.name)).toMatch(/-optimized\.mp4$/)
  expect(String(json.file?.content_type)).toContain('video/mp4')
  // Quality + audio checks
  const outPath = json.file.path
  const inPath = input
  expect(firstFrameBlack(outPath)).toBe(false)
  expect(Math.abs(videoDuration(inPath) - videoDuration(outPath))).toBeLessThanOrEqual(0.05)
  const eff2 = effectiveFpsViaMpdecimate(outPath)
  expect(eff2).toBeGreaterThanOrEqual(Number(s.fps) * 0.7)
  expect(visualSSIM(outPath, inPath)).toBeGreaterThan(0.65)
  expect(audioSimilarity(outPath, inPath)).toBeGreaterThan(0.83)
  const vol = detectVolume(outPath)
  expect(Number.isFinite(vol.max)).toBe(true)
  expect(vol.max).toBeGreaterThan(-13.5)
  assertInstagramStrict(s, outPath)
  assertFrameColorPreserved(inPath, outPath, { at: 0.10, satRatio: 0.85, yDelta: 0.10 })
})

test('1080p portrait MOV optimizes and normalizes to MP4 (2k_9_16.mov)', async ({ page }) => {
  const input = 'test/fixtures/2k_9_16.mov'
  await page.goto('/test/pages/optimize.html')
  const json = await submitViaForm(page, input)
  const s = json.summary
  expect(String(s.format_name)).toBe('mov,mp4,m4a,3gp,3g2,mj2')
  expect(String(s.vcodec)).toMatch(/^(hevc|h264)$/)
  expect(String(s.pix_fmt)).toMatch(/yuv420p/i)
  // Dimensions: portrait, long side ≤ 1920, width ≤ 1080 (allow source‑dependent rounding)
  expect(Number(s.height)).toBeGreaterThan(Number(s.width))
  expect(Number(s.height)).toBeLessThanOrEqual(1920)
  expect(Number(s.width)).toBeLessThanOrEqual(1080)
  expect(Number(s.fps)).toBeGreaterThanOrEqual(25)
  expect(Number(s.fps)).toBeLessThanOrEqual(60)
  expect(Boolean(s.has_audio)).toBe(true)
  expect(String(s.audio_codec)).toBe('aac')
  expect([1, 2]).toContain(Number(s.audio_channels))
  expect(Number(s.sample_rate)).toBe(48000)
  expect(Boolean(s.moov_front)).toBe(true)
  expect(String(json.file?.content_type)).toContain('video/mp4')
  expect(String(json.file?.name)).toMatch(/-optimized\.mp4$/)
  const outPath2 = json.file.path
  expect(firstFrameBlack(outPath2)).toBe(false)
  assertInstagramStrict(s, outPath2)
})

test('4K portrait MOV optimizes to spec and quality holds (4k_9_16.mov)', async ({ page }) => {
  const input = 'test/fixtures/4k_9_16.mov'
  await page.goto('/test/pages/optimize.html')
  const json = await submitViaForm(page, input)
  const s = json.summary
  expect(String(s.format_name)).toBe('mov,mp4,m4a,3gp,3g2,mj2')
  expect(String(s.vcodec)).toMatch(/^(hevc|h264)$/)
  expect(String(s.pix_fmt)).toMatch(/yuv420p/i)
  // Expect exact portrait target size for 4K → 1080×1920
  expect(Number(s.width)).toBe(1080)
  expect(Number(s.height)).toBe(1920)
  expect(Number(s.fps)).toBeGreaterThanOrEqual(50)
  expect(Number(s.fps)).toBeLessThanOrEqual(60)
  expect(Boolean(s.has_audio)).toBe(true)
  expect(String(s.audio_codec)).toBe('aac')
  expect([1, 2]).toContain(Number(s.audio_channels))
  expect(Number(s.sample_rate)).toBe(48000)
  expect(Boolean(s.moov_front)).toBe(true)
  expect(String(json.file?.content_type)).toContain('video/mp4')
  expect(String(json.file?.name)).toMatch(/-optimized\.mp4$/)
  const outPath = json.file.path, inPath = input
  expect(firstFrameBlack(outPath)).toBe(false)
  expect(blackTotalSeconds(outPath)).toBe(0)
  expect(freezeTotalSeconds(outPath, { minFreezeD: 0.12 })).toBeLessThanOrEqual(0.6)
  const eff = effectiveFpsViaMpdecimate(outPath)
  expect(eff).toBeGreaterThanOrEqual(24)
  expect(eff).toBeGreaterThanOrEqual(Number(s.fps) * 0.7)
  const durIn = videoDuration(inPath), durOut = videoDuration(outPath)
  expect(Math.abs(durIn - durOut)).toBeLessThanOrEqual(0.05)
  expect(visualSSIM(outPath, inPath)).toBeGreaterThan(0.65)
  expect(audioSimilarity(outPath, inPath)).toBeGreaterThan(0.75)
  const vol = detectVolume(outPath)
  expect(Number.isFinite(vol.max)).toBe(true)
  expect(vol.max).toBeGreaterThan(-19.0)
  assertInstagramStrict(s, outPath)
  assertFrameColorPreserved(inPath, outPath, { at: 0.10, satRatio: 0.85, yDelta: 0.10 })
})
