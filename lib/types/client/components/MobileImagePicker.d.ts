import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { NS } from '../i18n/locales.ts';
/** Full props for the composer image-upload entry (session-standard owner share unused). */
export interface MobileImagePickerProps extends PropsRuntime<'conversation.input.left'>, PropsLocale<typeof NS> {
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
export declare function MobileImagePicker({ t }: MobileImagePickerProps): import("react").JSX.Element | null;
//# sourceMappingURL=MobileImagePicker.d.ts.map