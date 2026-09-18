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
  if (accepted && withinBytes && type === file.type) {
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

    const outType = accepted && best.size === file.size ? type : (best.type === '' ? encodeType : best.type)
    const outFile = new File([best], renameFor(file.name, outType), { type: outType, lastModified: file.lastModified })
    return { file: outFile, changed: true }
  } finally {
    decoded.close()
  }
}
