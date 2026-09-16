/**
 * dsh-web-mobile, host half: request-level route guards and the guarded
 * route handlers.
 *
 * Security parity with the DSHA vendored build lineage: every plugin-owned
 * HTTP route bypasses the upstream /api prefix chain and its guards, so each
 * handler runs the host connection auth gate (requestRejection) first and
 * the request body is size-capped before parsing. The cap and the
 * read/settle semantics mirror the DSHA hardened build (4KB, aborted and
 * error rejection), with a settle guard closing the double-settlement window
 * the vendored version leaves open.
 *
 * The module is self-contained by design: every dependency is injected, so
 * the whole handler logic is unit-testable under node --test (the index.ts
 * glue layer binds the real deleteSession / aggregateTokenUsage cores and
 * the cordis service lookups).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** Request-body cap in bytes, matching the DSHA hardened build. */
export declare const MAX_REQUEST_BODY_BYTES = 4096;
/** Read-body failure classification. */
export type ReadBodyErrorCode = 'body-too-large' | 'request-aborted' | 'read-error';
/** A classified read-body failure. */
export interface ReadBodyError extends Error {
    code: ReadBodyErrorCode;
}
/**
 * Drain a request body as UTF-8 text under a hard size cap. Rejects with a
 * classified error for oversized bodies, aborted requests, and stream
 * errors; once settled, all further events are ignored.
 */
export declare function readRequestBody(req: IncomingMessage): Promise<string>;
/** Write one JSON response with a fixed content type. */
export declare function respondJson(res: ServerResponse, status: number, body: unknown): void;
/** Auth-denied response, shared by every plugin-owned route. */
export declare function respondAccessDenied(res: ServerResponse, status: 401 | 403): void;
/** Wire contract of the session-delete core (structural, bind-free). */
export type DeleteSessionResult = {
    ok: true;
    status: 200;
    deleted: string;
} | {
    ok: false;
    status: number;
    error: {
        code: string;
        message: string;
    };
};
export interface DeleteSessionCall {
    (deps: Record<string, unknown>, sessionId: string): Promise<DeleteSessionResult>;
}
/** Wire contract of the token-fold core (structural, bind-free). */
export interface TokenTotalResult {
    ok: boolean;
    totalTokens: number;
    sessions: number;
    failed: number;
}
export interface AggregateTokenUsageCall {
    (deps: Record<string, unknown>): Promise<TokenTotalResult>;
}
/** Injected dependencies for both guarded handlers. */
export interface RouteDeps {
    resolve(service: string): unknown;
    rejection?(req: IncomingMessage): 401 | 403 | undefined;
    deleteSession?: DeleteSessionCall;
    aggregateTokenUsage?: AggregateTokenUsageCall;
    logger?: {
        warn(message: string): void;
    };
}
/** A guarded plugin route handler. */
export interface RouteHandler {
    (req: IncomingMessage, res: ServerResponse): Promise<void>;
}
/**
 * Guarded `POST /api/mobile-nav.session.delete`: auth gate → method check →
 * 4KB-capped object body → sessionId validation → core call. The persistence
 * gate is resolved per request so host shapes without the service degrade to
 * a structured 503 instead of a crash.
 */
export declare function createDeleteHandler(deps: RouteDeps): RouteHandler;
/**
 * Guarded `GET /api/mobile-nav.tokens.total`: auth gate → method check →
 * token fold. The session corpus is resolved per request so hosts without
 * the sessionQuery service degrade to a structured 503 instead of a crash.
 */
export declare function createTokensHandler(deps: RouteDeps): RouteHandler;
//# sourceMappingURL=route-guard.d.ts.map