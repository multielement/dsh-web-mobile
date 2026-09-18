import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { headerValue, isDeferrable, varyWithAcceptEncoding, installResponseCompression } from '../src/compress.ts'

test('headerValue finds keys regardless of casing', () => {
  assert.equal(headerValue({ 'Content-Type': 'application/json' }, 'content-type'), 'application/json')
  assert.equal(headerValue({ 'content-type': 'text/html' }, 'content-type'), 'text/html')
  assert.equal(headerValue({ 'CONTENT-ENCODING': 'gzip' }, 'content-encoding'), 'gzip')
  assert.equal(headerValue({ 'x-foo': '1' }, 'content-type'), undefined)
  assert.equal(headerValue({}, 'vary'), undefined)
  // Mixed-case keys are the raw writeHead argument reality.
  assert.equal(headerValue({ 'Content-Length': 123 }, 'content-length'), '123')
})

test('isDeferrable honors case-insensitive content-encoding / content-type', () => {
  // Lowercase keys (the pre-fix working case).
  assert.equal(isDeferrable({ 'content-type': 'application/json' }), true)
  assert.equal(isDeferrable({ 'content-type': 'application/json', 'content-encoding': 'gzip' }), false)
  assert.equal(isDeferrable({ 'content-type': 'text/html' }), false)
  // Mixed-case keys silently missed by the pre-fix direct lookup.
  assert.equal(isDeferrable({ 'Content-Type': 'application/json' }), true)
  assert.equal(isDeferrable({ 'Content-Type': 'application/json', 'Content-Encoding': 'br' }), false)
})

test('varyWithAcceptEncoding appends without clobbering, preserving key casing', () => {
  const none = {}
  varyWithAcceptEncoding(none)
  assert.deepEqual(none, { vary: 'Accept-Encoding' })

  const lowercase = { vary: 'Origin' }
  varyWithAcceptEncoding(lowercase)
  assert.equal(lowercase.vary, 'Origin, Accept-Encoding')

  const mixed = { Vary: 'Origin' }
  varyWithAcceptEncoding(mixed)
  assert.equal(mixed.Vary, 'Origin, Accept-Encoding')
  assert.equal(mixed.vary, undefined)
})

// Regression: a `setHeader('Content-Type', 'application/json')` +
// `writeHead(200)` handler carries its headers OUT of the writeHead argument
// list. The pre-fix patch read only the argument, saw "no headers", and
// passed the body through uncompressed — silently disabling compression for
// every setHeader-style handler. These tests pin the merged-snapshot path.
test('compression still fires when headers were set via setHeader (no writeHead headers arg)', async () => {
  const dispose = installResponseCompression()
  const big = JSON.stringify({ blob: 'z'.repeat(20000) })
  const small = JSON.stringify({ ok: true })

  const server = http.createServer((req, res) => {
    if (req.url === '/setheader-big') {
      res.setHeader('Content-Type', 'application/json')
      res.writeHead(200)
      res.end(big)
    } else if (req.url === '/setheader-small') {
      res.setHeader('Content-Type', 'application/json')
      res.writeHead(200)
      res.end(small)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const fetchPath = (path, headers) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
    })
    r.on('error', reject)
    r.end()
  })

  try {
    const bigRes = await fetchPath('/setheader-big', { 'Accept-Encoding': 'br' })
    assert.equal(bigRes.headers['content-encoding'], 'br')
    assert.equal(brotliDecompressSync(bigRes.body).toString(), big)
    assert.equal(Number(bigRes.headers['content-length']), bigRes.body.length)

    const gzipRes = await fetchPath('/setheader-big', { 'Accept-Encoding': 'gzip' })
    assert.equal(gzipRes.headers['content-encoding'], 'gzip')
    assert.equal(gunzipSync(gzipRes.body).toString(), big)

    // Small setHeader JSON still passes through untouched.
    const smallRes = await fetchPath('/setheader-small', { 'Accept-Encoding': 'br' })
    assert.equal(smallRes.headers['content-encoding'], undefined)
    assert.equal(smallRes.body.toString(), small)
  } finally {
    dispose()
    server.close()
  }
})

test('a pre-set Content-Encoding is never double-compressed', async () => {
  const dispose = installResponseCompression()
  const big = JSON.stringify({ blob: 'q'.repeat(20000) })

  const server = http.createServer((req, res) => {
    // Caller already encoded the body elsewhere; the patch must leave it alone.
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Encoding', 'gzip')
    res.writeHead(200)
    res.end(big)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const body = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/', headers: { 'Accept-Encoding': 'br' } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
    })
    r.on('error', reject)
    r.end()
  })
  try {
    assert.equal(body.headers['content-encoding'], 'gzip')
    // Body must be the original, not a brotli-of-gzip monster.
    assert.equal(body.body.toString(), big)
  } finally {
    dispose()
    server.close()
  }
})

// Regression: `end(chunk, encoding, cb)` / `write(chunk, encoding, cb)` were
// replayed with the encoding string forwarded as a second body chunk (crashing
// the client parser), and write callbacks were dropped entirely. Both must
// round-trip cleanly and fire every callback once.
test('end(chunk, encoding, cb) round-trips and fires its callback', async () => {
  const dispose = installResponseCompression()
  const big = JSON.stringify({ blob: 'r'.repeat(20000) })
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(big, 'utf8', () => { globalThis.__endFired = true })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', headers: { 'Accept-Encoding': 'br' } }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(r.headers['content-encoding'], 'br')
    assert.equal(brotliDecompressSync(r.body).toString(), big)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(globalThis.__endFired, true)
  } finally {
    dispose()
    server.close()
  }
})

test('write(chunk, encoding, cb) callbacks fire once after the body', async () => {
  const dispose = installResponseCompression()
  const big = JSON.stringify({ blob: 's'.repeat(20000) })
  let calls = 0
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write(big, 'utf8', () => { calls++ })
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(r.headers['content-encoding'], 'gzip')
    assert.equal(gunzipSync(r.body).toString(), big)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(calls, 1)
  } finally {
    dispose()
    server.close()
  }
})
