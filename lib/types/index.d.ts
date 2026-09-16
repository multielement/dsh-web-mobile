/**
 * dsh-web-mobile, node half. Mostly a client UI plugin: apply() exists so the
 * plugin appears in the host Loader. It installs transparent gzip/brotli
 * compression for large JSON responses (long-session history is megabytes on
 * a phone; patches http.ServerResponse.prototype, disposer restores it), and
 * — ported from community-fork wzxmt-zhc v2.7.0 — the ONE host capability the
 * mobile drawer needs that the harness does not provide: deleting a session
 * (the host session menu only knows rename / fork / archive; archive only
 * hides a row). A second read-only endpoint feeds the drawer footer's
 * lifetime-token pill (folded by `src/token-usage.ts`).
 *
 * Both plugin-owned routes bypass the upstream /api prefix chain and its
 * guards, so each handler runs the host browser auth gate
 * (`connection.requestRejection`) before anything else and caps the request
 * body at 4KB — security parity with the DSHA vendored build. The handler
 * logic (auth gate, method checks, body cap/validation, service-lookup
 * degrade to structured 503s) lives in the self-contained DI module
 * `route-guard.ts` and is unit-tested; this file only binds the real cores
 * and cordis service lookups.
 *
 * The browser half ships via exports["./client"], discovered through the
 * package.json dsh.client declaration. Host packages are intentionally NOT
 * type-imported: this repo's node_modules only carries the client-side
 * @deepseek-ai packages, so all host faces are declared structurally below.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** Minimal structural slice of the host cordis Context that apply() needs. */
export interface HostContext {
    /** Register one disposable installer; its return value disposes on unload. */
    effect(install: () => unknown, label?: string): unknown;
    /** Read one optional service by name (undefined when the host omits it). */
    get(service: string): unknown;
    /** Run apply once the named services exist (cordis fiber inject). */
    inject(services: readonly string[], apply: (scoped: ScopedContext) => void): void;
    /** Host logger service face (warn-level is all this plugin uses). */
    logger: {
        warn(message: string): void;
    };
}
/** Context shape inside the `webServer` + `connection` inject scope. */
export interface ScopedContext extends HostContext {
    webServer: {
        register(route: {
            kind: 'exact';
            path: string;
            handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
        }): unknown;
    };
    /** Host browser auth gate: rejects requests not from the app's browser. */
    connection: {
        requestRejection(request: {
            readonly headers: IncomingMessage['headers'];
        }): 401 | 403 | undefined;
    };
}
export declare function apply(ctx: HostContext): void;
//# sourceMappingURL=index.d.ts.map