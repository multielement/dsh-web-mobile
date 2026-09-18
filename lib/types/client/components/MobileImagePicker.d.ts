import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { NS } from '../i18n/locales.ts';
/** Full props for the composer image-entry companion (session-standard owner share unused). */
export interface MobileImagePickerProps extends PropsRuntime<'conversation.input.left'>, PropsLocale<typeof NS> {
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
export declare function installImageIntakeBridge(): () => void;
/**
 * Companion for host generations that ship no file input (pre-0.1.5): renders
 * the plugin's own paperclip button, which picks, normalizes, and injects into
 * the host input if one appears later. On 0.1.5+ it renders nothing and only
 * installs the change bridge.
 */
export declare function MobileImagePicker({ t }: MobileImagePickerProps): import("react").JSX.Element | null;
//# sourceMappingURL=MobileImagePicker.d.ts.map