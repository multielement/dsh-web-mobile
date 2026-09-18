import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_IMAGE_LIMITS,
  HOST_IMAGE_TYPES,
  normalizeImage,
  sniffMediaType,
  type DecodedImage,
} from '../src/client/core/image-normalize.ts'

/** Build a Uint8Array from a hex string. */
function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** A decoded stand-in honouring the DecodedImage contract. */
function fakeDecoded(width: number, height: number, hasAlpha = false): DecodedImage {
  return { width, height, hasAlpha, draw: () => {}, close: () => {} }
}

/** A minimal File stand-in (node has no DOM File for our purposes). */
/**
 * Build the leading bytes of a JPEG of the given pixel size: SOI, a JFIF APP0
 * segment, then the SOF0 frame header. Enough for sniffImageSize to read the
 * geometry without any real pixel data behind it.
 */
function jpegHead(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,                                              // SOI
    0xff, 0xe0, 0x00, 0x10,                                  // APP0, length 16
    0x4a, 0x46, 0x49, 0x46, 0x00,                            // "JFIF\0"
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,    // version + density
    0xff, 0xc0, 0x00, 0x11, 0x08,                            // SOF0, length 17, precision 8
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ])
}

function fakeFile(name: string, type: string, size: number): File {
  const blob = new Blob([new Uint8Array(Math.min(size, 64))], { type })
  const file = blob as unknown as File
  Object.defineProperty(file, 'name', { value: name })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

test('sniffMediaType: recognises the four host-accepted containers', () => {
  assert.equal(sniffMediaType(bytes('ffd8ffe00010')), 'image/jpeg')
  assert.equal(sniffMediaType(bytes('89504e470d0a1a0a')), 'image/png')
  assert.equal(sniffMediaType(bytes('474946383961')), 'image/gif')
  assert.equal(sniffMediaType(bytes('524946460000000057454250')), 'image/webp')
})

test('sniffMediaType: flags HEIC/AVIF/BMP from the ISO-BMFF brand', () => {
  assert.equal(sniffMediaType(bytes('000000186674797068656963')), 'image/heic')
  assert.equal(sniffMediaType(bytes('000000186674797068656966')), 'image/heic')
  assert.equal(sniffMediaType(bytes('000000186674797061766966')), 'image/avif')
  assert.equal(sniffMediaType(bytes('424d00000000')), 'image/bmp')
})

test('sniffMediaType: unknown bytes yield null (caller keeps the declared type)', () => {
  assert.equal(sniffMediaType(bytes('0001020304')), null)
  assert.equal(sniffMediaType(new Uint8Array(0)), null)
})

test('host whitelist is exactly the four attachment-local types', () => {
  assert.deepEqual([...HOST_IMAGE_TYPES], ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  assert.equal(DEFAULT_IMAGE_LIMITS.maxBytes, 20971520)
  assert.equal(DEFAULT_IMAGE_LIMITS.maxDimension, 8192)
  assert.equal(DEFAULT_IMAGE_LIMITS.maxPixels, 64000000)
})

test('normalizeImage: accepted + small passthrough untouched', async () => {
  const file = fakeFile('a.png', 'image/png', 1024)
  const result = await normalizeImage(file, { readHead: async () => bytes('89504e47') })
  assert.equal(result.changed, false)
  assert.equal(result.reason, 'passthrough')
  assert.equal(result.file, file)
})

test('normalizeImage: Android image/jpg label is corrected without a decode', async () => {
  const file = fakeFile('a.jpg', 'image/jpg', 1024)
  const result = await normalizeImage(file, { readHead: async () => bytes('ffd8ff') })
  assert.equal(result.changed, true)
  assert.equal(result.file.type, 'image/jpeg')
  assert.equal(result.file.name, 'a.jpg')
})

test('normalizeImage: empty MIME is sniffed and never crashes without a decoder', async () => {
  const file = fakeFile('blob', '', 4096)
  const result = await normalizeImage(file, {
    readHead: async () => bytes('89504e470d0a1a0a'),
    decode: async () => fakeDecoded(100, 100),
    createCanvas: () => ({ width: 0, height: 0, getContext: () => null }) as unknown as HTMLCanvasElement,
    encodeBlob: async () => null,
  })
  assert.equal(result.changed, false)
  assert.equal(result.reason, 'no-2d-context')
})

test('normalizeImage: oversized bytes force a re-encode within the dimension ceiling', async () => {
  const file = fakeFile('big.jpg', 'image/jpeg', 40 * 1024 * 1024)
  const drawn: Array<[number, number]> = []
  const result = await normalizeImage(file, {
    readHead: async () => bytes('ffd8ff'),
    decode: async () => ({
      ...fakeDecoded(20000, 20000),
      draw: (_ctx: CanvasRenderingContext2D, w: number, h: number) => { drawn.push([w, h]) },
    }),
    createCanvas: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: () => {} }) }) as unknown as HTMLCanvasElement,
    encodeBlob: async () => new Blob([new Uint8Array(2048)], { type: 'image/jpeg' }),
  })
  assert.equal(result.changed, true)
  assert.equal(drawn.length, 1)
  const [w, h] = drawn[0]
  assert.ok(w <= 4096 && h <= 4096, 'expected <=4096, got ' + w + 'x' + h)
})

test('normalizeImage: legal MIME + legal bytes pass through (host normalizes size)', async () => {
  // dsh-attachment-local re-encodes to its own 4MP/4MB policy server-side, so
  // the client must not burn CPU decoding every ordinary camera JPEG. The gate
  // the client DOES have to respect is the host's hard one (64MP / 8192px /
  // 20MB), and that is judged from the header, not the byte count: this file
  // is 5MB but only 12MP, so it sails through untouched.
  const file = fakeFile('photo.jpg', 'image/jpeg', 5 * 1024 * 1024)
  let decoded = false
  const result = await normalizeImage(file, {
    readHead: async () => jpegHead(4000, 3000),
    decode: async () => { decoded = true; return fakeDecoded(4000, 3000) },
  })
  assert.equal(result.changed, false)
  assert.equal(result.reason, 'passthrough')
  assert.equal(decoded, false)
})

test('normalizeImage: an oversized canvas is caught from the header alone', async () => {
  // A 200MP capture can compress under the 20MB byte ceiling and still blow the
  // 64MP pixel ceiling, which the host refuses outright. The header exposes the
  // real size, so the normalizer downscales without ever trusting file.size.
  const file = fakeFile('huge.jpg', 'image/jpeg', 2 * 1024 * 1024)
  const drawn: Array<[number, number]> = []
  const result = await normalizeImage(file, {
    readHead: async () => jpegHead(16000, 12500),
    decode: async () => ({
      ...fakeDecoded(16000, 12500),
      draw: (_ctx: CanvasRenderingContext2D, w: number, h: number) => { drawn.push([w, h]) },
    }),
    createCanvas: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: () => {} }) }) as unknown as HTMLCanvasElement,
    encodeBlob: async () => new Blob([new Uint8Array(1024)], { type: 'image/jpeg' }),
  })
  assert.equal(result.changed, true)
  assert.equal(drawn.length, 1)
  const [w, h] = drawn[0] ?? [0, 0]
  assert.ok(w <= 4096 && h <= 4096, 'expected <=4096, got ' + w + 'x' + h)
})

test('normalizeImage: decode failure degrades to the original file', async () => {
  const file = fakeFile('odd.heic', 'image/heic', 1024)
  const result = await normalizeImage(file, {
    readHead: async () => bytes('000000186674797068656963'),
    decode: async () => { throw new Error('no heic decoder') },
    createCanvas: () => ({}) as unknown as HTMLCanvasElement,
    encodeBlob: async () => null,
  })
  assert.equal(result.changed, false)
  assert.equal(result.reason, 'decode-failed')
  assert.equal(result.file, file)
})
