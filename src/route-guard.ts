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
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Request-body cap in bytes, matching the DSHA hardened build. */
export const MAX_REQUEST_BODY_BYTES = 4096

/** Read-body failure classification. */
export type ReadBodyErrorCode = 'body-too-large' | 'request-aborted' | 'read-error'

/** A classified read-body failure. */
export interface ReadBodyError extends Error {
  code: ReadBodyErrorCode
}

/**
 * Drain a request body as UTF-8 text under a hard size cap. Rejects with a
 * classified error for oversized bodies, aborted requests, and stream
 * errors; once settled, all further events are ignored.
 */
export function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    let bytes = 0
    let settled = false
    const fail = (error: ReadBodyError): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        fail(Object.assign(new Error('request body exceeds the 4KB limit'), { code: 'body-too-large' as const }))
        return
      }
      data += chunk
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(data)
    })
    req.on('error', (error: Error) => fail(Object.assign(error, { code: 'read-error' as const })))
    req.on('aborted', () => fail(Object.assign(new Error('request aborted'), { code: 'request-aborted' as const })))
  })
}

/** Write one JSON response with a fixed content type. */
export function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Auth-denied response, shared by every plugin-owned route. */
export function respondAccessDenied(res: ServerResponse, status: 401 | 403): void {
  respondJson(res, status, { error: { code: 'access-denied', message: '需要当前浏览器鉴权' } })
}

/** Wire contract of the session-delete core (structural, bind-free). */
export type DeleteSessionResult =
  | { ok: true, status: 200, deleted: string }
  | { ok: false, status: number, error: { code: string, message: string } }

export interface DeleteSessionCall {
  (deps: Record<string, unknown>, sessionId: string): Promise<DeleteSessionResult>
}

/** Wire contract of the token-fold core (structural, bind-free). */
export interface TokenTotalResult {
  ok: boolean
  totalTokens: number
  sessions: number
  failed: number
}

export interface AggregateTokenUsageCall {
  (deps: Record<string, unknown>): Promise<TokenTotalResult>
}

/** Injected dependencies for both guarded handlers. */
export interface RouteDeps {
  resolve(service: string): unknown
  rejection?(req: IncomingMessage): 401 | 403 | undefined
  deleteSession?: DeleteSessionCall
  aggregateTokenUsage?: AggregateTokenUsageCall
  logger?: { warn(message: string): void }
}

/** A guarded plugin route handler. */
export interface RouteHandler {
  (req: IncomingMessage, res: ServerResponse): Promise<void>
}

/**
 * Guarded `POST /api/mobile-nav.session.delete`: auth gate → method check →
 * 4KB-capped object body → sessionId validation → core call. The persistence
 * gate is resolved per request so host shapes without the service degrade to
 * a structured 503 instead of a crash.
 */
export function createDeleteHandler(deps: RouteDeps): RouteHandler {
  return async (req, res) => {
    const rejection = deps.rejection?.(req)
    if (rejection !== undefined) {
      respondAccessDenied(res, rejection)
      return
    }
    if (req.method !== 'POST') {
      respondJson(res, 405, { error: { code: 'method-not-allowed', message: 'POST required' } })
      return
    }
    let body: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(await readRequestBody(req))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('request body must be an object')
      }
      body = parsed as Record<string, unknown>
    } catch (error) {
      if ((error as ReadBodyError).code === 'body-too-large') {
        respondJson(res, 413, {
          error: { code: 'body-too-large', message: 'request body exceeds the 4KB limit' },
        })
      } else {
        respondJson(res, 400, {
          error: { code: 'invalid-body', message: 'expected a JSON body of the form { "sessionId": string }' },
        })
      }
      return
    }
    const sessionId = body['sessionId']
    if (typeof sessionId !== 'string' || sessionId === '') {
      respondJson(res, 400, {
        error: { code: 'invalid-session-id', message: 'sessionId must be a non-empty string' },
      })
      return
    }
    const persistence = deps.resolve('sessionPersistence')
    if (persistence === undefined) {
      respondJson(res, 503, {
        error: { code: 'persistence-unavailable', message: 'session persistence is not configured' },
      })
      return
    }
    const core = deps.deleteSession
    if (core === undefined) {
      respondJson(res, 503, {
        error: { code: 'delete-unavailable', message: 'session deletion is not configured' },
      })
      return
    }
    const result = await core({
      persistence,
      sessions: deps.resolve('sessions'),
      agents: deps.resolve('agents'),
      workspaceRegistry: deps.resolve('workspaceRegistry'),
    }, sessionId)
    if (result.ok) {
      respondJson(res, 200, { ok: true, deleted: result.deleted })
      return
    }
    deps.logger?.warn(
      `dsh-web-mobile: session-delete failed for '${sessionId}' (${result.error.code}): ${result.error.message}`,
    )
    respondJson(res, result.status, { error: result.error })
  }
}

/**
 * Guarded `GET /api/mobile-nav.tokens.total`: auth gate → method check →
 * token fold. The session corpus is resolved per request so hosts without
 * the sessionQuery service degrade to a structured 503 instead of a crash.
 */
export function createTokensHandler(deps: RouteDeps): RouteHandler {
  return async (req, res) => {
    const rejection = deps.rejection?.(req)
    if (rejection !== undefined) {
      respondAccessDenied(res, rejection)
      return
    }
    if (req.method !== 'GET') {
      respondJson(res, 405, { error: { code: 'method-not-allowed', message: 'GET required' } })
      return
    }
    const core = deps.aggregateTokenUsage
    const sessionQuery = deps.resolve('sessionQuery')
    if (core === undefined || sessionQuery === undefined) {
      respondJson(res, 503, {
        error: { code: 'session-query-unavailable', message: 'session corpus is not available' },
      })
      return
    }
    const result = await core({ sessionQuery })
    if (result.ok) {
      respondJson(res, 200, {
        ok: true,
        totalTokens: result.totalTokens,
        sessions: result.sessions,
        failed: result.failed,
      })
      return
    }
    respondJson(res, 503, {
      error: { code: 'session-query-unavailable', message: 'session corpus is not available' },
    })
  }
}
