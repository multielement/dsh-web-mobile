import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconFolderOpenOutline16, IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from '../i18n/locales.ts'
import { getFrame } from '../effects/phone-chrome.ts'

/** Full props for the session-header directory toggle. */
export interface MobileNavToggleProps extends PropsRuntime<'conversation.session.header.actions'>, PropsLocale<typeof NS> {
  /** Bound ctx.layout.toggleSidebar(). */
  toggleSidebar: () => void
  /**
   * Opens the host's own right-column Files tab (0.1.5+ sidebarRight service).
   * Returns false when the service is absent (old hosts), so the caller can
   * fall back to the dsh-web-ui explorer marker.
   */
  openHostFiles: () => boolean
}

/**
 * Mobile-only icon buttons next to the session title:
 * - toggle: opens the directory drawer on narrow screens.
 * - files: opens the Files surface directly — one tap opens, a second tap
 *   closes it, no drawer round-trip. Prefers the host-native right panel
 *   (0.1.5 sidebarRight service); on older hosts without it, falls back to
 *   the dsh-web-ui explorer sheet marker. (The drawer footer keeps a Files
 *   entry for the hero/blank phases where this header does not exist.)
 * Hidden entirely on wide screens (CSS media query).
 */
export function MobileNavToggle({ toggleSidebar, openHostFiles, t }: MobileNavToggleProps) {
  const toggleExplorer = (): void => {
    if (openHostFiles()) return
    const frame = getFrame()
    if (frame === null) return
    if (frame.hasAttribute('data-aionui-explorer-open')) {
      frame.removeAttribute('data-aionui-explorer-open')
    } else {
      // The preview sheet outranks the explorer in compat.css (two stacked
      // sheets read as one broken overlay): opening the explorer must yield
      // the preview, or the Files action appears dead while preview is up.
      frame.removeAttribute('data-aionui-preview-open')
      frame.setAttribute('data-aionui-explorer-open', '')
    }
  }
  return (
    <>
      <button
        type="button"
        data-mobile-nav="toggle"
        aria-label={t('open')}
        title={t('open')}
        onClick={() => toggleSidebar()}
      >
        <IconPanelLeftOutline16 size={16} />
      </button>
      <button
        type="button"
        data-mobile-nav="files"
        aria-label={t('files')}
        title={t('files')}
        onClick={toggleExplorer}
      >
        <IconFolderOpenOutline16 size={16} />
      </button>
    </>
  )
}
