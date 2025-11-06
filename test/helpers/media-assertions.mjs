import { test as _test, expect } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'

function run(cmd, args) { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
function runErr(cmd, args) { const { stderr } = spawnSync(cmd, args, { encoding: 'utf8' }); return stderr || '' }

function parseRational(s) {
  const str = String(s || '').trim()
  if (!str || str === '0/0' || str === 'N/A') return 0
  if (str.includes('/')) {
    const [a, b] = str.split('/')
    const num = parseFloat(a), den = parseFloat(b || '1')
    return den === 0 ? 0 : (num / den)
  }
  const f = parseFloat(str)
  return Number.isFinite(f) ? f : 0
}

function ffprobe(path, args) {
  return run('ffprobe', ['-v', 'error', ...args, path]).trim()
}

function videoBitrateMbps(path) {
  const s = ffprobe(path, ['-select_streams', 'v:0', '-show_entries', 'stream=bit_rate', '-of', 'default=nw=1:nk=1'])
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? (n / 1_000_000.0) : 0
}

function audioBitrateKbps(path) {
  const s = ffprobe(path, ['-select_streams', 'a:0', '-show_entries', 'stream=bit_rate', '-of', 'default=nw=1:nk=1'])
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? (n / 1000.0) : 0
}

function fpsFromFile(path) {
  const s = ffprobe(path, ['-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'default=nw=1:nk=1'])
  return parseRational(s)
}

// Strict Instagram delivery spec (mirrors reference helpers)
// `summary` is the JSON summary from the test server; `filePath` is the saved output path
export function assertInstagramStrict(summary, filePath) {
  // Container
  expect(String(summary.format_name)).toMatch(/mp4|mov|m4a|3gp|3g2|mj2/i)
  // Codecs + pixel format
  expect(String(summary.vcodec)).toMatch(/^(hevc|h264)$/)
  expect(String(summary.pix_fmt)).toMatch(/yuv420p/i)
  // Fast start
  expect(Boolean(summary.moov_front)).toBe(true)
  // Audio
  expect(String(summary.audio_codec)).toBe('aac')
  expect([1, 2]).toContain(Number(summary.audio_channels))
  expect(Number(summary.sample_rate)).toBe(48000)

  // Generic FPS bounds
  const fps = Number(summary.fps)
  expect(fps).toBeGreaterThanOrEqual(23)
  expect(fps).toBeLessThanOrEqual(60)

  // Max horizontal pixels
  expect(Number(summary.width)).toBeLessThanOrEqual(1920)

  // Aspect ratio bounds
  const ar = Number(summary.width) / Math.max(1, Number(summary.height))
  expect(ar).toBeGreaterThanOrEqual(0.01)
  expect(ar).toBeLessThanOrEqual(10.0)

  // Bitrates + file size
  const vMbps = videoBitrateMbps(filePath)
  const aKbps = audioBitrateKbps(filePath)
  expect(vMbps).toBeLessThanOrEqual(25)
  expect(aKbps).toBeLessThanOrEqual(128)
  const sizeMB = fs.statSync(filePath).size / 1_000_000.0
  expect(sizeMB).toBeLessThanOrEqual(300)
}

export default { assertInstagramStrict }
