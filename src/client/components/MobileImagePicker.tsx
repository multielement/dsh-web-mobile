import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPaperclipOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from '../i18n/locales.ts'
import { normalizeImage, type DecodedImage, type NormalizeDeps } from '../core/image-normalize.ts'

/** Full props for the composer image-entry companion (session-standard owner share unused). */
export interface MobileImagePickerProps extends PropsRuntime<'conversation.input.left'>, PropsLocale<typeof NS> {}

/**
 * Host 0.1.5 already renders its own paperclip button plus a hidden
 * `<input type="file" multiple>` wired to `intakeFiles`. That button is the
 * "original upload" affordance users see in the round `_add` chip — so this
 * plugin must NOT add a second one. Instead it intercepts that input's `change`
 * in the capture phase, normalizes the picked files into the host's four
 * admitted image types (see core/image-normalize.ts), writes them back, and
 * re-dispatches `change` so the host's own `onPickFiles` runs against the
 * normalized batch. Hosts without such an input fall back to rendering the
 * plugin's own button (the pre-0.1.5 behavior).
 */

/** Marks the throwaway input this component may mount, so host discovery skips it. */
const OWN_INPUT_FLAG = 'mobileOwnInput'
/** Marks a second-pass change so the interceptor does not loop on its own re-dispatch. */
const NORMALIZED_FLAG = 'mobileNormalized'

/** Locate the host composer's own hidden file input (skips ours). */
function findHostFileInput(root: ParentNode = document): HTMLInputElement | null {
  const scope = root.querySelector<HTMLElement>('[data-slot="conversation.input"]')
    ?? root.querySelector<HTMLElement>('[class*="_card"]:has(textarea, [data-composer-input])')
    ?? root
  const inputs = scope.querySelectorAll<HTMLInputElement>('input[type="file"]')
  for (const input of inputs) {
    if (input.dataset[OWN_INPUT_FLAG] === '1') continue
    return input
  }
  return null
}

/** Read the leading bytes of a file for container sniffing. */
async function readHead(file: File, count: number): Promise<Uint8Array> {
  const slice = file.slice(0, count)
  if (typeof slice.arrayBuffer === 'function') return new Uint8Array(await slice.arrayBuffer())
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.readAsArrayBuffer(slice)
  })
}

/** Browser decode via createImageBitmap. */
async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap unavailable')
  const bitmap = await createImageBitmap(file)
  return {
    width: bitmap.width,
    height: bitmap.height,
    hasAlpha: false,
    draw: (ctx, width, height) => { ctx.drawImage(bitmap, 0, 0, width, height) },
    close: () => { bitmap.close() },
  }
}

/** Canvas encode via toBlob. */
function encodeCanvas(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => { canvas.toBlob((blob) => resolve(blob), type, quality) })
}

/** Browser capabilities injected into the normalizer. */
const NORMALIZE_DEPS: NormalizeDeps = {
  readHead,
  decode: decodeImage,
  createCanvas: () => document.createElement('canvas'),
  encodeBlob: encodeCanvas,
}

/** Normalize a batch, each failure degrading to its original file. */
async function normalizeBatch(files: readonly File[]): Promise<File[]> {
  return Promise.all(files.map(async (file) => {
    try {
      const result = await normalizeImage(file, NORMALIZE_DEPS)
      return result.file
    } catch {
      return file
    }
  }))
}

/** Replace the input's files with the normalized batch (resolve-in-place). */
function writeBack(input: HTMLInputElement, files: readonly File[]): boolean {
  try {
    const transfer = new DataTransfer()
    for (const file of files) transfer.items.add(file)
    input.files = transfer.files
    return true
  } catch {
    return false
  }
}

/**
 * Capture-phase `change` interceptor for the host's own file input.
 *
 * Capture runs before React's root-delegated listener, so stopping propagation
 * here holds the host's `onPickFiles` back until the normalized batch is in
 * place; the re-dispatched change carries NORMALIZED_FLAG and passes straight
 * through. Every guard is defensive — any failure leaves the original pick
 * untouched rather than blocking the host's own pipeline.
 */
export function installImageIntakeBridge(): () => void {
  const onChange = (event: Event): void => {
    const target = event.target
    if (!(target instanceof HTMLInputElement)) return
    if (target.type !== 'file' || target.dataset[OWN_INPUT_FLAG] === '1') return
    const picked = target.files
    if (picked === null || picked.length === 0) return

    // Second pass (our own re-dispatch): let it through untouched.
    if (target.dataset[NORMALIZED_FLAG] === '1') {
      delete target.dataset[NORMALIZED_FLAG]
      return
    }

    // Hold the host's listener back while we rewrite the files.
    event.stopPropagation()
    event.stopImmediatePropagation()

    void (async () => {
      try {
        const normalized = await normalizeBatch(Array.from(picked))
        if (writeBack(target, normalized)) {
          target.dataset[NORMALIZED_FLAG] = '1'
          target.dispatchEvent(new Event('change', { bubbles: true }))
        }
      } catch {
        // Rewriting failed: release the original pick so the host still runs.
        target.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })()
  }

  document.addEventListener('change', onChange, true)
  return () => { document.removeEventListener('change', onChange, true) }
}

/**
 * Companion for host generations that ship no file input (pre-0.1.5): renders
 * the plugin's own paperclip button, which picks, normalizes, and injects into
 * the host input if one appears later. On 0.1.5+ it renders nothing and only
 * installs the change bridge.
 */
export function MobileImagePicker({ t }: MobileImagePickerProps) {
  const [needsOwnButton, setNeedsOwnButton] = useState(false)

  useEffect(() => installImageIntakeBridge(), [])

  useEffect(() => {
    // The host input may mount after this slot renders, so probe on the next
    // frame and keep watching briefly; only a host that never produces one
    // (pre-0.1.5) earns the fallback button. Stops as soon as one is found.
    let raf = 0
    let tries = 0
    const probe = (): void => {
      if (findHostFileInput() !== null) {
        setNeedsOwnButton(false)
        return
      }
      if (tries >= 20) {
        setNeedsOwnButton(true)
        return
      }
      tries += 1
      raf = window.setTimeout(probe, 250)
    }
    probe()
    return () => { window.clearTimeout(raf) }
  }, [])

  const pickImages = async (): Promise<void> => {
    const picked = await new Promise<File[]>((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.multiple = true
      input.dataset[OWN_INPUT_FLAG] = '1'
      input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0'
      document.body.appendChild(input)
      const cleanup = (): void => { input.remove() }
      input.addEventListener('change', () => {
        const files = Array.from(input.files ?? [])
        cleanup()
        resolve(files)
      }, { once: true })
      input.addEventListener('cancel', () => { cleanup(); resolve([]) }, { once: true })
      input.click()
    })
    if (picked.length === 0) return

    const normalized = await normalizeBatch(picked)
    const hostInput = findHostFileInput()
    if (hostInput !== null && writeBack(hostInput, normalized)) {
      hostInput.dataset[NORMALIZED_FLAG] = '1'
      hostInput.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }

  if (!needsOwnButton) return null

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
