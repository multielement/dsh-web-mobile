import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { NS } from '../i18n/locales.ts';
/** Full props for the sidebar footer action entry. */
export interface MobileDrawerFooterProps extends PropsRuntime<'sidebar.footer.action'>, PropsLocale<typeof NS> {
    /** Bound ctx.sessionLogDownload.download() for the current session. */
    downloadSessionLog: (sessionId: string) => void;
    /** Bound ctx.layout.toggleSidebar(): the Files sheet closes the drawer. */
    toggleSidebar: () => void;
    /**
     * Opens the host's own right-column Files tab (0.1.5+ sidebarRight service).
     * Returns false when the service is absent (old hosts), so the caller can
     * fall back to the dsh-web-ui explorer marker.
     */
    openHostFiles: () => boolean;
}
/**
 * Mobile-only drawer footer actions, relocated from the session header to the
 * drawer footer (beside Settings):
 * - Total tokens (leftmost): lifetime consumption across ALL sessions of the
 *   corpus, folded by the host half's `/api/mobile-nav.tokens.total` endpoint.
 *   Refreshes on tap. Loads only while the mobile query matches, so desktop
 *   never pays the corpus scan.
 * - Files: opens the Files surface as a floating bottom sheet. Prefers the
 *   host-native right panel (0.1.5 sidebarRight service); on older hosts it
 *   falls back to the dsh-web-ui aionui explorer marker (the explorer column
 *   is hidden on mobile until that marker is set, so the suite's own
 *   persisted-expanded state can never cover the UI on load).
 * - Session log: the official session-log-export controller, so the
 *   progress/result dialog is shared with the desktop flow.
 * Hidden entirely on wide screens (CSS media query).
 */
export declare function MobileDrawerFooter({ useSessions, downloadSessionLog, toggleSidebar, openHostFiles, t }: MobileDrawerFooterProps): import("react").JSX.Element;
//# sourceMappingURL=MobileDrawerFooter.d.ts.map