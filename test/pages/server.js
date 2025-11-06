#!/usr/bin/env node
import http from 'node:http'
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises'
import { extname, join, resolve, normalize, basename } from 'node:path'
import { spawn } from 'node:child_process'
import Busboy from 'busboy'

const port = Number(process.env.PORT || 8080)
const root = resolve(process.cwd())

const types = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm'
}))

async function ffprobeJson (path) {
  return await new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]
    const child = spawn('ffprobe', args)
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(out)) } catch (e) { reject(e) }
      } else {
        reject(new Error(err || `ffprobe exited ${code}`))
      }
    })
  })
}

async function collectRawToFile (req, suggestedName, contentType, headers = {}) {
  const tmpDir = join(root, 'test', 'tmp')
  await mkdir(tmpDir, { recursive: true })
  const suggested = headers['x-filename'] || suggestedName || 'upload.bin'
  const outPath = join(tmpDir, `${Date.now()}-${basename(suggested)}`)
  const chunks = []
  for await (const ch of req) chunks.push(ch)
  const buf = Buffer.concat(chunks)
  await writeFile(outPath, buf)
  return { filename: suggested, path: outPath, size: buf.length, contentType: contentType || 'application/octet-stream' }
}

async function handleUpload (req, res) {
  const tmpDir = join(root, 'test', 'tmp')
  await mkdir(tmpDir, { recursive: true })
  const ct = String(req.headers['content-type'] || '')
  if (!ct.toLowerCase().includes('multipart/form-data')) {
    try {
      const f = await collectRawToFile(req, 'upload.mp4', ct, req.headers)
      return await respondWithProbe(res, f)
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }))
      return
    }
  }

  const bb = Busboy({ headers: req.headers })
  const files = []
  bb.on('file', async (name, file, info) => {
    const filename = info.filename || 'upload.bin'
    const mime = info.mimeType || info.mimetype || 'application/octet-stream'
    const outPath = join(tmpDir, `${Date.now()}-${basename(filename)}`)
    const chunks = []
    for await (const ch of file) chunks.push(ch)
    const buf = Buffer.concat(chunks)
    await writeFile(outPath, buf)
    files.push({ field: name, filename, path: outPath, size: buf.length, contentType: mime })
  })
  bb.on('finish', async () => {
    try {
      const f = files[0]
      if (!f) throw new Error('no file received')
      await respondWithProbe(res, f)
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }))
    }
  })
  req.pipe(bb)
}

async function respondWithProbe (res, f) {
  const probe = await ffprobeJson(f.path)
  const video = probe.streams?.find((s) => s.codec_type === 'video') || {}
  const audio = probe.streams?.find((s) => s.codec_type === 'audio') || {}
  const fpsStr = video.avg_frame_rate || video.r_frame_rate || '0/1'
  const [n, d] = fpsStr.split('/').map((x) => Number(x || 0))
  const fps = d ? n / d : 0
  const head = await readFile(f.path)
  const headSlice = head.subarray(0, Math.min(256 * 1024, head.length))
  const moov_front = headSlice.includes(Buffer.from('moov'))
  const payload = {
    ok: true,
    file: { name: f.filename, path: f.path, size: f.size, content_type: f.contentType },
    probe,
    summary: {
      format_name: probe.format?.format_name,
      vcodec: video.codec_name,
      pix_fmt: video.pix_fmt,
      width: video.width,
      height: video.height,
      fps,
      has_audio: Boolean(audio?.codec_name),
      audio_codec: audio?.codec_name || null,
      audio_channels: audio?.channels || 0,
      sample_rate: Number(audio?.sample_rate || 0),
      moov_front
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url || '/', `http://localhost:${port}`)
    let path = decodeURIComponent(u.pathname || '/')
    if (path === '/') path = '/test/pages/optimize.html'
    // Serve a file without Content-Type header to simulate missing MIME type
    if (req.method === 'GET' && path.startsWith('/no-ct/')) {
      const rel = path.replace(/^\/no-ct\//, '')
      const full = normalize(join(root, rel))
      if (!full.startsWith(root)) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
      const data = await readFile(full)
      res.writeHead(200, { 'Cache-Control': 'no-cache' })
      res.end(data)
      return
    }
    if (req.method === 'POST' && path === '/upload') return await handleUpload(req, res)
    const full = normalize(join(root, path.replace(/^\//, '')))
    if (!full.startsWith(root)) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
    const st = await stat(full)
    if (st.isDirectory()) {
      res.writeHead(301, { Location: path.replace(/\/$/, '') + '/index.html' })
      res.end()
      return
    }
    const data = await readFile(full)
    const type = types.get(extname(full).toLowerCase()) || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
    res.end(data)
  } catch (err) {
    const code = err.statusCode || 404
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(String(err.message || 'not found'))
  }
})

server.listen(port, () => {
  console.log(`serving ${root} on http://localhost:${port}`)
})
