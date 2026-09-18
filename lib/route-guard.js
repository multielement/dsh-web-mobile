/** Request-body cap in bytes, matching the DSHA hardened build. */
export const MAX_REQUEST_BODY_BYTES = 4096;
/**
 * Drain a request body as UTF-8 text under a hard size cap. Rejects with a
 * classified error for oversized bodies, aborted requests, and stream
 * errors; once settled, all further events are ignored.
 */
export function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        let bytes = 0;
        let settled = false;
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            reject(error);
        };
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            bytes += Buffer.byteLength(chunk, 'utf8');
            if (bytes > MAX_REQUEST_BODY_BYTES) {
                fail(Object.assign(new Error('request body exceeds the 4KB limit'), { code: 'body-too-large' }));
                return;
            }
            data += chunk;
        });
        req.on('end', () => {
            if (settled)
                return;
            settled = true;
            resolve(data);
        });
        req.on('error', (error) => fail(Object.assign(error, { code: 'read-error' })));
        req.on('aborted', () => fail(Object.assign(new Error('request aborted'), { code: 'request-aborted' })));
    });
}
/** Write one JSON response with a fixed content type. */
export function respondJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
}
/** Auth-denied response, shared by every plugin-owned route. */
export function respondAccessDenied(res, status) {
    respondJson(res, status, { error: { code: 'access-denied', message: '需要当前浏览器鉴权' } });
}
/**
 * Guarded `POST /api/mobile-nav.session.delete`: auth gate → method check →
 * 4KB-capped object body → sessionId validation → core call. The persistence
 * gate is resolved per request so host shapes without the service degrade to
 * a structured 503 instead of a crash.
 */
export function createDeleteHandler(deps) {
    return async (req, res) => {
        const rejection = deps.rejection?.(req);
        if (rejection !== undefined) {
            respondAccessDenied(res, rejection);
            return;
        }
        if (req.method !== 'POST') {
            respondJson(res, 405, { error: { code: 'method-not-allowed', message: 'POST required' } });
            return;
        }
        let body;
        try {
            const parsed = JSON.parse(await readRequestBody(req));
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('request body must be an object');
            }
            body = parsed;
        }
        catch (error) {
            if (error.code === 'body-too-large') {
                respondJson(res, 413, {
                    error: { code: 'body-too-large', message: 'request body exceeds the 4KB limit' },
                });
            }
            else {
                respondJson(res, 400, {
                    error: { code: 'invalid-body', message: 'expected a JSON body of the form { "sessionId": string }' },
                });
            }
            return;
        }
        const sessionId = body['sessionId'];
        if (typeof sessionId !== 'string' || sessionId === '') {
            respondJson(res, 400, {
                error: { code: 'invalid-session-id', message: 'sessionId must be a non-empty string' },
            });
            return;
        }
        const persistence = deps.resolve('sessionPersistence');
        if (persistence === undefined) {
            respondJson(res, 503, {
                error: { code: 'persistence-unavailable', message: 'session persistence is not configured' },
            });
            return;
        }
        const core = deps.deleteSession;
        if (core === undefined) {
            respondJson(res, 503, {
                error: { code: 'delete-unavailable', message: 'session deletion is not configured' },
            });
            return;
        }
        const result = await core({
            persistence,
            sessions: deps.resolve('sessions'),
            agents: deps.resolve('agents'),
            workspaceRegistry: deps.resolve('workspaceRegistry'),
        }, sessionId);
        if (result.ok) {
            respondJson(res, 200, { ok: true, deleted: result.deleted });
            return;
        }
        deps.logger?.warn(`dsh-web-mobile: session-delete failed for '${sessionId}' (${result.error.code}): ${result.error.message}`);
        respondJson(res, result.status, { error: result.error });
    };
}
/**
 * Guarded `GET /api/mobile-nav.tokens.total`: auth gate → method check →
 * token fold. The session corpus is resolved per request so hosts without
 * the sessionQuery service degrade to a structured 503 instead of a crash.
 */
export function createTokensHandler(deps) {
    return async (req, res) => {
        const rejection = deps.rejection?.(req);
        if (rejection !== undefined) {
            respondAccessDenied(res, rejection);
            return;
        }
        if (req.method !== 'GET') {
            respondJson(res, 405, { error: { code: 'method-not-allowed', message: 'GET required' } });
            return;
        }
        const core = deps.aggregateTokenUsage;
        const sessionQuery = deps.resolve('sessionQuery');
        if (core === undefined || sessionQuery === undefined) {
            respondJson(res, 503, {
                error: { code: 'session-query-unavailable', message: 'session corpus is not available' },
            });
            return;
        }
        const result = await core({ sessionQuery });
        if (result.ok) {
            respondJson(res, 200, {
                ok: true,
                totalTokens: result.totalTokens,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                cacheReadTokens: result.cacheReadTokens,
                cacheWriteTokens: result.cacheWriteTokens,
                reasoningTokens: result.reasoningTokens,
                sessions: result.sessions,
                failed: result.failed,
            });
            return;
        }
        respondJson(res, 503, {
            error: { code: 'session-query-unavailable', message: 'session corpus is not available' },
        });
    };
}
//# sourceMappingURL=route-guard.js.map