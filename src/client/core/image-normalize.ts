/**
 * Composer image normalization (browser half).
 *
 * The host only accepts four image MIME types — image/png, image/jpeg,
 * image/webp, image/gif (dsh-attachment-local `imageLimits.mediaTypes`) — and
 * its client gate (`imageMediaType()`) throws UnsupportedImageMediaTypeError
 * for anything else. Phone galleries routinely hand back values outside that
 * set: Android pickers emit `image/jpg` (non-standard), some cloud providers
 * ship an empty MIME, and iPhone/camera roll often produces `image/heic` /
 * `image/heif`. Large camera files also blow the host's 8192px / 64MP / 20MB
 * admission limits (dsh-attachment-local defaults). Any of those turn a
 * perfectly good photo into a rejected attachment, which reads as "the model
 * cannot see images".
 *
 * This module closes that gap on the device: sniff the real container from the
 * leading bytes when the declared type is missing or wrong, decode, downscale
 * past the pixel/dimension ceilings, re-encode into an accepted type, and
 * shrink below the byte ceiling. Everything is injected (no direct browser
 * globals) so the ladder is unit-testable and a decode failure degrades to the
 * original file instead of dropping the attachment.
 */

/** Media types the host admission gate accepts (dsh-attachment-local). */
export const HOST_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Host admission ceilings this normalizer aims to stay under (see module doc). */
export interface ImageLimits {
  /** Largest accepted encoded byte size. */
  maxBytes: number
  /** Largest accepted single edge in pixels. */
  maxDimension: number
  /** Largest accepted width*height. */
  maxPixels: number
}

/** Conservative defaults mirroring dsh-attachment-local's shipped config. */
export const DEFAULT_IMAGE_LIMITS: ImageLimits = Object.freeze({
  maxBytes: 20971520,
  maxDimension: 8192,
  maxPixels: 64000000,
})

/** Thrown when the browser cannot decode the file at all (caller degrades to passthrough). */
export class ImageDecodeError extends Error {}

/**
 * Container sniff from the leading bytes. Returns nothing for formats we cannot
 * confidently identify, so the caller keeps the browser-declared type.
 * @param head - the first bytes of the file (>= 16 bytes covers every probe).
 * @returns a MIME type when recognised, otherwise null.
 */
export function sniffMediaType(head: Uint8Array): string | null {
  const at = (i: number): number => head[i] ?? -1
  // JPEG: FF D8 FF
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  // GIF: "GIF8"
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif'
  // WebP: "RIFF" ???? "WEBP"
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
    && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'image/webp'
  // ISO-BMFF (HEIC/HEIF/AVIF): .... "ftyp" brand
  if (at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) {
    const brand = String.fromCharCode(...[at(8), at(9), at(10), at(11)]).toLowerCase()
    if (brand.startsWith('hei') || brand.startsWith('hev') || brand.startsWith('mif') || brand.startsWith('msf')) return 'image/heic'
    if (brand.startsWith('avi')) return 'image/avif'
  }
  // BMP: "BM"
  if (at(0) === 0x42 && at(1) === 0x4d) return 'image/bmp'
  return null
}

/**
 * Read a PNG / JPEG / WebP pixel size straight out of the header.
 *
 * The host enforces two different size gates and only one of them rejects:
 * `imageLimits` (64MP / 8192px / 20MB) throws, while `normalizationPolicy`
 * (4MP / 8192px / 4MB) is simply what the host re-encodes down to on its own.
 * A byte-count proxy for geometry therefore gets both cases wrong: a 5MB
 * 12MP phone JPEG needs no help at all, while a heavily compressed
 * 200MP capture can sit under 20MB and still be refused outright.
 *
 * Parsing the header is exact and costs one small read, so the caller can
 * decide on real numbers instead of guessing from `file.size`.
 * @param head - leading bytes of the file (4KB is far more than enough).
 * @returns the pixel size, or null when the header is not recognised.
 */
export function sniffImageSize(head: Uint8Array): { width: number, height: number } | null {
  const be16 = (i: number): number => ((head[i] ?? 0) << 8) | (head[i + 1] ?? 0)
  const be32 = (i: number): number =>
    (((head[i] ?? 0) << 24) | ((head[i + 1] ?? 0) << 16) | ((head[i + 2] ?? 0) << 8) | (head[i + 3] ?? 0)) >>> 0
  const le16 = (i: number): number => (head[i] ?? 0) | ((head[i + 1] ?? 0) << 8)

  // PNG: IHDR is always the first chunk — width/height are big-endian at 16..24.
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return { width: be32(16), height: be32(20) }
  }

  // GIF: logical screen descriptor is little-endian at 6..10.
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) {
    return { width: le16(6), height: le16(8) }
  }

  // WebP: RIFF container, three sub-formats.
  if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
    && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) {
    const fourcc = String.fromCharCode(head[12] ?? 0, head[13] ?? 0, head[14] ?? 0, head[15] ?? 0)
    if (fourcc === 'VP8X') {
      // Canvas size minus one, 24-bit little-endian, at 24..30.
      const w = (head[24] ?? 0) | ((head[25] ?? 0) << 8) | ((head[26] ?? 0) << 16)
      const h = (head[27] ?? 0) | ((head[28] ?? 0) << 8) | ((head[29] ?? 0) << 16)
      return { width: w + 1, height: h + 1 }
    }
    if (fourcc === 'VP8 ') {
      // Lossy: 14-bit dimensions follow the 3-byte start code at 26..30.
      const w = ((head[26] ?? 0) | ((head[27] ?? 0) << 8)) & 0x3fff
      const h = ((head[28] ?? 0) | ((head[29] ?? 0) << 8)) & 0x3fff
      return w > 0 && h > 0 ? { width: w, height: h } : null
    }
    if (fourcc === 'VP8L') {
      // Lossless: 14-bit each, packed into a little-endian 32-bit at 21..25.
      const bits = ((head[21] ?? 0) | ((head[22] ?? 0) << 8) | ((head[23] ?? 0) << 16) | ((head[24] ?? 0) << 24)) >>> 0
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return null
  }

  // JPEG: walk the segment chain to the first SOFn frame header. Baseline and
  // progressive both carry height/width at +5/+7 of the frame segment.
  if (head[0] === 0xff && head[1] === 0xd8) {
    let i = 2
    while (i + 9 < head.length) {
      if (head[i] !== 0xff) { i += 1; continue }
      const marker = head[i + 1] ?? 0
      // Standalone markers carry no length payload.
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue }
      const length = be16(i + 2)
      if (length < 2) return null
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 (skip DHT 0xC4, JPG 0xC8, DAC 0xCC).
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) {
        return { height: be16(i + 5), width: be16(i + 7) }
      }
      i += 2 + length
    }
    return null
  }

  return null
}

/** Decoded handle the pipeline draws from (an ImageBitmap in the browser). */
export interface DecodedImage {
  readonly width: number
  readonly height: number
  /** Whether the source declares an alpha channel (routes encoding to PNG/WebP). */
  readonly hasAlpha: boolean
  /** Draw the image into a 2D context at the given size. */
  draw(ctx: CanvasRenderingContext2D, width: number, height: number): void
  /** Release the underlying resource. */
  close(): void
}

/** Encodes a canvas to a Blob in the requested type/quality. */
export interface EncodeBlob {
  (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null>
}

/** Injected browser capabilities; all optional so a missing path degrades cleanly. */
export interface NormalizeDeps {
  /** Decode bytes into a drawable image (createImageBitmap in the browser). */
  decode?: (file: File) => Promise<DecodedImage>
  /** Read the first N bytes for container sniffing. */
  readHead?: (file: File, count: number) => Promise<Uint8Array>
  /** Create an offscreen canvas (document.createElement in the browser). */
  createCanvas?: () => HTMLCanvasElement
  /** Encode a canvas to a blob. */
  encodeBlob?: EncodeBlob
  /** Admission ceilings to satisfy. */
  limits?: ImageLimits
}

/** Result of normalizing one picked file. */
 export interface NormalizedImage {
  /** The file to hand to the host (possibly re-encoded). */
  file: File
  /** Whether any transformation happened (false = original passthrough). */
  changed: boolean
  /** Reason a transformation was skipped; only set when changed is false. */
  reason?: string
}

/** Largest single edge after downscale (also caps the encode work). */
const TARGET_MAX_DIMENSION = 4096
/** Quality ladder walked until the encoded blob fits maxBytes. */
const QUALITY_LADDER = [0.92, 0.85, 0.75, 0.6, 0.45]

/**
 * Byte size assumed safe when the header could not be read at all. Chosen well
 * under the host's 20MB gate, so an unparsable container small enough to sit
 * here is admitted rather than pointlessly re-encoded; anything larger takes
 * the decode path where the real geometry is enforced.
 */
const UNKNOWN_GEOMETRY_BYTES = 4 * 1024 * 1024

/** Extension for a normalized type (host prefers a real name on the wire). */
function extensionFor(type: string): string {
  switch (type) {
    case 'image/png': return 'png'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'jpg'
  }
}

/** Strip any existing extension and append the normalized one. */
function renameFor(name: string, type: string): string {
  const base = name.replace(/\.[^./\\]+$/, '') || 'image'
  return `${base}.${extensionFor(type)}`
}

/** Scale a width/height pair so both edges are within limit (never upscales). */
function fitWithin(width: number, height: number, maxDimension: number, maxPixels: number): { width: number, height: number } {
  let scale = 1
  const longest = Math.max(width, height)
  if (longest > maxDimension) scale = Math.min(scale, maxDimension / longest)
  const pixels = width * height
  if (pixels > maxPixels) scale = Math.min(scale, Math.sqrt(maxPixels / pixels))
  if (scale >= 1) return { width, height }
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/**
 * Normalize one picked image so the host admits it:
 *  1. sniff the true container when the declared MIME is empty or outside the
 *     host set (Android's `image/jpg` maps back to image/jpeg),
 *  2. pass through untouched when the declared type is already accepted and
 *     the file fits every ceiling,
 *  3. otherwise decode, downscale past the dimension/pixel ceilings and
 *     re-encode (PNG/WebP when alpha, JPEG otherwise) down the quality ladder
 *     until the result fits maxBytes.
 * A decode failure returns the original file (the host's own error surface is
 * better than silently dropping the attachment).
 * @param file - the raw file from the picker.
 * @param deps - injected browser capabilities.
 * @returns the file to hand to the host plus whether it was transformed.
 */
export async function normalizeImage(file: File, deps: NormalizeDeps = {}): Promise<NormalizedImage> {
  const limits = deps.limits ?? DEFAULT_IMAGE_LIMITS
  let type = file.type

  // Sniff when the browser gave us nothing useful, or gave a value the host
  // rejects outright. A declared-but-accepted type is trusted (the host's own
  // decoder will surface a mismatch, and re-sniffing every file wastes a read).
  if (deps.readHead !== undefined && (type === '' || type === 'image/jpg' || !HOST_IMAGE_TYPES.includes(type))) {
    try {
      const head = await deps.readHead(file, 16)
      const sniffed = sniffMediaType(head)
      if (sniffed !== null) type = sniffed
      else if (type === 'image/jpg') type = 'image/jpeg'
    } catch {
      // header read failed: fall through with the declared type
    }
  } else if (type === 'image/jpg') {
    type = 'image/jpeg'
  }

  const accepted = HOST_IMAGE_TYPES.includes(type)
  const withinBytes = file.size <= limits.maxBytes

  // The host's hard gate is 64MP / 8192px / 20MB — over that it refuses the
  // attachment outright. Its 4MP / 4MB figures are only the policy it
  // re-encodes down to by itself, so a file inside the gate needs no help even
  // when it is larger than 4MB. Ask the header for the real pixel size instead
  // of guessing from the byte count (a 5MB 12MP JPEG is fine; a 2MB 200MP
  // capture is not). When the header cannot be parsed we fall back to the
  // byte-size heuristic, which is conservative in the safe direction.
  let withinGeometry: boolean
  if (deps.readHead !== undefined) {
    let size: { width: number, height: number } | null = null
    try {
      size = sniffImageSize(await deps.readHead(file, 4096))
    } catch {
      size = null
    }
    withinGeometry = size === null
      ? file.size <= UNKNOWN_GEOMETRY_BYTES
      : size.width <= limits.maxDimension && size.height <= limits.maxDimension
        && size.width * size.height <= limits.maxPixels
  } else {
    withinGeometry = file.size <= UNKNOWN_GEOMETRY_BYTES
  }

  if (accepted && withinBytes && withinGeometry && type === file.type) {
    return { file, changed: false, reason: 'passthrough' }
  }

  // Decode + re-encode. Without a decode path we can still fix the MIME label.
  if (deps.decode === undefined || deps.createCanvas === undefined || deps.encodeBlob === undefined) {
    if (accepted && type !== file.type) {
      return { file: new File([file], renameFor(file.name, type), { type, lastModified: file.lastModified }), changed: true }
    }
    return { file, changed: false, reason: 'no-decoder' }
  }

  let decoded: DecodedImage
  try {
    decoded = await deps.decode(file)
  } catch {
    return { file, changed: false, reason: 'decode-failed' }
  }

  try {
    const fitted = fitWithin(decoded.width, decoded.height, Math.min(limits.maxDimension, TARGET_MAX_DIMENSION), limits.maxPixels)
    // Decoded only to prove the geometry: if it already fits and nothing else
    // needs changing, hand back the original bytes rather than a re-encode
    // (re-encoding costs quality and time for no gain).
    const geometryAlreadyFits = fitted.width === decoded.width && fitted.height === decoded.height
    if (geometryAlreadyFits && accepted && withinBytes && type === file.type) {
      return { file, changed: false, reason: 'geometry-ok' }
    }
    const canvas = deps.createCanvas()
    canvas.width = fitted.width
    canvas.height = fitted.height
    const ctx = canvas.getContext('2d')
    if (ctx === null) return { file, changed: false, reason: 'no-2d-context' }
    decoded.draw(ctx, fitted.width, fitted.height)

    // Alpha sources keep a lossless/alpha-capable codec; photos go JPEG.
    const encodeType = decoded.hasAlpha ? (type === 'image/png' ? 'image/png' : 'image/webp') : 'image/jpeg'
    let best: Blob | null = null
    for (const quality of QUALITY_LADDER) {
      const blob = await deps.encodeBlob(canvas, encodeType, quality)
      if (blob === null) break
      best = blob
      if (blob.size <= limits.maxBytes) break
    }
    if (best === null) return { file, changed: false, reason: 'encode-failed' }

    const outType = best.type === '' ? encodeType : best.type
    const outFile = new File([best], renameFor(file.name, outType), { type: outType, lastModified: file.lastModified })
    return { file: outFile, changed: true }
  } finally {
    decoded.close()
  }
}
