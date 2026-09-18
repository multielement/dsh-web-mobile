import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPaperclipOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from '../i18n/locales.ts'
import { canStageImageDrop, stageImagesAsDrop } from '../core/image-intake.ts'
import { normalizeImage, type DecodedImage, type NormalizeDeps } from '../core/image-normalize.ts'

/** Full props for the composer image-upload entry (session-standard owner share unused). */
export interface MobileImagePickerProps extends PropsRuntime<'conversation.input.left'>, PropsLocale<typeof NS> {}

/** Engine capability probe, evaluated once at load (client-only module). */
const INTAKE_SUPPORTED = canStageImageDrop({
  hasDataTransfer: typeof DataTransfer !== 'undefined',
  hasDragEventConstructor: typeof DragEvent !== 'undefined',
  hasLegacyDragEvent: typeof document !== 'undefined' && typeof document.createEvent === 'function',
})

/** Marks the throwaway input this component mounts, so host-input discovery never picks it. */
const OWN_INPUT_FLAG = 'mobileOwnInput'

/** Primary drop-event path: the DragEvent constructor carrying the transfer. */
function makeDragEvent(type: string, init: { bubbles: boolean, cancelable: boolean, dataTransfer: DataTransfer }): Event | null {
  try {
    return new DragEvent(type, init)
  } catch {
    return null
  }
}

/** Legacy initDragEvent surface (removed from lib.dom's DragEvent typing). */
interface LegacyDragEvent extends Event {
  initDragEvent(type: string, canBubble: boolean, cancelable: boolean, view: Window | null, detail: number, screenX: number, screenY: number, clientX: number, clientY: number, ctrlKey: boolean, altKey: boolean, shiftKey: boolean, metaKey: boolean, button: number, relatedTarget: EventTarget | null, dataTransfer: DataTransfer | null): void
}

/** Legacy drop-event path: createEvent + initDragEvent for engines without the constructor. */
function makeLegacyDropEvent(transfer: DataTransfer): Event | null {
  try {
    const event = document.createEvent('DragEvent') as unknown as LegacyDragEvent
    event.initDragEvent('drop', true, true, window, 0, 0, 0, 0, 0, false, false, false, false, 0, null, transfer)
    return event
  } catch {
    return null
  }
}

/** DataTransfer carrier for the synthetic drop. */
function makeDataTransfer(): DataTransfer | null {
  try {
    return new DataTransfer()
  } catch {
    return null
  }
}

/**
 * Locate the host composer's own hidden `<input type="file">` (0.1.5 InputBar
 * ships one with `multiple`, wired to `onPickFiles` -> `intakeFiles`). Driving
 * it directly runs the host's native pick + upload pipeline with zero synthetic
 * events, which is the only path that survives across host generations. The
 * throwaway input this component mounts carries OWN_INPUT_FLAG and is skipped.
 */
function findHostFileInput(): HTMLInputElement | null {
  const scope = document.querySelector<HTMLElement>('[data-slot="conversation.input"]')
    ?? document.querySelector<HTMLElement>('[class*="_card"]:has(textarea, [data-composer-input])')
    ?? document
  const inputs = scope.querySelectorAll<HTMLInputElement>('input[type="file"]')
  for (const input of inputs) {
    if (input.dataset[OWN_INPUT_FLAG] === '1') continue
    return input
  }
  return null
}

/**
 * Hand the prepared files to the host's own file input: write a DataTransfer
 * into its `files` slot and fire `change`, so the host's `onPickFiles` runs
 * against our normalized files exactly as if the user had picked them. This is
 * what makes HEIC / `image/jpg` / oversized photos survive the host's
 * four-type admission gate (see core/image-normalize.ts).
 * @param input - the host composer's file input.
 * @param files - normalized files to inject.
 * @returns true when the transfer landed (availability permitting).
 */
function feedHostInput(input: HTMLInputElement, files: readonly File[]): boolean {
  try {
    const transfer = new DataTransfer()
    for (const file of files) transfer.items.add(file)
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  } catch {
    return false
  }
}

/** Read the leading bytes of a file for container sniffing. */
async function readHead(file: File, count: number): Promise<Uint8Array> {
  const slice = file.slice(0, count)
  if (typeof slice.arrayBuffer === 'function') return new Uint8Array(await slice.arrayBuffer())
  // Very old engines: FileReader is the only reader available.
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.readAsArrayBuffer(slice)
  })
}

/** Browser decode via createImageBitmap (WebView support is broad on Android). */
async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap unavailable')
  const bitmap = await createImageBitmap(file)
  return {
    width: bitmap.width,
    height: bitmap.height,
    // ImageBitmap does not expose an alpha flag; treat as opaque so photos take
    // the JPEG path (the overwhelmingly common case for camera/gallery picks).
    hasAlpha: false,
    draw: (ctx, width, height) => { ctx.drawImage(bitmap, 0, 0, width, height) },
    close: () => { bitmap.close() },
  }
}

/** Canvas encode via toBlob (resolves null when the codec is unsupported). */
function encodeCanvas(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality)
  })
}

/** Browser capabilities injected into the normalizer (kept out of core for testability). */
const NORMALIZE_DEPS: NormalizeDeps = {
  readHead,
  decode: decodeImage,
  createCanvas: () => document.createElement('canvas'),
  encodeBlob: encodeCanvas,
}

/**
 * Mobile-only paperclip button in the composer's left tool lane
 * (`conversation.input.left`).
 *
 * Flow: mount our own picker (accept=image/*, so the gallery can hand back any
 * format), normalize every pick into a host-accepted image (sniff MIME,
 * downscale past the 8192px/64MP ceilings, re-encode below 20MB), then either
 * inject the results into the host's own hidden file input (preferred: the
 * host runs its native thumbnail/upload/vision pipeline) or fall back to a
 * synthetic document drop for host generations without that input.
 * Hidden on wide screens by misc.css.ts (desktop complement block).
 */
export function MobileImagePicker({ t }: MobileImagePickerProps) {
  if (!INTAKE_SUPPORTED) return null

  const pickImages = async (): Promise<void> => {
    const picked = await new Promise<File[]>((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      // Accept every image the picker can surface; normalization decides support.
      input.accept = 'image/*'
      input.multiple = true
      // Mount off-screen instead of display:none: some iOS WebKit versions
      // refuse to open the picker for an unrendered file input.
      input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0'
      document.body.appendChild(input)
      const cleanup = (): void => { input.remove() }
      input.addEventListener('change', () => {
        const files = Array.from(input.files ?? [])
        cleanup()
        resolve(files)
      }, { once: true })
      // `cancel` fires when the user dismisses the picker without choosing;
      // reclaim the orphan either way (a connected node is never collected).
      input.addEventListener('cancel', () => {
        cleanup()
        resolve([])
      }, { once: true })
      input.click()
    })
    if (picked.length === 0) return

    // Normalize concurrently; each failure degrades to its original file so a
    // single odd format never drops the whole batch.
    const normalized = await Promise.all(picked.map(async (file) => {
      try {
        const result = await normalizeImage(file, NORMALIZE_DEPS)
        return result.file
      } catch {
        return file
      }
    }))

    const hostInput = findHostFileInput()
    if (hostInput !== null && feedHostInput(hostInput, normalized)) return

    // Fallback for host generations without a file input: stage as one drop.
    const staged = stageImagesAsDrop(normalized, { makeDataTransfer, makeDragEvent, makeLegacyDropEvent })
    if (staged !== null) document.dispatchEvent(staged.event)
  }

  return (
    <button
      type="button"
      data-mobile-nav="image-picker"
      aria-label={t('uploadImage')}
      title={t('uploadImage')}
      onClick={() => { void pickImages() }}
    >
      <IconPaperclipOutline16 size={14} />
    </button>
  )
}
