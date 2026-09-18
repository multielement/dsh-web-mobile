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
export declare const HOST_IMAGE_TYPES: readonly string[];
/** Host admission ceilings this normalizer aims to stay under (see module doc). */
export interface ImageLimits {
    /** Largest accepted encoded byte size. */
    maxBytes: number;
    /** Largest accepted single edge in pixels. */
    maxDimension: number;
    /** Largest accepted width*height. */
    maxPixels: number;
}
/** Conservative defaults mirroring dsh-attachment-local's shipped config. */
export declare const DEFAULT_IMAGE_LIMITS: ImageLimits;
/** Thrown when the browser cannot decode the file at all (caller degrades to passthrough). */
export declare class ImageDecodeError extends Error {
}
/**
 * Container sniff from the leading bytes. Returns nothing for formats we cannot
 * confidently identify, so the caller keeps the browser-declared type.
 * @param head - the first bytes of the file (>= 16 bytes covers every probe).
 * @returns a MIME type when recognised, otherwise null.
 */
export declare function sniffMediaType(head: Uint8Array): string | null;
/** Decoded handle the pipeline draws from (an ImageBitmap in the browser). */
export interface DecodedImage {
    readonly width: number;
    readonly height: number;
    /** Whether the source declares an alpha channel (routes encoding to PNG/WebP). */
    readonly hasAlpha: boolean;
    /** Draw the image into a 2D context at the given size. */
    draw(ctx: CanvasRenderingContext2D, width: number, height: number): void;
    /** Release the underlying resource. */
    close(): void;
}
/** Encodes a canvas to a Blob in the requested type/quality. */
export interface EncodeBlob {
    (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null>;
}
/** Injected browser capabilities; all optional so a missing path degrades cleanly. */
export interface NormalizeDeps {
    /** Decode bytes into a drawable image (createImageBitmap in the browser). */
    decode?: (file: File) => Promise<DecodedImage>;
    /** Read the first N bytes for container sniffing. */
    readHead?: (file: File, count: number) => Promise<Uint8Array>;
    /** Create an offscreen canvas (document.createElement in the browser). */
    createCanvas?: () => HTMLCanvasElement;
    /** Encode a canvas to a blob. */
    encodeBlob?: EncodeBlob;
    /** Admission ceilings to satisfy. */
    limits?: ImageLimits;
}
/** Result of normalizing one picked file. */
export interface NormalizedImage {
    /** The file to hand to the host (possibly re-encoded). */
    file: File;
    /** Whether any transformation happened (false = original passthrough). */
    changed: boolean;
    /** Reason a transformation was skipped; only set when changed is false. */
    reason?: string;
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
export declare function normalizeImage(file: File, deps?: NormalizeDeps): Promise<NormalizedImage>;
//# sourceMappingURL=image-normalize.d.ts.map