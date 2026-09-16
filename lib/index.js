import { installResponseCompression } from './compress.js';
import { deleteSession } from './delete-session.js';
import { aggregateTokenUsage } from './token-usage.js';
import { createDeleteHandler, createTokensHandler } from './route-guard.js';
export function apply(ctx) {
    // Transparent gzip/brotli for large JSON responses (long-session history
    // is megabytes on a phone). Patches http.ServerResponse.prototype; the
    // disposer restores it on plugin unload/reload.
    ctx.effect(() => installResponseCompression(), 'dsh-web-mobile: response compression');
    // Session-delete route (port of fork wzxmt-zhc v2.7.0). Registers once the
    // web route registry AND the connection auth gate exist; the persistence /
    // session / agent / workspace services are read per request so host shapes
    // without them degrade to a structured 503 instead of a crash.
    ctx.inject(['webServer', 'connection'], (webCtx) => {
        webCtx.effect(() => webCtx.webServer.register({
            kind: 'exact',
            path: '/api/mobile-nav.session.delete',
            handler: createDeleteHandler({
                rejection: (req) => webCtx.connection.requestRejection(req),
                resolve: (service) => ctx.get(service),
                deleteSession: (deps, sessionId) => deleteSession(deps, sessionId),
                logger: ctx.logger,
            }),
        }), 'dsh-web-mobile: session-delete route');
        // Lifetime-token total for the drawer footer pill. The session corpus is
        // read per request so hosts without the sessionQuery service degrade to
        // a structured 503 instead of a crash; the fold itself never throws.
        webCtx.effect(() => webCtx.webServer.register({
            kind: 'exact',
            path: '/api/mobile-nav.tokens.total',
            handler: createTokensHandler({
                rejection: (req) => webCtx.connection.requestRejection(req),
                resolve: (service) => ctx.get(service),
                aggregateTokenUsage: (deps) => aggregateTokenUsage(deps),
            }),
        }), 'dsh-web-mobile: token-total route');
    });
}
//# sourceMappingURL=index.js.map