import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { NS } from '../i18n/locales.ts';
/** Full props for the session-header directory toggle. */
export interface MobileNavToggleProps extends PropsRuntime<'conversation.session.header.actions'>, PropsLocale<typeof NS> {
    /** Bound ctx.layout.toggleSidebar(). */
    toggleSidebar: () => void;
    /**
     * Opens the host's own right-column Files tab (0.1.5+ sidebarRight service).
     * Returns false when the service is absent (old hosts), so the caller can
     * fall back to the dsh-web-ui explorer marker.
     */
    openHostFiles: () => boolean;
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
export declare function MobileNavToggle({ toggleSidebar, openHostFiles, t }: MobileNavToggleProps): import("react").JSX.Element;
//# sourceMappingURL=MobileNavToggle.d.ts.map