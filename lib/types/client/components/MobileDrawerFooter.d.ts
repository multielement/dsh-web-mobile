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
 * - Files + Session log sit on the FIRST row (each half-width).
 * - Total tokens spans the SECOND row, with the per-bucket breakdown
 *   (input / output / cache read / cache write / reasoning) rendered under the
 *   lifetime figure. Folded by the host half's `/api/mobile-nav.tokens.total`
 *   endpoint. Refreshes on tap. Loads only while the mobile query matches, so
 *   desktop never pays the corpus scan.
 * Hidden entirely on wide screens (CSS media query).
 */
export declare function MobileDrawerFooter({ useSessions, downloadSessionLog, toggleSidebar, openHostFiles, t }: MobileDrawerFooterProps): import("react").JSX.Element;
//# sourceMappingURL=MobileDrawerFooter.d.ts.map